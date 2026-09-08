import type { ContentfulStatusCode } from "hono/utils/http-status";

// One policy for HTTP failures and errors sent after a response stream has started.
const definitions = {
  INVALID_INPUT: [400, "The problem data is invalid.", false],
  PAYLOAD_TOO_LARGE: [413, "The problem payload is too large.", false],
  NOT_FOUND: [404, "This API endpoint does not exist.", false],
  RATE_LIMITED: [429, "Too many solve requests. Try again later.", true],
  NOT_CONFIGURED: [503, "The Ollama API is not configured.", false],
  PROVIDER_AUTH: [502, "The Ollama API key was rejected.", false],
  PROVIDER_CREDITS: [402, "The Ollama account has no available usage allowance.", false],
  PROVIDER_RATE_LIMITED: [429, "Ollama is temporarily rate-limited. Try again shortly.", true],
  PROVIDER_TIMEOUT: [504, "Ollama took too long to solve this problem.", true],
  PROVIDER_UNAVAILABLE: [503, "Could not complete the request to Ollama. Try again shortly.", true],
  INVALID_MODEL_RESPONSE: [502, "Ollama returned an empty or incomplete answer. Try again.", true],
  INVALID_SOLUTION: [422, "Ollama could not produce a complete Java solution. Try again.", true],
  CANCELLED: [408, "The solve request was cancelled.", true],
  INTERNAL_ERROR: [500, "The solver encountered an unexpected error.", true]
} as const satisfies Record<string, readonly [ContentfulStatusCode, string, boolean]>;

export type ErrorCode = keyof typeof definitions;
export type Issue = { code: string; message: string };

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly issues?: Issue[],
    readonly retryAfter?: number
  ) {
    super(definitions[code][1]);
    this.name = "AppError";
  }

  get status() { return definitions[this.code][0]; }
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error && typeof error === "object" && "status_code" in error) {
    const status = Number(error.status_code);
    const codes: Record<number, ErrorCode> = {
      401: "PROVIDER_AUTH", 403: "PROVIDER_AUTH", 402: "PROVIDER_CREDITS",
      408: "PROVIDER_TIMEOUT", 429: "PROVIDER_RATE_LIMITED", 504: "PROVIDER_TIMEOUT"
    };
    return new AppError(codes[status] || "PROVIDER_UNAVAILABLE", undefined, status === 429 ? 30 : undefined);
  }
  if (error instanceof Error && error.name === "TimeoutError") return new AppError("PROVIDER_TIMEOUT");
  if (error instanceof Error && error.name === "AbortError") return new AppError("CANCELLED");
  return new AppError("INTERNAL_ERROR");
}

export function failure(error: unknown, requestId: string) {
  const normalized = normalizeError(error);
  return {
    ok: false as const,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: definitions[normalized.code][2],
      requestId,
      ...(normalized.issues?.length ? { issues: normalized.issues } : {}),
      ...(normalized.retryAfter ? { retryAfter: normalized.retryAfter } : {})
    }
  };
}

export function logFailure(error: unknown, requestId: string, startedAt: number) {
  const normalized = normalizeError(error);
  if (normalized.code === "CANCELLED") return;
  console.error("solve_failed", {
    requestId, code: normalized.code, durationMs: Date.now() - startedAt,
    issues: normalized.issues?.map((issue) => issue.code)
  });
}
