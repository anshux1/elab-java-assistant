import { Hono } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";
import { AppError, failure, logFailure, normalizeError } from "./errors";
import { DEFAULT_MODEL, requireOllama, solveWithOllama, type OllamaEnv } from "./ollama";
import { solveRequestSchema, type SolveProgress, type SolveSuccess } from "./schema";

type Bindings = OllamaEnv & { ALLOWED_ORIGIN?: string; MAX_SOLVES_PER_HOUR?: string };
type Variables = { requestId: string; startedAt: number };
type CachedSolution = { expiresAt: number; value: SolveSuccess };
type RateWindow = { count: number; resetAt: number };
const MAX_BODY_BYTES = 50 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_VERSION = "sdk-java-v1";
const MAX_CACHE_ENTRIES = 64;
const MAX_RATE_ENTRIES = 2048;
const HEARTBEAT_MS = 10_000;

type Dependencies = { solve?: typeof solveWithOllama; heartbeatMs?: number };

async function readJson(request: Request): Promise<unknown> {
  // Bound actual bytes even when a caller supplies an incorrect Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("INVALID_INPUT");
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new AppError("PAYLOAD_TOO_LARGE");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try { return JSON.parse(text); }
  catch { throw new AppError("INVALID_INPUT", [{ code: "INVALID_JSON", message: "Request body must be valid JSON." }]); }
}

export function createApp(dependencies: Dependencies = {}) {
  const solve = dependencies.solve ?? solveWithOllama;
  // Best-effort, bounded, per-isolate conveniences, not persistent storage.
  const cache = new Map<string, CachedSolution>();
  const rateWindows = new Map<string, RateWindow>();
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.set("startedAt", Date.now());
    c.header("X-Request-ID", c.get("requestId"));
    await next();
  });
  app.use("*", async (c, next) => cors({
    origin: c.env.ALLOWED_ORIGIN?.trim() || "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Accept"],
    exposeHeaders: ["X-Request-ID", "Retry-After"], maxAge: 86_400
  })(c, next));
  app.onError((error, c) => {
    const normalized = normalizeError(error);
    logFailure(normalized, c.get("requestId"), c.get("startedAt"));
    if (normalized.retryAfter) c.header("Retry-After", String(normalized.retryAfter));
    return c.json(failure(normalized, c.get("requestId")), normalized.status);
  });
  app.notFound(() => { throw new AppError("NOT_FOUND"); });
  app.get("/health", (c) => c.json({ ok: true, provider: "ollama", model: c.env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL }));
  app.post("/solve", async (c) => {
    const json = await readJson(c.req.raw);
    const parsed = solveRequestSchema.safeParse(json);
    if (!parsed.success) throw new AppError("INVALID_INPUT", parsed.error.issues.slice(0, 10).map((issue) => ({ code: "INVALID_FIELD", message: `${issue.path.join(".")}: ${issue.message}` })));
    requireOllama(c.env);
    const now = Date.now();
    for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
    for (const [key, entry] of rateWindows) if (entry.resetAt <= now) rateWindows.delete(key);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([CACHE_VERSION, c.env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL, parsed.data])));
    const cacheKey = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const cached = cache.get(cacheKey);
    if (cached) return c.json({ ...cached.value, cached: true });
    const configured = Number(c.env.MAX_SOLVES_PER_HOUR);
    const limit = Number.isInteger(configured) && configured > 0 ? configured : 60;
    const clientKey = c.req.header("cf-connecting-ip") || "unknown";
    const rate = rateWindows.get(clientKey);
    if (rate && rate.count >= limit) throw new AppError("RATE_LIMITED", undefined, Math.max(1, Math.ceil((rate.resetAt - now) / 1000)));
    if (rate) rate.count++;
    else {
      if (rateWindows.size >= MAX_RATE_ENTRIES) rateWindows.delete(rateWindows.keys().next().value!);
      rateWindows.set(clientKey, { count: 1, resetAt: now + CACHE_TTL_MS });
    }
    const save = (result: SolveSuccess) => {
      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    };
    // Keep JSON compatibility for scripts and the previously installed extension.
    if (!c.req.header("accept")?.includes("application/x-ndjson")) {
      return c.json(save(await solve(parsed.data, c.env, { signal: c.req.raw.signal })));
    }
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    c.header("Cache-Control", "no-store, no-transform");
    c.header("Content-Encoding", "Identity");
    c.header("X-Content-Type-Options", "nosniff");
    return stream(c, async (output) => {
      const controller = new AbortController();
      const cancel = () => controller.abort(new AppError("CANCELLED"));
      output.onAbort(cancel);
      c.req.raw.signal.addEventListener("abort", cancel, { once: true });
      if (c.req.raw.signal.aborted) cancel();
      let stage: SolveProgress = "solving";
      let writing = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const progress = async () => {
        if (writing || controller.signal.aborted) return;
        writing = true;
        try { await output.writeln(JSON.stringify({ type: "progress", stage })); }
        finally { writing = false; }
      };
      try {
        // Flush a body chunk before waiting for the provider; progress stays under Chrome's idle window.
        await progress();
        controller.signal.throwIfAborted();
        heartbeat = setInterval(() => { void progress(); }, dependencies.heartbeatMs ?? HEARTBEAT_MS);
        const result = await solve(parsed.data, c.env, { signal: controller.signal, onProgress: (next) => { stage = next; } });
        clearInterval(heartbeat);
        if (!controller.signal.aborted) await output.writeln(JSON.stringify({ type: "result", ...save(result) }));
      } catch (error) {
        clearInterval(heartbeat);
        logFailure(error, c.get("requestId"), c.get("startedAt"));
        if (!controller.signal.aborted) await output.writeln(JSON.stringify({ type: "error", ...failure(error, c.get("requestId")) }));
      } finally {
        clearInterval(heartbeat);
        c.req.raw.signal.removeEventListener("abort", cancel);
      }
    });
  });
  return app;
}

export const app = createApp();
export default app;
