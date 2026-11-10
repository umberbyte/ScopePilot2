import { fileURLToPath } from 'node:url';
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createCoreApiServer } from '@scopepilot2/core';
import { bootstrapFlow } from '../../../../packages/core/test/unit/support/test-flow.ts';

// Mount the production screen against the fixture core API; no target network traffic.
let browser: Browser;
let page: Page;
let ui: Server;
let api: Server;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  const { service, operator } = await bootstrapFlow();
  service.registerPayloadSet(operator, { name: 'generic', source: 'fixture', version: '1', license: 'CC0', sha256: 'fixture-hash', values: ['one', 'longer'] });
  api = createCoreApiServer({ service, operator });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('TCP required');
  const apiBase = `http://127.0.0.1:${address.port}`;
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {FluentProvider,webLightTheme} from '@fluentui/react-components'; import {FuzzerScreen} from './src/renderer/fuzzer-screen.tsx'; createRoot(document.getElementById('root')).render(<FluentProvider theme={webLightTheme}><FuzzerScreen apiBase="" /></FluentProvider>);`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  ui = createServer((request, response) => {
    if (request.url?.startsWith('/api/')) {
      const proxy = httpRequest(`${apiBase}${request.url}`, { method: request.method, headers: { 'Content-Type': 'application/json' } }, upstream => { response.writeHead(upstream.statusCode ?? 500, upstream.headers); upstream.pipe(response); });
      request.pipe(proxy);
    }
    else if (request.url === '/screen.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0]!.text); }
    else response.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/screen.js"></script>');
  });
  await new Promise<void>(resolve => ui.listen(0, '127.0.0.1', resolve));
  const uiAddress = ui.address();
  if (!uiAddress || typeof uiAddress === 'string') throw new Error('TCP required');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${uiAddress.port}`);
});
test.afterAll(async () => {
  await browser?.close();
  for (const server of [ui, api]) if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
});
test('GO-15: fixture label, selected catalog, query insertion, progress and length/diff results', async () => {
  await expect(page.getByText('fixture mode:', { exact: false })).toBeVisible();
  await page.getByLabel('Target URL', { exact: true }).fill('http://fixture.target.test/fuzz?q=original');
  await page.getByRole('button', { name: 'Detect query positions' }).click();
  await page.getByLabel('Payload set for q', { exact: true }).selectOption('generic');
  await page.getByRole('button', { name: 'Run Fuzzer', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Completed: 2 / 2');
  const results = page.getByRole('table', { name: 'Fuzzer results' });
  await expect(results.getByRole('row')).toHaveCount(3);
  await expect(results.getByRole('cell', { name: 'Changed', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Response 2', exact: true }).click();
  await expect(page.getByText(/Response 2: status 200; body hash/)).toBeVisible();
  await page.getByLabel('Only changed responses').check();
  await expect(results.getByRole('row')).toHaveCount(2);
});
test('GO-15: estimated combinations over limit disable sending', async () => {
  await page.getByLabel('Maximum requests (also capped by case limit)').fill('1');
  await expect(page.getByRole('button', { name: 'Run Fuzzer', exact: true })).toBeDisabled();
});

test('GO-15: body editor selection creates a payload insertion', async () => {
  await page.getByLabel('Maximum requests (also capped by case limit)').fill('200');
  await page.getByLabel('Method', { exact: true }).selectOption('POST');
  const editor = page.getByLabel('Request body (select text, then add insertion)');
  await editor.fill('field=base');
  await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 10));
  await page.getByRole('button', { name: 'Add body insertion', exact: true }).click();
  await expect(editor).toHaveValue('field=\u00a7base\u00a7');
  await page.getByLabel('Payload set for body:1', { exact: true }).selectOption('generic');
  await page.getByRole('button', { name: 'Run Fuzzer', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Completed: 4 / 4');
});
