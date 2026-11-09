import { expect, test, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreApiServer } from '../../../../packages/core/src/application/api-server.ts';
import { bootstrapFlow } from '../../../../packages/core/test/unit/support/test-flow.ts';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP address required');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}

// Real Advanced renderer + real Core API, with an observation-only fixture explorer.
// This isolated Electron harness avoids starting ZAP or issuing target HTTP requests.
test('A41 passive rules/status, Alerts details/filter/evidence and Findings navigation', async () => {
  const { service, operator } = await bootstrapFlow({ explorer: { engineVersion: 'fake-explorer-1', observe: async (url) => ({
    url, status: 200, contentType: 'text/html', discoveredFrom: null, depth: 0, originType: 'crawl', links: [],
    forms: [{ actionUrl: 'http://fixture.target.test/login', method: 'POST', classification: 'login', fields: [{ name: 'password', type: 'password' }] }],
  }) } });
  const { plan } = service.buildExplorationPlan(operator, ['http://fixture.target.test/login']);
  service.authorizePlan(plan);
  await service.runExploration(operator, plan, service.confirmPlan(plan, operator), { maxDepth: 1 });
  const core = createCoreApiServer({ service, operator });
  const coreBase = await listen(core);
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {FluentProvider, webLightTheme} from '@fluentui/react-components'; import {AdvancedApp} from './src/renderer/advanced.tsx'; createRoot(document.getElementById('root')).render(<FluentProvider theme={webLightTheme}><AdvancedApp apiBase="" /></FluentProvider>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife' });
  const web = createServer((request, response) => {
    if (request.url?.startsWith('/api/')) {
      void fetch(`${coreBase}${request.url}`).then(async (result) => { response.writeHead(result.status, { 'Content-Type': 'application/json' }); response.end(await result.text()); });
    } else if (request.url === '/renderer.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(bundle.outputFiles[0]!.contents); }
    else { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end('<div id="root"></div><script src="/renderer.js"></script>'); }
  });
  const webBase = await listen(web);
  const directory = await mkdtemp(join(tmpdir(), 'scopepilot-passive-ui-'));
  const main = join(directory, 'main.cjs');
  await writeFile(main, `const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{const win=new BrowserWindow({width:1400,height:1000});win.loadURL(${JSON.stringify(webBase)});});`);
  const app = await electron.launch({ args: [main] });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: /A41/ }).click();
    await expect(page.getByText('受動ルール（参照のみ）')).toBeVisible();
    await expect(page.getByText('処理待ち 0 / 処理済み 1 / 失敗 0 / Alerts 1')).toBeVisible();
    await expect(page.getByText(/Findings と同じ所見/)).toBeVisible();
    await page.getByRole('button', { name: /暗号化されないパスワードフォーム —/ }).click();
    const detail = page.getByRole('region', { name: 'Alert 詳細' });
    await expect(detail.getByText(/実影響は未確認/)).toBeVisible();
    const href = await detail.getByRole('link').getAttribute('href');
    const response = await page.request.get(`${webBase}${href}`);
    expect(response.ok()).toBe(true);
    expect((await response.json()).findingId).toBe(service.listFindings()[0]!.findingId);
    await page.getByLabel('重大度', { exact: true }).selectOption('high');
    await expect(page.getByText('Alerts: 0 件')).toBeVisible();
    await page.getByLabel('重大度', { exact: true }).selectOption('all');
    await page.getByLabel('Alerts の検索').fill('no-match');
    await expect(page.getByText('Alerts: 0 件')).toBeVisible();
    await page.getByLabel('Alerts の検索').fill('');
    await expect(page.getByText('Alerts: 1 件')).toBeVisible();
    await page.getByRole('button', { name: 'Findings で管理する', exact: true }).click();
    await expect(page.getByText('暗号化されないパスワードフォーム', { exact: true })).toBeVisible();
  } finally {
    await app.close(); await close(web); await close(core);
    await rm(directory, { recursive: true, force: true });
  }
});
