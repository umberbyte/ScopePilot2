/**
 * browser 駆動の login 実行器 (design/f09)。`docs/detailed-design/f09-authentication-session.md` §4。
 *
 * f09 の step DSL (navigate / fill / click / wait / extract / assert) を実 browser で
 * 実行し、認証状態と session cookie を返す。秘密値 (secretValues) は実行中のみ
 * 使い、応答・log に出さない。fill の secretReference は secretValues の key として
 * 解決する (extract で変数化した値も同じ key 空間で参照できる)。
 *
 * CSRF token 等の hidden 項目は form submit 時に browser が現在値を自動送付する
 * 対象ごとのlogin flowを実行する。認証後の cookie は scan adapter へ
 * 明示的に渡す。proxyServer は高度な画面から明示指定された場合のみ利用する。
 */
import type { BrowserSessionHeader, BrowserSessionState, LoginExecutionInput, LoginExecutionResult, LoginExecutorPort, LoginSessionCookie } from '@scopepilot2/core';
import type { ObservedHttpRequest } from '@scopepilot2/contracts';
import { detectAuthState } from '@scopepilot2/core';
import type { LoginFlowStep } from '@scopepilot2/core';
import { enforceAuthenticationContext } from './authentication-context.ts';
import { requestInputPoints } from './playwright-explorer.ts';

/** テスト差替え用の最小 browser 面 (playwright の該当部分に対応)。 */
export interface StubLoginPage {
  goto(url: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  selectOption(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitFor(selector: string, timeoutMs: number): Promise<void>;
  inputValue(selector: string): Promise<string>;
  content(): Promise<string>;
  url(): string;
  cookies(): Promise<readonly LoginSessionCookie[]>;
  browserState?(): Promise<BrowserSessionState>;
  /** login 実行中に観測したリクエスト (入力点の名前のみ。値は含まない)。 */
  observedRequests?(): readonly ObservedHttpRequest[];
  close(): Promise<void>;
}

export interface StubLoginBrowser {
  newPage(options: { readonly proxyServer?: string; readonly bypass?: string; readonly scope?: LoginExecutionInput['scope'] }): Promise<StubLoginPage>;
  close(): Promise<void>;
}

export type LoginBrowserLauncher = () => Promise<StubLoginBrowser>;

const defaultLauncher: LoginBrowserLauncher = async () => {
  const playwright = await import('playwright');
  const browser = await playwright.chromium.launch();
  return {
    newPage: async ({ proxyServer, scope }: { readonly proxyServer?: string; readonly scope?: LoginExecutionInput['scope'] }) => {
      const context = await browser.newContext(
        { serviceWorkers: 'block', ...(proxyServer === undefined ? {} : { proxy: { server: proxyServer, bypass: '<-loopback>' } }) },
      );
      const page = await context.newPage();
      if (scope !== undefined) await enforceAuthenticationContext(context, page, scope);
      const requests: ObservedHttpRequest[] = [];
      const sessionHeaders = new Map<string, BrowserSessionHeader>();
      const headerCaptureTasks: Promise<void>[] = [];
      const captureRequest = (request: import('playwright').Request): void => {
        const requestUrl = request.url();
        requests.push({
          requestId: `login-${String(requests.length + 1).padStart(6, '0')}`,
          url: requestUrl,
          method: request.method().toUpperCase(),
          resourceType: request.resourceType(),
          ...(request.headers()['content-type'] === undefined ? {} : { contentType: request.headers()['content-type'] }),
          inputPoints: requestInputPoints(request),
          sourceUrl: page.url() || request.url(),
        });
        // Capture only the standard Authorization header and only when the
        // request destination matches the page's current origin. Chromium's
        // allHeaders() is required because headers() can omit security-related
        // fields. The value remains in the in-memory browser state.
        const capture = request.allHeaders().then((headers) => {
          const value = headers['authorization'];
          if (value === undefined || value.trim() === '' || /[\r\n]/u.test(value)) return;
          try {
            const origin = new URL(requestUrl).origin;
            const pageUrl = page.url();
            if (!/^https?:/u.test(pageUrl) || new URL(pageUrl).origin !== origin) return;
            sessionHeaders.set(`${origin}\u0000authorization`, { origin, name: 'Authorization', value });
          } catch {
            // Non-HTTP requests are irrelevant to HTTP diagnostics.
          }
        }).catch(() => undefined);
        headerCaptureTasks.push(capture);
      };
      page.on('request', captureRequest);
      return {
        goto: async (url: string) => {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
        },
        fill: async (selector: string, value: string) => {
          await page.fill(selector, value);
        },
        selectOption: async (selector: string, value: string) => {
          await page.selectOption(selector, value);
        },
        click: async (selector: string) => {
          // Register the navigation waiter before clicking. A target can update the
          // URL before the new document body is ready, which otherwise makes
          // the following authentication assertion race the response render.
          const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => null);
          await page.click(selector);
          await navigation;
        },
        waitFor: async (selector: string, timeoutMs: number) => {
          await page.waitForSelector(selector, { timeout: timeoutMs });
        },
        inputValue: async (selector: string) => await page.inputValue(selector),
        content: async () => await page.content(),
        url: () => page.url(),
        observedRequests: () => [...requests],
        cookies: async () =>
          (await context.cookies()).map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: cookie.expires,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookie.sameSite,
          })),
        browserState: async () => {
          await Promise.allSettled(headerCaptureTasks);
          const stored = await context.storageState();
          const currentUrl = new URL(page.url());
          const currentStorage = await page.evaluate(() => ({
            localStorage: Array.from({ length: globalThis.localStorage.length }, (_, index) => {
              const name = globalThis.localStorage.key(index) ?? '';
              return { name, value: globalThis.localStorage.getItem(name) ?? '' };
            }).filter((entry) => entry.name !== ''),
            sessionStorage: Array.from({ length: globalThis.sessionStorage.length }, (_, index) => {
              const name = globalThis.sessionStorage.key(index) ?? '';
              return { name, value: globalThis.sessionStorage.getItem(name) ?? '' };
            }).filter((entry) => entry.name !== ''),
          }));
          const origins = stored.origins.map((origin) => ({
            origin: origin.origin,
            localStorage: origin.origin === currentUrl.origin ? currentStorage.localStorage : origin.localStorage,
            sessionStorage: origin.origin === currentUrl.origin ? currentStorage.sessionStorage : [],
          }));
          if (!origins.some((origin) => origin.origin === currentUrl.origin)) {
            origins.push({ origin: currentUrl.origin, ...currentStorage });
          }
          return {
            cookies: stored.cookies.map((cookie) => ({
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
              expires: cookie.expires,
              httpOnly: cookie.httpOnly,
              secure: cookie.secure,
              sameSite: cookie.sameSite,
            })),
            origins,
            ...(sessionHeaders.size === 0 ? {} : { headers: [...sessionHeaders.values()] }),
          };
        },
        close: async () => {
          await context.close();
        },
      } satisfies StubLoginPage;
    },
    close: async () => {
      await browser.close();
    },
  };
};

function resolveUrl(baseUrl: string, target: string): string {
  if (target.startsWith('http://') || target.startsWith('https://')) {
    return target;
  }
  return `${baseUrl.replace(/\/$/, '')}${target.startsWith('/') ? '' : '/'}${target}`;
}

export class PlaywrightLoginExecutor implements LoginExecutorPort {
  readonly engineVersion = 'playwright-login-1';
  private readonly launcher: LoginBrowserLauncher;
  private browserPromise: Promise<StubLoginBrowser> | null = null;

  constructor(options: { readonly launcher?: LoginBrowserLauncher } = {}) {
    this.launcher = options.launcher ?? defaultLauncher;
  }

  private ensureBrowser(): Promise<StubLoginBrowser> {
    if (this.browserPromise === null) {
      this.browserPromise = this.launcher();
    }
    return this.browserPromise;
  }

  async execute(input: LoginExecutionInput): Promise<LoginExecutionResult> {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage(
      // Chromium は既定で localhost を proxy bypass する。loopback の所有ターゲットも
      // proxy 経由にするため bypass 除外の特殊規則 <-loopback> を渡す (loopback上の
      // 非 loopback 対象では影響しない)。
      { ...(input.scope === undefined ? {} : { scope: input.scope }), ...(input.proxyServer === undefined ? {} : { proxyServer: input.proxyServer, bypass: '<-loopback>' }) },
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const executeFlow = async (): Promise<LoginExecutionResult> => {
      const variables = new Map<string, string>();
      let assertResult = true;
      let sawAssert = false;
      for (const step of input.steps) {
        await this.runStep(step, input, variables, page);
        if (step.kind === 'assert') {
          sawAssert = true;
          const marker = step.target ?? '';
          const content = await page.content();
          if (marker.trim() === '' || !content.includes(marker)) {
            assertResult = false;
            // The remaining steps are post-login actions. Continuing after a
            // failed authentication assertion obscures the real cause with an
            // unrelated selector timeout on the destination page.
            break;
          }
        }
        if (step.kind === 'assertValue') {
          sawAssert = true;
          const actualValue = await page.inputValue(step.target ?? '');
          if (actualValue !== step.value) {
            assertResult = false;
            break;
          }
        }
      }
      const finalUrl = page.url();
      const authenticated =
        detectAuthState({
          expectedUrlPrefix: input.expectedUrlPrefix,
          finalUrl,
          // assert step が無い場合は marker 検査で判断しない (F09-UT-002: URL 一致だけでは認証済みとしない)。
          assertResult: sawAssert ? assertResult : false,
        }) === 'authenticated';
      const browserState = await page.browserState?.() ?? { cookies: [...(await page.cookies())], origins: [] };
      // 観測は対象の base URL と同一 Origin に限定する (第三者通信を候補化しない)。
      const baseOrigin = new URL(input.baseUrl).origin;
      const observedRequests = (page.observedRequests?.() ?? [])
        .filter((request) => {
          try {
            return new URL(request.url).origin === baseOrigin;
          } catch {
            return false;
          }
        });
      return {
        authenticated,
        finalUrl,
        cookies: browserState.cookies,
        browserState,
        ...(observedRequests.length === 0 ? {} : { observedRequests }),
      };
    };
    try {
      return await Promise.race([executeFlow(), new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('login flow exceeded 60000 ms deadline')), 60_000);
      })]);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      await page.close();
    }
  }

  private async runStep(
    step: LoginFlowStep,
    input: LoginExecutionInput,
    variables: Map<string, string>,
    page: StubLoginPage,
  ): Promise<void> {
    const target = step.target ?? '';
    switch (step.kind) {
      case 'navigate':
        await page.goto(resolveUrl(input.baseUrl, target));
        return;
      case 'fill': {
        const reference = step.secretReference ?? '';
        const value = variables.get(reference) ?? input.secretValues[reference];
        if (value === undefined) {
          throw new Error(`fill step could not resolve secret reference: ${reference}`);
        }
        await page.fill(target, value);
        return;
      }
      case 'click':
        await page.click(target);
        return;
      case 'select':
        await page.selectOption(target, step.value ?? '');
        return;
      case 'wait':
        await page.waitFor(target, 10_000);
        return;
      case 'extract': {
        const value = await page.inputValue(target);
        variables.set(step.secretReference ?? target, value);
        return;
      }
      case 'assert':
      case 'assertValue':
        return;
    }
  }

  async close(): Promise<void> {
    if (this.browserPromise !== null) {
      const browser = await this.browserPromise;
      await browser.close();
      this.browserPromise = null;
    }
  }
}
