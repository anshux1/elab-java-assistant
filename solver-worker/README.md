# eLab Java Assistant · Worker

A single Hono `/solve` endpoint on Cloudflare Workers. `ollama/browser` calls Ollama Cloud; the extension uses native fetch. No database, queue, authentication flow, or EC2 server is required.

## Development and checks

```bash
npm install
cp .dev.vars.example .dev.vars
# Set OLLAMA_API_KEY in .dev.vars.
npm run dev
```

The default hosted model is `gpt-oss:120b`. There is no local model download. The SDK's browser entry point runs on the server, so the Ollama key stays in Worker secrets.

For local extension testing, temporarily add `http://127.0.0.1:8787/*` to the manifest host permissions and change `SOLVER_ENDPOINT` in `../problem-copier-extension/service-worker.js` to `http://127.0.0.1:8787/solve`, reload the unpacked extension, and reload the problem page. Restore the deployed URL before distributing the extension.

```bash
npm run check
# One-time browser setup (Linux may also need: npx playwright install-deps chromium)
npx playwright install chromium
npm run test:browser
```

Unit tests cover the actual SDK with mocked HTTP, Java extraction, warning-only acceptance, deadlines, cancellation, API errors, cache behavior and fragmented extension streams. Browser tests load a temporary copy of the real extension against the bundled Worker in workerd. A mocked Ollama takes 45 seconds, verifying the connection survives Chrome's 30-second idle window. They also verify warnings, provider failures, preservation of user edits, and that Run is never clicked. Tests do not use your Ollama key or deploy a Worker.

## Request flow

1. The content script reads the problem and opens an extension runtime port.
2. The extension worker posts to `/solve` with `Accept: application/x-ndjson`.
3. Hono validates the request and immediately writes a progress event.
4. Every 10 seconds, progress is sent through the HTTP stream and extension port. Active port messages keep the MV3 worker alive (Chrome/Edge 114+).
5. The SDK obtains Ollama's non-streaming JSON response. Thinking stays on the server and is not treated as final code.
6. Java is extracted and checked. The server sends one final result or structured error, then closes the stream.
7. The extension inserts complete code only if the problem and editor contents are unchanged.

The server-to-extension stream carries progress, not partial Java. The provider request itself uses `stream: false`, letting the SDK own JSON parsing without a second NDJSON fallback parser. A cache hit returns ordinary JSON, which the extension also understands. Clients requesting JSON retain the synchronous `/solve` behavior; they do not receive progress heartbeats.

`GET /health` reports API availability and configured model, not provider credential validity.

## Response contract

Progress events:

```json
{"type":"progress","stage":"solving"}
```

Stages are `solving`, `repairing`, and `validating`.

Final event:

```json
{"type":"result","ok":true,"code":"public class Main { ... }","model":"gpt-oss:120b","warnings":[{"code":"ESTIMATED_TOKEN_COUNT","message":"Estimated token count exceeds the listed target."}]}
```

Failure:

```json
{"type":"error","ok":false,"error":{"code":"PROVIDER_TIMEOUT","message":"Ollama took too long to solve this problem.","retryable":true,"requestId":"..."}}
```

Before streaming starts, failures use an appropriate HTTP status and the same error envelope without `type`. Once headers have been sent, the HTTP status stays 200 and the terminal error event represents failure. The extension handles both. `errors.ts` owns error codes, messages, retry policy and safe logging.

## Generation and acceptance

- One 120-second deadline covers generation plus, when needed, one repair. At least 15 seconds must remain to start a repair. Transport/auth/rate-limit failures are not automatically retried.
- GPT-OSS starts with `think: "medium"`; a repair uses `"low"`. Booleans cannot disable GPT-OSS thinking.
- Output budget: 8,192 tokens. Provider responses are bounded to 1 MiB; final answer text is bounded to 100,000 characters.
- The extension has a 135-second overall deadline and a 25-second no-data timeout, including the initial response. It disconnects on page close or problem navigation, cancelling the upstream call.
- Extraction accepts Java fences or plain source and preserves modifiers, annotations, imports, helpers and literal whitespace. It never rewrites mandatory fragments into source.
- Missing required class/main, unbalanced delimiters, incomplete literals and explicitly truncated provider answers trigger a repair or clear failure.
- Missing recognized mandatory constructs and approximate complexity/token/NLOC limits become review warnings. Descriptive mandatory-card metadata remains in the prompt but is not treated as literal source.
- These are structural checks, not a compiler or a proof of correctness. Review the result and run the eLab grader.

## State and privacy

A bounded in-memory cache holds up to 64 results for one hour. Its key includes the problem, model and prompt/validation version. A bounded per-IP rate window uses `MAX_SOLVES_PER_HOUR` (default 60). Both are best-effort per-isolate conveniences and reset when Workers recycle; they are not persistent or globally enforced.

No background job survives disconnection. Retry Solve if the browser closes or the connection is lost. The endpoint has no caller authentication: anyone who knows its URL can call it; CORS is not access control.

Logs include request IDs, error/issue codes and durations, not keys, prompts, code, thinking or raw provider messages.

## Files

```text
src/
  index.ts    Hono route, progress stream, bounded cache/rate windows
  errors.ts   Shared application error policy and safe failure logging
  schema.ts   Problem schema, result and progress types
  ollama.ts   SDK adapter, deadline/cancellation, one targeted repair
  java.ts     Source extraction, token-aware structural checks and warnings
  prompts.ts Problem and grading instructions
```

## Deploy

```bash
npm run check
npx wrangler secret put OLLAMA_API_KEY
npm run deploy
```

The extension currently targets `https://elab-solver.elab-solver-worker.workers.dev/solve`. If the hostname changes, update both `SOLVER_ENDPOINT` and the extension's host permission. Reload the extension and the eLab page after updating extension files. No Node compatibility flag is required for the tested `ollama/browser` entry point.
