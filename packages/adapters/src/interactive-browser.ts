import { createHash } from 'node:crypto';
import { sanitiseObservationUrl, ScopePolicy, type InteractiveBrowserFile, type InteractiveBrowserPort } from '@scopepilot2/core';

import { requestInputPoints } from './playwright-explorer.ts';
import type { ObservedHttpRequest } from '@scopepilot2/contracts';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function decodeFile(file: InteractiveBrowserFile): Buffer {
  const data = Buffer.from(file.dataBase64, 'base64');
  if (data.length === 0 || data.length > MAX_UPLOAD_BYTES) {
    throw new Error(`interactive browser upload must be between 1 and ${MAX_UPLOAD_BYTES} bytes`);
  }
  return data;
}

export class PlaywrightInteractiveBrowser implements InteractiveBrowserPort {
  readonly engineVersion = 'playwright-interactive-1';

  async execute(input: Parameters<InteractiveBrowserPort['execute']>[0]): ReturnType<InteractiveBrowserPort['execute']> {
    if (!ScopePolicy.decide(input.scope, input.targetUrl).allowed) {
      throw new Error('interactive browser target is out of scope');
    }
    if (input.steps.length === 0 || input.steps.length > 20) {
      throw new Error('interactive browser plan must contain between 1 and 20 steps');
    }
    input.signal?.throwIfAborted();
    const maxRequests = input.maxRequests ?? 256;
    const maxDurationMs = input.maxDurationMs ?? 60_000;
    if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 10000 || !Number.isFinite(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 300_000) throw new Error('invalid interactive browser limits');
    const playwright = await import('playwright');
    const browser = await playwright.chromium.launch();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let lastStatus: number | null = null;
    let lastHeaders: readonly (readonly [string, string])[] = [];
    const startedAt = Date.now();
    let requests = 0;
    const abort = () => { void context.close().catch(() => undefined); };
    const timer = setTimeout(abort, maxDurationMs);
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          await route.continue();
          return;
        }
        if (!input.signal?.aborted && Date.now() - startedAt < maxDurationMs && requests < maxRequests && ScopePolicy.decide(input.scope, url).allowed) { requests++; await route.continue(); }
        else await route.abort('blockedbyclient');
      });
      await context.routeWebSocket(/.*/, async (webSocket) => {
        const scopeUrl = webSocket.url().replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
        if (ScopePolicy.decide(input.scope, scopeUrl).allowed) webSocket.connectToServer();
        else await webSocket.close({ code: 1008, reason: 'blocked by scope' });
      });
      const sessionCookies = input.browserSession?.cookies ?? input.sessionCookies ?? [];
      if (sessionCookies.length > 0) {
        await context.addCookies(sessionCookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
        })));
      }
      const sessionOrigins = input.browserSession?.origins ?? [];
      if (sessionOrigins.length > 0) {
        await context.addInitScript(({ origins }) => {
          const current = origins.find((entry) => entry.origin === globalThis.location.origin);
          if (current === undefined) return;
          for (const entry of current.localStorage) globalThis.localStorage.setItem(entry.name, entry.value);
          for (const entry of current.sessionStorage) globalThis.sessionStorage.setItem(entry.name, entry.value);
        }, { origins: sessionOrigins });
      }
      await context.addInitScript(() => {
        const routes: { url: string; source: 'history' | 'hash' }[] = [];
        Object.defineProperty(globalThis, '__scopepilotRoutes', { value: routes });
        const record = (source: 'history' | 'hash') => { if (routes.length < 128) routes.push({ url: location.href, source }); };
        for (const method of ['pushState', 'replaceState'] as const) {
          const original = history[method].bind(history);
          history[method] = (...args) => { original(...args); record('history'); };
        }
        addEventListener('hashchange', () => record('hash'));
        addEventListener('popstate', () => record('history'));
      });
      const page = await context.newPage();
      const observedRequests: ObservedHttpRequest[] = [];
      page.on('request', (request) => {
        if (observedRequests.length >= 256 || !ScopePolicy.decide(input.scope, request.url()).allowed) return;
        observedRequests.push({ requestId: `workflow-${observedRequests.length + 1}`, url: sanitiseObservationUrl(request.url()), method: request.method(), resourceType: request.resourceType(), sourceUrl: sanitiseObservationUrl(input.targetUrl), inputPoints: requestInputPoints(request) });
      });
      page.on('response', (response) => {
        if (!response.request().isNavigationRequest() || response.frame() !== page.mainFrame()) return;
        lastStatus = response.status();
        void response.allHeaders().then((headers) => {
          lastHeaders = Object.entries(headers);
        }).catch(() => undefined);
      });
      const files = new Map((input.files ?? []).map((file) => [file.inputRef, file]));
      const assertions: { kind: 'assert' | 'assertValue'; target: string; passed: boolean }[] = [];
      for (const step of input.steps) {
        input.signal?.throwIfAborted();
        if (requests >= maxRequests || Date.now() - startedAt >= maxDurationMs) throw new Error('interactive browser budget exhausted');
        if (step.kind === 'navigate') {
          if (!ScopePolicy.decide(input.scope, step.target).allowed) throw new Error(`interactive navigation is out of scope: ${step.target}`);
          const response = await page.goto(step.target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          lastStatus = response?.status() ?? null;
          lastHeaders = response === null ? [] : Object.entries(await response.allHeaders());
        } else if (step.kind === 'fill') {
          await page.fill(step.target, step.value);
        } else if (step.kind === 'select') {
          await page.selectOption(step.target, step.value);
        } else if (step.kind === 'click') {
          await page.click(step.target);
        } else if (step.kind === 'wait') {
          await page.waitForSelector(step.target, { timeout: 10_000 });
        } else if (step.kind === 'assert') {
          assertions.push({ kind: 'assert', target: step.target, passed: await page.locator(`text=${step.target}`).count() > 0 });
        } else if (step.kind === 'assertValue') {
          assertions.push({ kind: 'assertValue', target: step.target, passed: await page.inputValue(step.target) === step.value });
        } else if (step.kind === 'upload') {
          const file = files.get(step.inputRef);
          if (file === undefined) throw new Error(`interactive upload input is missing: ${step.inputRef}`);
          await page.locator(step.target).setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: decodeFile(file) });
        }
      }
      await page.waitForLoadState('networkidle', { timeout: 1000 }).catch(() => undefined);
      const routes = await page.evaluate(() => (globalThis as unknown as { __scopepilotRoutes?: { url: string; source: 'history' | 'hash' }[] }).__scopepilotRoutes ?? []);
      const clientRoutes = routes.filter((route) => ScopePolicy.decide(input.scope, route.url).allowed).map((route) => ({ ...route, url: sanitiseObservationUrl(route.url) }));
      const body = await page.content();
      const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 1024 * 1024);
      return {
        finalUrl: sanitiseObservationUrl(page.url()),
        observedRequests,
        clientRoutes,
        status: lastStatus,
        bodyHash: createHash('sha256').update(body, 'utf8').digest('hex'),
        bodyText,
        headers: lastHeaders,
        elapsedMs: Date.now() - startedAt,
        assertions,
      };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      await context.close();
      await browser.close();
    }
  }
}
