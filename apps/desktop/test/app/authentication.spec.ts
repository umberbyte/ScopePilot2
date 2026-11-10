import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect, test } from '@playwright/test';
import { createCoreApiServer } from '@scopepilot2/core';
import { bootstrapFlow } from '../../../../packages/core/test/unit/support/test-flow.ts';
import { t } from '../../src/renderer/resources.ts';

/** Real renderer + Core HTTP API, deterministic auth adapters; no target traffic. */
test('A09 context, users, form login, session verification and capability disclosure', async ({}, testInfo) => {
  let valid = true;
  const { service, operator } = await bootstrapFlow({
    loginExecutor: { engineVersion: 'fixture-login-ui', async execute() {
      return { authenticated: true, finalUrl: 'http://fixture.target.test/home', cookies: [{ name: 'sid', value: 'transient-session', domain: 'fixture.target.test', path: '/' }] };
    } },
    interactiveBrowser: { engineVersion: 'fixture-verification-ui', async execute(input) {
      return { finalUrl: input.targetUrl, status: 200, bodyHash: 'hash', bodyText: 'Welcome', headers: [], elapsedMs: 1, assertions: [{ kind: 'assert', target: 'Welcome', passed: valid }] };
    } },
  });
  const api = createCoreApiServer({ service, operator });
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { FluentProvider, webLightTheme } from '@fluentui/react-components';
    import { SessionsScreen } from './src/renderer/sessions-screen.tsx';
    createRoot(document.getElementById('root')).render(<FluentProvider theme={webLightTheme}><SessionsScreen apiBase="" /></FluentProvider>);
  `, loader: 'tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api/')) { api.emit('request', request, response); return; }
    response.setHeader('Content-Type', request.url === '/bundle.js' ? 'text/javascript' : 'text/html; charset=utf-8');
    response.end(request.url === '/bundle.js' ? bundle.outputFiles[0]!.text : '<div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('TCP address expected');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect(page.getByText(/fixture-login-ui/)).toBeVisible();
    await expect(page.getByText(/fixture-verification-ui/)).toBeVisible();
    await page.getByLabel(t('a02.deniedLabel'), { exact: true }).fill('http://denied.test');
    await page.getByRole('button', { name: t('a09.saveContext'), exact: true }).click();
    await expect(page.getByText(/revision 2/)).toBeVisible();
    await page.getByLabel(t('a09.roleLabel'), { exact: true }).fill('alice');
    await page.getByLabel(t('a09.displayName')).fill('Alice');
    await page.getByLabel(t('a09.authorizationRole')).fill('admin');
    await page.getByLabel(t('a09.method'), { exact: true }).selectOption('Bearer');
    await expect(page.getByText(t('a09.methodUnavailable'))).toBeVisible();
    await expect(page.getByRole('button', { name: t('a09.loginRun'), exact: true })).toBeDisabled();
    await page.getByLabel(t('a09.method'), { exact: true }).selectOption('Form');
    await page.getByRole('button', { name: t('a09.saveUser'), exact: true }).click();
    await expect(page.getByText(t('a09.userSaved'))).toBeVisible();
    await page.getByLabel(t('a09.baseUrlLabel')).fill('http://fixture.target.test');
    await page.getByLabel(t('a09.expectedPrefixLabel')).fill('http://fixture.target.test/');
    await page.getByLabel(t('a09.successMarker')).fill('Welcome');
    await page.getByRole('button', { name: t('a09.buildForm'), exact: true }).click();
    await page.getByRole('button', { name: t('a09.register'), exact: true }).click();
    const username = page.getByLabel(t('a09.secretLabel', { reference: 'credential:alice:username' }), { exact: true });
    const password = page.getByLabel(t('a09.secretLabel', { reference: 'credential:alice:password' }), { exact: true });
    await username.fill('alice'); await password.fill('temporary-password');
    await page.getByRole('button', { name: t('a09.loginRun'), exact: true }).click();
    await expect(page.getByText(/alice.*http:\/\/fixture.target.test\/home/)).toBeVisible();
    await expect(password).toHaveValue('');
    await expect(page.getByRole('button', { name: t('a09.refresh'), exact: true })).toBeDisabled();
    const verify = page.getByRole('button', { name: t('a09.verify'), exact: true });
    await verify.click();
    await expect(page.getByText(/alice: valid/).last()).toBeVisible();
    valid = false;
    await verify.click();
    await expect(page.getByText(/alice: expired/).last()).toBeVisible();
    await expect(verify).toBeDisabled();
    await page.getByRole('checkbox', { name: t('a09.enabled'), exact: true }).uncheck();
    await page.getByRole('button', { name: t('a09.saveUser'), exact: true }).click();
    await expect(page.getByRole('button', { name: t('a09.loginRun'), exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('authentication.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
