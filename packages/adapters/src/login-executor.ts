/**
 * browser 駆動の login 実行器 (design/f09)。`docs/detailed-design/f09-authentication-session.md` §4。
 *
 * f09 の step DSL (navigate / fill / click / wait / extract / assert) を実 browser で
 * 実行し、認証状態と session cookie を返す。秘密値 (secretValues) は実行中のみ
 * 使い、応答・log に出さない。fill の secretReference は secretValues の key として
 * 解決する (extract で変数化した値も同じ key 空間で参照できる)。
 *
 * CSRF token 等の hidden 項目は form submit 時に browser が現在値を自動送付する
 * (実測: DVWA login は token の再取得不要)。認証後の cookie は scan adapter へ
 * 明示的に渡す。proxyServer は高度な画面から明示指定された場合のみ利用する。
 */
import type { LoginExecutionInput, LoginExecutionResult, LoginExecutorPort, LoginSessionCookie } from '@scopepilot2/core';
import { detectAuthState } from '@scopepilot2/core';
import type { LoginFlowStep } from '@scopepilot2/core';

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
  close(): Promise<void>;
}

export interface StubLoginBrowser {
  newPage(options: { readonly proxyServer?: string; readonly bypass?: string }): Promise<StubLoginPage>;
  close(): Promise<void>;
}

export type LoginBrowserLauncher = () => Promise<StubLoginBrowser>;

const defaultLauncher: LoginBrowserLauncher = async () => {
  const playwright = await import('playwright');
  const browser = await playwright.chromium.launch();
  return {
    newPage: async ({ proxyServer }: { readonly proxyServer?: string }) => {
      const context = await browser.newContext(
        proxyServer === undefined ? {} : { proxy: { server: proxyServer } },
      );
      const page = await context.newPage();
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
          // Register the navigation waiter before clicking. DVWA can update the
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
        cookies: async () =>
          (await context.cookies()).map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
          })),
        close: async () => {
          await page.close();
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
      // proxy 経由にするため bypass 除外の特殊規則 <-loopback> を渡す (DVWA 等
      // 非 loopback 対象では影響しない)。
      input.proxyServer === undefined ? {} : { proxyServer: input.proxyServer, bypass: '<-loopback>' },
    );
    try {
      const variables = new Map<string, string>();
      let assertResult = true;
      let sawAssert = false;
      for (const step of input.steps) {
        await this.runStep(step, input, variables, page);
        if (step.kind === 'assert') {
          sawAssert = true;
          const marker = step.target ?? '';
          const content = await page.content();
          if (marker !== '' && !content.includes(marker)) {
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
      return {
        authenticated,
        finalUrl,
        cookies: [...(await page.cookies())],
      };
    } finally {
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
