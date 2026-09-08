import { describe, expect, it, vi, afterEach } from "vitest";
// Exercise the shipped extension parser, not a second implementation.
import { solve } from "../../problem-copier-extension/api-client.js";
import { code, input } from "./inputs";

afterEach(() => vi.useRealTimers());
const event = (value: unknown) => JSON.stringify(value) + "\n";
const final = { type: "result", ok: true, code, model: "test", warnings: [{ code: "CHECK", message: "Review the target." }] };
const stream = (text: string, chunkSize = 7) => {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize)); controller.close(); } }), { headers: { "content-type": "application/x-ndjson" } });
};

describe("extension stream reader", () => {
  it("handles fragmented events, Unicode, progress and warnings", async () => {
    const progress = vi.fn();
    const response = await solve("http://test", input, { onProgress: progress, transport: async () => stream(event({ type: "progress", stage: "solving" }) + event({ ...final, code: code.replace("hello world", "こんにちは") }), 1) });
    expect(response.ok).toBe(true);
    expect(response.code).toContain("こんにちは");
    expect(response.warnings).toHaveLength(1);
    expect(progress).toHaveBeenCalledWith("solving");
  });
  it("accepts a final event without a newline", async () => {
    expect((await solve("http://test", input, { transport: async () => stream(JSON.stringify(final)) })).ok).toBe(true);
  });
  it("rejects a stream that ends with only progress", async () => {
    const result = await solve("http://test", input, { transport: async () => stream(event({ type: "progress", stage: "solving" })) });
    expect(result).toMatchObject({ ok: false, error: { code: "BAD_RESPONSE" } });
    expect(result).not.toHaveProperty("code");
  });
  it("forwards streamed provider errors", async () => {
    const result = await solve("http://test", input, { transport: async () => stream(event({ type: "error", ok: false, error: { code: "PROVIDER_RATE_LIMITED", message: "Try shortly.", retryable: true } })) });
    expect(result).toMatchObject({ ok: false, error: { code: "PROVIDER_RATE_LIMITED" } });
  });
  it("accepts cached JSON and legacy JSON responses", async () => {
    expect((await solve("http://test", input, { transport: async () => Response.json({ ...final, cached: true }) })).ok).toBe(true);
    expect(await solve("http://test", input, { transport: async () => Response.json({ ok: false, error: "Old server failure" }, { status: 502 }) })).toMatchObject({ ok: false, error: { message: "Old server failure" } });
  });
  it("rejects invalid JSON and oversized responses", async () => {
    expect(await solve("http://test", input, { transport: async () => stream("not json\n") })).toMatchObject({ ok: false, error: { code: "BAD_RESPONSE" } });
    expect(await solve("http://test", input, { transport: async () => new Response('x'.repeat(1024 * 1024 + 1)) })).toMatchObject({ ok: false, error: { code: "BAD_RESPONSE" } });
  });
  it("aborts a stalled initial response before the browser fetch timeout", async () => {
    vi.useFakeTimers();
    const transport = vi.fn((_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
    const pending = solve("http://test", input, { transport });
    await vi.advanceTimersByTimeAsync(25_001);
    expect(await pending).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
  });
});
