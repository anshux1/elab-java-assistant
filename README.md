# eLab Solver

A small Chrome/Edge extension for eLab programming pages.

It adds exactly two extension actions:

- **Solve** — sends the current problem and starter code to the companion Worker, then inserts the generated Java solution into Ace for review.
- **Copy** — copies the problem and grading requirements as Markdown.

The extension never clicks Run, Evaluate, Save, or Reset.

## Install the extension

1. Deploy the Worker in [`solver-worker/`](./solver-worker/).
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select [`problem-copier-extension/`](./problem-copier-extension/).
6. Open or reload an eLab problem page.

The extension sends requests only to the configured Worker. The Ollama API key stays in the Worker and is never included in the extension.

## Worker setup

```bash
cd solver-worker
npm install
cp .dev.vars.example .dev.vars
```

Put your Ollama key in `.dev.vars` for local development, then run:

```bash
npm run dev
```

For deployment:

```bash
npm run check
npx wrangler secret put OLLAMA_API_KEY
npm run deploy
```

The backend uses Hono and `ollama/browser` on Cloudflare Workers. A single request streams progress while Ollama generates, then returns complete Java or a specific error. Approximate grading checks appear as review warnings. No queue, database, or EC2 host is needed.

See [`solver-worker/README.md`](./solver-worker/README.md) for the protocol, limits, and automated tests.

> Browser-internal pages such as `chrome://extensions` cannot be modified by extensions. For a local HTML page, enable **Allow access to file URLs** in the extension details.
