import { afterEach, describe, expect, it, vi } from "vitest";
import { solveWithOllama } from "../src/ollama";
import { answer, code, env, input } from "./inputs";

afterEach(() => vi.useRealTimers());
const mockFetch = (...bodies: unknown[]) => vi.fn<typeof fetch>().mockImplementation(async () => Response.json(bodies.shift()));

describe("actual Ollama SDK with mocked HTTP", () => {
  it("sends the hosted request and accepts valid source", async () => {
    const transport = mockFetch(answer());
    const result = await solveWithOllama(input, env, { fetch: transport });
    expect(result.code).toBe(code);
    const [url, init] = transport.mock.calls[0];
    expect(new URL(String(url)).href).toBe("https://ollama.com/api/chat");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-only-key");
    expect(JSON.parse(init!.body as string)).toMatchObject({ stream: false, think: "medium", model: "gpt-oss:120b" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("repairs empty final content once using low effort, without leaking thinking", async () => {
    const transport = mockFetch(answer("", { message: { content: "", thinking: "private trace" } }), answer());
    const result = await solveWithOllama(input, env, { fetch: transport });
    expect(result.usage).toEqual({ input: 20, output: 40 });
    const retry = JSON.parse(transport.mock.calls[1][1]!.body as string);
    expect(retry.think).toBe("low");
    expect(JSON.stringify(retry)).not.toContain("private trace");
  });
  it("repairs wrong class names with actionable feedback", async () => {
    const transport = mockFetch(answer(code.replace("class Main", "class Other")), answer());
    expect((await solveWithOllama(input, env, { fetch: transport })).code).toBe(code);
    expect(transport.mock.calls[1][1]!.body).toContain("public class must be Main");
  });
  it("does not reject or repair warning-only results", async () => {
    const transport = mockFetch(answer());
    const request = { ...input, complexity: [{ title: "Limits", fields: [{ label: "Token Count", value: "1" }] }] };
    expect((await solveWithOllama(request, env, { fetch: transport })).warnings).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([401, 402, 403, 429, 500])("normalizes HTTP %s without exposing provider text", async (status) => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ error: "sensitive provider message" }, { status }));
    const expected: Record<number, string> = { 401: "PROVIDER_AUTH", 402: "PROVIDER_CREDITS", 403: "PROVIDER_AUTH", 429: "PROVIDER_RATE_LIMITED", 500: "PROVIDER_UNAVAILABLE" };
    await expect(solveWithOllama(input, env, { fetch: transport })).rejects.toMatchObject({ code: expected[status] });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed JSON without classifying it as a network failure", async () => {
    await expect(solveWithOllama(input, env, { fetch: async () => new Response("not json") })).rejects.toMatchObject({ code: "INVALID_MODEL_RESPONSE" });
  });
  it("rejects output truncation even when the partial code looks complete", async () => {
    const transport = mockFetch(answer(code, { done_reason: "length" }), answer(code, { done_reason: "length" }));
    await expect(solveWithOllama(input, env, { fetch: transport })).rejects.toMatchObject({ code: "INVALID_MODEL_RESPONSE" });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("enforces a total deadline and cancels the actual fetch", async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>((_, init) => new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))));
    const pending = expect(solveWithOllama(input, env, { fetch: transport, timeoutMs: 100 })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(101);
    await pending;
    expect(transport.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });
  it("cancels on client disconnect without retrying", async () => {
    const controller = new AbortController();
    const transport = vi.fn<typeof fetch>((_, init) => new Promise((_, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)); controller.abort(); }));
    await expect(solveWithOllama(input, env, { signal: controller.signal, fetch: transport })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("bounds provider response size", async () => {
    await expect(solveWithOllama(input, env, { fetch: async () => new Response('x'.repeat(1024 * 1024 + 1)) })).rejects.toMatchObject({ code: "INVALID_MODEL_RESPONSE" });
  });
  it("classifies a dropped provider response body as unavailable", async () => {
    const transport = async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError("socket closed")); }
    }));
    await expect(solveWithOllama(input, env, { fetch: transport })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
  it("does not start a repair when the remaining budget is insufficient", async () => {
    const transport = mockFetch(answer(""));
    await expect(solveWithOllama(input, env, { fetch: transport, timeoutMs: 1000 })).rejects.toMatchObject({ code: "INVALID_MODEL_RESPONSE" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
