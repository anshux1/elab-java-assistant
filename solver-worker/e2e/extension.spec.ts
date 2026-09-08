import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createServer, type Server } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Runs the shipped extension against the bundled Worker in workerd.
// Only the external Ollama HTTP service and eLab/Ace page are fixtures.
const starter = 'public class Main { public static void main(String[] args) {} }';
const answer = 'public final class Main { public static void main(String[] args) { System.out.println("hello world"); } }';
let context: BrowserContext;
let mf: Miniflare;
let server: Server;
let directory: string;
let pageOrigin: string;
let calls = 0;
const pages: Page[] = [];

function fixture(mode: string) {
  return `<!doctype html><html><body>
<table><tr><th>Problem</th><td>Print hello world. Scenario: ${mode}</td></tr>
<tr><th>Test Cases</th><td><div class="ant-collapse-item">
<div class="ant-collapse-header-text">Complexity Test Cases</div>
<div class="ant-card"><div class="ant-card-head-title">Limits</div><div class="ant-card-body">
<div class="overlineFit">Token Count</div><div>1</div></div></div></div></td></tr></table>
<div id="editor"><div class="ant-card-head"><span class="monoFont">Java 11</span></div>
<div id="ace-editor"></div><ul class="ant-card-actions"><li><button onclick="window.runClicks++">Run</button></li></ul></div>
<script>
window.runClicks=0;
window.editorValue=${JSON.stringify(starter)};
window.ace={edit:()=>({session:{getValue:()=>window.editorValue,setValue:value=>{window.editorValue=value}},navigateFileStart(){},clearSelection(){},focus(){}})};
</script></body></html>`;
}

async function open(mode: string) {
  const page = await context.newPage();
  pages.push(page);
  await page.goto(pageOrigin + '/fshelab/' + mode);
  await expect(page.locator('#elab-solve-button')).toBeVisible();
  return page;
}

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'elab-extension-test-'));
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: resolve('dist/index.js'), compatibilityDate: '2026-09-05',
    bindings: { OLLAMA_API_KEY: 'test-only-key', MAX_SOLVES_PER_HOUR: '100' },
    outboundService: async request => {
      calls++;
      const body = await request.json() as { messages: Array<{ content: string }> };
      const prompt = body.messages.map(message => message.content).join('\n');
      if (prompt.includes('Scenario: provider-error')) return Response.json({ error: 'private upstream error' }, { status: 401 });
      const delay = prompt.includes('Scenario: long') ? 45_000 : prompt.includes('Scenario: edit') ? 2_000 : 0;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return Response.json({ model: 'gpt-oss:120b', done: true, done_reason: 'stop', message: { content: answer, thinking: 'private trace' } });
    }
  }));
  const solverOrigin = (await mf.ready).origin;
  const extension = join(directory, 'extension');
  await cp(resolve('../problem-copier-extension'), extension, { recursive: true });
  const workerPath = join(extension, 'service-worker.js');
  await writeFile(workerPath, (await readFile(workerPath, 'utf8')).replace('https://elab-solver.elab-solver-worker.workers.dev/solve', solverOrigin + '/solve'));
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [solverOrigin + '/*'];
  expect(manifest.content_scripts.every((script: { matches: string[] }) =>
    script.matches.length === 1 && script.matches[0] === 'https://dld.srmist.edu.in/fshelab/*')).toBe(true);
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(fixture((request.url || '/').replace(/^\/fshelab\//, '').replace(/[^a-z-]/g, '')));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  pageOrigin = `http://127.0.0.1:${address.port}`;
  // Redirect only the origin for fixtures; preserve the shipped /fshelab/ restriction.
  for (const script of manifest.content_scripts) {
    script.matches = script.matches.map((pattern: string) => pattern.replace('https://dld.srmist.edu.in', pageOrigin));
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(directory, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
});

test.afterEach(async () => {
  for (const page of pages.splice(0)) await page.close();
});

test.afterAll(async () => {
  await context?.close();
  await mf?.dispose();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('keeps a 45-second solve alive and inserts only the final answer with warnings', async () => {
  const page = await open('long');
  const before = calls;
  await page.locator('#elab-solve-button').click();
  await expect.poll(() => calls).toBe(before + 1);
  // Do not inspect/evaluate the extension worker: a debugger can mask lifecycle bugs.
  await page.waitForTimeout(35_000);
  expect(await page.evaluate(() => (window as any).editorValue)).toBe(starter);
  await expect(page.locator('#elab-solve-button')).toHaveText(/Solving/);
  await expect.poll(() => page.evaluate(() => (window as any).editorValue), { timeout: 25_000 }).toBe(answer);
  await expect(page.locator('#elab-solver-toast')).toContainText('Estimated token count');
  expect(await page.evaluate(() => (window as any).runClicks)).toBe(0);
  expect(calls).toBe(before + 1);
});

test('shows a streamed provider error without replacing the editor', async () => {
  const page = await open('provider-error');
  await page.locator('#elab-solve-button').click();
  await expect(page.locator('#elab-solver-toast')).toContainText('API key was rejected');
  expect(await page.evaluate(() => (window as any).editorValue)).toBe(starter);
  await expect(page.locator('#elab-solve-button .elab-solve-label')).toHaveText('Try again');
});

test('preserves edits made while generation is running', async () => {
  const page = await open('edit');
  const before = calls;
  await page.locator('#elab-solve-button').click();
  await expect.poll(() => calls).toBe(before + 1);
  await page.evaluate(() => { (window as any).editorValue = 'my unsaved edits'; });
  await expect(page.locator('#elab-solver-toast')).toContainText('Your edits were kept');
  expect(await page.evaluate(() => (window as any).editorValue)).toBe('my unsaved edits');
});

test('does not inject outside the supported eLab path', async () => {
  const page = await context.newPage();
  pages.push(page);
  await page.goto(pageOrigin + '/unrelated');
  await page.waitForTimeout(500);
  await expect(page.locator('#elab-solve-button')).toHaveCount(0);
  await expect(page.locator('#elab-copy-button')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__elabSolverBridgeLoaded)).toBeUndefined();
});
