import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index";
import { AppError } from "../src/errors";
import { solveWithOllama } from "../src/ollama";
import { code, env, input } from "./inputs";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const request = (body: unknown = input, accept = "application/x-ndjson") => new Request("http://test/solve", { method: "POST", headers: { "Content-Type": "application/json", Accept: accept }, body: JSON.stringify(body) });
const result = { ok: true as const, code, model: env.OLLAMA_MODEL };

describe("solve API", () => {
  it("streams immediately, sends heartbeats and a final result", async () => {
    let complete!: (value: typeof result) => void;
    const solve = vi.fn<typeof solveWithOllama>(() => new Promise(resolve => { complete = resolve; }));
    const app = createApp({ solve, heartbeatMs: 5 });
    const response = await app.fetch(request(), env);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"progress"');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"progress"');
    complete(result);
    let remainder = "";
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; remainder += new TextDecoder().decode(chunk.value); }
    expect(remainder).toContain('"type":"result"');
    expect(remainder).toContain("public final class Main");
  });
  it("uses the same error envelope for HTTP and streaming failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({ solve: async () => { throw new AppError("PROVIDER_AUTH"); } });
    const streamed = await app.fetch(request(), env);
    const events = (await streamed.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: "error", ok: false, error: { code: "PROVIDER_AUTH", retryable: false } });
    const json = await app.fetch(request(input, "application/json"), env);
    expect(json.status).toBe(502);
    expect(await json.json()).toMatchObject({ ok: false, error: { code: "PROVIDER_AUTH", retryable: false } });
  });
  it("validates input before calling Ollama", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const solve = vi.fn<typeof solveWithOllama>();
    const response = await createApp({ solve }).fetch(request({}), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(solve).not.toHaveBeenCalled();
  });
  it("limits bodies without a content-length header", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await createApp().fetch(request({ ...input, problem: 'x'.repeat(51 * 1024) }), env);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });
  it("does not trust a forged small content-length", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const oversized = request({ ...input, problem: 'x'.repeat(51 * 1024) });
    oversized.headers.set("Content-Length", "1");
    expect((await createApp().fetch(oversized, env)).status).toBe(413);
  });
  it("returns retry metadata for local rate limits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({ solve: async () => result });
    await (await app.fetch(request(input, "application/json"), { ...env, MAX_SOLVES_PER_HOUR: "1" })).text();
    const response = await app.fetch(request({ ...input, problem: "another problem" }), { ...env, MAX_SOLVES_PER_HOUR: "1" });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({ error: { code: "RATE_LIMITED", retryable: true } });
  });
  it("cancels generation when the response reader disconnects", async () => {
    let aborted!: Promise<void>;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const app = createApp({ solve: async (_input, _env, options) => {
      aborted = new Promise(resolve => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      markStarted();
      await aborted;
      throw new AppError("CANCELLED");
    } });
    const response = await app.fetch(request(), env);
    const reader = response.body!.getReader();
    await reader.read();
    await started;
    await reader.cancel();
    await aborted;
  });
  it("includes the model in the cache key", async () => {
    const solve = vi.fn<typeof solveWithOllama>(async () => result);
    const app = createApp({ solve });
    await (await app.fetch(request(input, "application/json"), env)).text();
    expect(await (await app.fetch(request(), env)).json()).toMatchObject({ cached: true });
    await (await app.fetch(request(input, "application/json"), { ...env, OLLAMA_MODEL: "another-model" })).text();
    expect(solve).toHaveBeenCalledTimes(2);
  });
});
