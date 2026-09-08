import { Ollama, type Message } from "ollama/browser";
import { z } from "zod";
import { AppError, normalizeError, type Issue } from "./errors";
import { extractJavaCode, validateSolution } from "./java";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompts";
import type { SolveProgress, SolveRequest, SolveSuccess, SolveUsage } from "./schema";

export const DEFAULT_MODEL = "gpt-oss:120b";
export const SOLVE_TIMEOUT_MS = 120_000;
const MAX_PROVIDER_BYTES = 1024 * 1024;
const MAX_CODE_LENGTH = 100_000;
const MIN_REPAIR_TIME_MS = 15_000;

export type OllamaEnv = { OLLAMA_API_KEY: string; OLLAMA_MODEL?: string };
export type SolveOptions = {
  signal?: AbortSignal;
  onProgress?: (stage: SolveProgress) => void;
  // Dependency injection for tests; production always uses the hosted Ollama API.
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const responseSchema = z.object({
  model: z.string().optional(),
  message: z.object({ content: z.string() }),
  done: z.boolean(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().finite().nonnegative().optional(),
  eval_count: z.number().finite().nonnegative().optional()
});

export function requireOllama(env: OllamaEnv) {
  if (!env.OLLAMA_API_KEY?.trim()) throw new AppError("NOT_CONFIGURED");
}

function boundedFetch(transport: typeof fetch, signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    let response: Response;
    try {
      response = await transport(input, { ...init, signal });
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new AppError("PROVIDER_UNAVAILABLE");
    }
    if (!response.body) return response;
    // The SDK still owns JSON parsing. Bound bytes before it buffers the body.
    let bytes = 0;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          const { done, value } = await reader.read();
          if (done) { reader.releaseLock(); output.close(); return; }
          bytes += value.byteLength;
          if (bytes > MAX_PROVIDER_BYTES) throw new AppError("INVALID_MODEL_RESPONSE");
          output.enqueue(value);
        } catch (error) {
          const failure = signal.aborted ? signal.reason : error instanceof AppError ? error : new AppError("PROVIDER_UNAVAILABLE");
          output.error(failure);
          await reader.cancel().catch(() => {});
        }
      },
      async cancel(reason) { await reader.cancel(reason).catch(() => {}); }
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export async function solveWithOllama(input: SolveRequest, env: OllamaEnv, options: SolveOptions = {}): Promise<SolveSuccess> {
  requireOllama(env);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? SOLVE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const timeout = setTimeout(() => controller.abort(new AppError("PROVIDER_TIMEOUT")), timeoutMs);
  const cancel = () => controller.abort(new AppError("CANCELLED"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const model = env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL;
  const client = new Ollama({
    host: "https://ollama.com",
    headers: { Authorization: `Bearer ${env.OLLAMA_API_KEY.trim()}` },
    fetch: boundedFetch(options.fetch ?? fetch, controller.signal)
  });
  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(input) }
  ];
  const usage: SolveUsage = {};
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      controller.signal.throwIfAborted();
      options.onProgress?.(attempt === 0 ? "solving" : "repairing");
      const raw = await client.chat({
        model, messages, stream: false,
        // GPT-OSS ignores booleans; it needs an effort level.
        think: /gpt-oss/i.test(model) ? (attempt === 0 ? "medium" : "low") : true,
        options: { temperature: 0.1, num_predict: 8192 }
      });
      controller.signal.throwIfAborted();
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success) throw new AppError("INVALID_MODEL_RESPONSE");
      const body = parsed.data;
      if (body.prompt_eval_count !== undefined) usage.input = (usage.input ?? 0) + body.prompt_eval_count;
      if (body.eval_count !== undefined) usage.output = (usage.output ?? 0) + body.eval_count;
      const text = body.message.content;
      let errors: Issue[];
      let code = "";
      let warnings: Issue[] = [];
      if (!body.done || /^(?:length|max_tokens|limit)$/i.test(body.done_reason ?? "") || !text.trim()) {
        errors = [{ code: "INCOMPLETE_ANSWER", message: "Return a complete, concise Java solution in the final answer." }];
      } else if (text.length > MAX_CODE_LENGTH) {
        throw new AppError("INVALID_MODEL_RESPONSE");
      } else {
        options.onProgress?.("validating");
        try {
          code = extractJavaCode(text);
          ({ errors, warnings } = validateSolution(code, input));
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "INVALID_SOLUTION") throw error;
          errors = error.issues ?? [];
        }
      }
      if (!errors.length) {
        return {
          ok: true, code, model: body.model || model,
          ...(Object.keys(usage).length ? { usage } : {}),
          ...(warnings.length ? { warnings } : {})
        };
      }
      const failureCode = errors[0].code === "INCOMPLETE_ANSWER" ? "INVALID_MODEL_RESPONSE" : "INVALID_SOLUTION";
      if (attempt === 1 || deadline - Date.now() < MIN_REPAIR_TIME_MS) throw new AppError(failureCode, errors);
      // One bounded repair, with actionable issues. Never send thinking back as an answer.
      if (text.trim()) messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: `Repair the answer. ${errors.map((issue) => issue.message).join(" ")} Return only one complete Java source file in a Java code fence.` });
    }
    throw new AppError("INVALID_MODEL_RESPONSE");
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof SyntaxError) throw new AppError("INVALID_MODEL_RESPONSE");
    throw normalizeError(error);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
}
