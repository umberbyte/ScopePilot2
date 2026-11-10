/** Real renderer/API/SSE/loopback transport; isolated from installed scan engines. */
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NodeSequencerTransport } from '@scopepilot2/adapters';
import { createCoreApiServer } from '@scopepilot2/core';
import { bootstrapFlow } from '../../../../packages/core/test/unit/support/test-flow.ts';

test('A52 live progress, navigation, stop, restore and completion preserve A50/A51', async () => {
  let received = 0;
  const target = createServer((_req, res) => { received++; res.end(`token=private-token-${received}`); });
  await new Promise<void>(r => target.listen(0, '127.0.0.1', r));
  const targetBase = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
  const { service, operator } = await bootstrapFlow({ allowedOrigins: [targetBase], sequencerTransport: new NodeSequencerTransport({ requestsPerSecond: 100 }) });
  const api = createCoreApiServer({ service, operator });
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {FluentProvider,webLightTheme} from '@fluentui/react-components'; import {AdvancedApp} from './advanced.tsx'; createRoot(document.getElementById('root')).render(<FluentProvider theme={webLightTheme}><AdvancedApp apiBase={location.origin}/></FluentProvider>);`, resolveDir: resolve('src/renderer'), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const handler = api.listeners('request')[0]!;
  api.removeAllListeners('request');
  api.on('request', (req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<div id="root"></div><script src="/renderer.js"></script>'); }
    else if (req.url === '/renderer.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0]!.contents); }
    else handler.call(api, req, res);
  });
  await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const dir = await mkdtemp(join(tmpdir(), 'scopepilot-go35-'));
  const main = join(dir, 'main.cjs');
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1400,height:1000});w.loadURL(${JSON.stringify(base)});});app.on('window-all-closed',()=>app.quit());`);
  const app = await electron.launch({ args: [main] });
  try {
    const page = await app.firstWindow();
    const nav = (name: string) => page.getByRole('button', { name, exact: true }).click();
    const run = () => nav('sample を収集して解析する');
    const status = page.getByTestId('sequencer-job');
    await nav('A52 Sequencer');
    await expect(page.getByRole('button', { name: '復号する', exact: true })).toHaveCount(0);
    await page.getByLabel('対象 URL (scope 内)', { exact: true }).fill(`${targetBase}/token`);
    await page.getByLabel('sample 数 (30〜10000)').fill('1000');
    await run();
    await expect(status).toContainText('Running');
    await expect(status).toContainText('live');
    await expect.poll(() => received).toBeGreaterThan(1);
    await nav('A50 Decoder');
    const id = service.jobs.list().find(j => j.kind === 'sequencer')!.jobId;
    expect(service.jobs.get(id)!.summary.state).toBe('Running');
    await nav('A52 Sequencer');
    await expect(status).toContainText('Running');
    await nav('収集を停止する');
    await expect(status).toContainText('Stopped');
    const stopped = received;
    await expect(page.getByTestId('sequencer-result')).toBeVisible();
    await nav('A50 Decoder');
    await page.getByLabel('入力 (text)').fill('aGVsbG8=');
    await nav('base64 を追加');
    await nav('復号する');
    await expect(page.getByText('hello', { exact: true })).toBeVisible();
    await nav('A51 Comparer');
    await page.getByLabel('左', { exact: true }).fill('left');
    await page.getByLabel('右', { exact: true }).fill('right');
    await nav('比較する');
    await expect(page.getByText(/差分 1 行/)).toBeVisible();
    expect(received).toBe(stopped);
    await nav('A52 Sequencer');
    await expect(status).toContainText('Stopped');
    await expect(page.getByTestId('sequencer-result')).toBeVisible();
    await page.getByLabel('対象 URL (scope 内)', { exact: true }).fill(`${targetBase}/token`);
    await page.getByLabel('sample 数 (30〜10000)').fill('30');
    await run();
    await expect(status).toContainText('Completed');
    await expect(page.getByTestId('sequencer-result')).toContainText('sample 30');
    await expect(page.getByTestId('sequencer-result')).not.toContainText('private-token');
  } finally {
    for (const job of service.jobs.list()) if (service.jobs.active(job.state)) service.jobs.stop(job.jobId);
    await app.close();
    api.closeAllConnections(); target.closeAllConnections();
    await Promise.all([new Promise<void>(r => api.close(() => r())), new Promise<void>(r => target.close(() => r()))]);
    if (!resolve(dir).startsWith(resolve(join(tmpdir(), 'scopepilot-go35-')))) throw new Error('unexpected test cleanup path');
    await rm(dir, { recursive: true, force: true });
  }
});
