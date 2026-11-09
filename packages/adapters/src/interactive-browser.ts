import { createHash } from 'node:crypto';
import { ScopePolicy, type InteractiveBrowserFile, type InteractiveBrowserPort } from '@scopepilot2/core';

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
    const playwright = await import('playwright');
    const browser = await playwright.chromium.launch();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let lastStatus: number | null = null;
    let lastHeaders: readonly (readonly [string, string])[] = [];
    const startedAt = Date.now();
    try {
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          await route.continue();
          return;
        }
        if (ScopePolicy.decide(input.scope, url).allowed) await route.continue();
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
      const page = await context.newPage();
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
      const body = await page.content();
      const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 1024 * 1024);
      return {
        finalUrl: page.url(),
        status: lastStatus,
        bodyHash: createHash('sha256').update(body, 'utf8').digest('hex'),
        bodyText,
        headers: lastHeaders,
        elapsedMs: Date.now() - startedAt,
        assertions,
      };
    } finally {
      await context.close();
      await browser.close();
    }
  }
}
