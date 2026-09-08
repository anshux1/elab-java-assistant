"use strict";

const REQUEST_TIMEOUT_MS = 135_000;
const IDLE_TIMEOUT_MS = 25_000;
const MAX_PAYLOAD_BYTES = 50 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CODE_LENGTH = 100_000;
const PROGRESS_STAGES = new Set(["solving", "repairing", "validating"]);

class ClientError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function badResponse(message = "The solver returned an invalid response.") {
  return new ClientError("BAD_RESPONSE", message);
}

function serverResult(body) {
  if (body?.ok === false) {
    const error = body.error;
    // Also read errors from the previously deployed JSON-only server.
    if (typeof error === "string") return { ok: false, error: { code: "MODEL_FAILED", message: error, retryable: true } };
    if (error && typeof error.code === "string" && typeof error.message === "string") {
      return { ok: false, error: {
        code: error.code, message: error.message, retryable: error.retryable === true,
        ...(typeof error.requestId === "string" ? { requestId: error.requestId } : {}),
        ...(Array.isArray(error.issues) ? { issues: error.issues.filter((issue) => typeof issue?.message === "string").slice(0, 10) } : {})
      } };
    }
    throw badResponse();
  }
  if (body?.ok !== true || typeof body.code !== "string" || !body.code.trim() || body.code.length > MAX_CODE_LENGTH) {
    throw badResponse("The solver did not return a complete solution within the size limit.");
  }
  return {
    ok: true, code: body.code,
    model: typeof body.model === "string" ? body.model : "Ollama Cloud",
    warnings: Array.isArray(body.warnings) ? body.warnings.filter((issue) => typeof issue?.code === "string" && typeof issue.message === "string").slice(0, 20) : []
  };
}

async function readResponse(response, onProgress, activity) {
  if (!response.body) throw badResponse();
  const streamed = response.headers.get("content-type")?.includes("application/x-ndjson");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bytes = 0;
  const readEvent = (line) => {
    let event;
    try { event = JSON.parse(line); } catch { throw badResponse("The solver returned invalid JSON."); }
    if (event?.type === "progress" && PROGRESS_STAGES.has(event.stage)) {
      onProgress(event.stage);
      return null;
    }
    if (event?.type === "result" && event.ok === true && response.ok) return serverResult(event);
    if (event?.type === "error" && event.ok === false) return serverResult(event);
    throw badResponse();
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      activity();
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw badResponse("The solver response exceeded the size limit.");
      buffer += decoder.decode(value, { stream: true });
      if (streamed) {
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const result = readEvent(line);
          if (result) return result;
        }
      }
    }
    if (streamed) {
      if (buffer.trim()) {
        const result = readEvent(buffer.trim());
        if (result) return result;
      }
      throw badResponse("The connection ended before the complete solution arrived. Try again.");
    }
    let body;
    try { body = JSON.parse(buffer); } catch { throw badResponse("The solver returned invalid JSON."); }
    if (!response.ok && body?.ok !== false) throw badResponse(`The solver request failed (HTTP ${response.status}).`);
    return serverResult(body);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function solve(endpoint, payload, { signal, onProgress = () => {}, transport = fetch } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new ClientError("CANCELLED", "The solve request was cancelled."));
  const timeout = setTimeout(() => controller.abort(new ClientError("TIMEOUT", "Ollama took too long to solve this problem.")), REQUEST_TIMEOUT_MS);
  let idleTimeout;
  const activity = () => {
    clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => controller.abort(new ClientError("TIMEOUT", "The solver stopped responding. Try again.")), IDLE_TIMEOUT_MS);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const body = JSON.stringify(payload);
    if (!body || new TextEncoder().encode(body).byteLength > MAX_PAYLOAD_BYTES) {
      throw new ClientError("BAD_PAYLOAD", "The problem data is incomplete or too large.");
    }
    controller.signal.throwIfAborted();
    activity();
    const response = await transport(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body, signal: controller.signal
    });
    activity();
    return await readResponse(response, onProgress, activity);
  } catch (error) {
    const cause = controller.signal.aborted ? controller.signal.reason : error;
    return { ok: false, error: {
      code: cause instanceof ClientError ? cause.code : "NETWORK_ERROR",
      message: cause instanceof ClientError ? cause.message : "Could not read the solver response. Check your connection and try again.",
      retryable: true
    } };
  } finally {
    clearTimeout(timeout);
    clearTimeout(idleTimeout);
    signal?.removeEventListener("abort", cancel);
  }
}
