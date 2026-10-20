/**
 * Playwright explorer adapter。`docs/detailed-design/f08-browser-exploration.md`。
 * 実 adapter は browser context の request interception で scope を強制する
 * (Enforced — design/22 の経路別線引きで、ScopePilot 自身が発する通信だけ送信前拒否を保証)。
 *
 * playwright は activation 時に動的 import する (fixture 利用時・bundle 時に依存しない)。
 * browser launcher は差し替え可能で、契約テストは stub context で行う
 * (実 browser での結合は実環境での確認項目)。
 */
import type { ExplorationPort } from '@scopepilot2/core';
import type { PageObservation } from '@scopepilot2/contracts';
import { ScopePolicy } from '@scopepilot2/core';

/** テスト差替え用の最小 browser 面 (playwright の該当部分に対応)。 */
export interface StubBrowserContext {
  /** session cookie を指定した観測 (observeWithSession 経由)。差替え実装は引数を無視できる。 */
  newPage(cookies?: readonly BrowserCookie[]): Promise<StubPage>;
  close(): Promise<void>;
}

export interface StubPage {
  goto(url: string): Promise<{ status(): number; headers(): Record<string, string> } | null>;
  title(): Promise<string>;
  $$eval(selector: string, fn: (elements: readonly unknown[]) => readonly unknown[]): Promise<readonly unknown[]>;
  close(): Promise<void>;
}

export type BrowserLauncher = () => Promise<StubBrowserContext>;

/** browser context へ事前設定する cookie (playwright addCookies 形式の部分)。 */
export interface BrowserCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
}

/** 既定 launcher: playwright を動的 import して chromium を起動する。 */
const createDefaultLauncher = (fixedCookies?: readonly BrowserCookie[]): BrowserLauncher => {
  return async () => {
    const playwright = await import('playwright');
    const browser = await playwright.chromium.launch();
    return {
      newPage: async (perCallCookies?: readonly BrowserCookie[]) => {
        const context = await browser.newContext();
        // 構成時 cookie と呼出時 cookie (runLogin で得た session) を context へ注入する。
        const cookies = [...(fixedCookies ?? []), ...(perCallCookies ?? [])];
        if (cookies.length > 0) {
          await context.addCookies(cookies.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
            ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
          })));
        }
        const page = await context.newPage();
        return {
          goto: async (url: string) => await page.goto(url, { waitUntil: 'domcontentloaded' }),
          title: async () => await page.title(),
          $$eval: async (selector: string, fn: (elements: readonly unknown[]) => readonly unknown[]): Promise<readonly unknown[]> =>
            await page.$$eval(selector, fn as never) as readonly unknown[],
          close: async () => {
            await context.close();
          },
        } satisfies StubPage;
      },
      close: async () => {
        await browser.close();
      },
    };
  };
};

export interface PlaywrightExplorerOptions {
  readonly scope: { readonly allowedOrigins: readonly string[]; readonly deniedOrigins: readonly string[] };
  readonly launcher?: BrowserLauncher;
  /** 認証済み session の cookie。既定 launcher でのみ使う (差替え launcher は自前で扱う)。 */
  readonly cookies?: readonly BrowserCookie[];
}

export class PlaywrightExplorerAdapter implements ExplorationPort {
  readonly engineVersion = 'playwright-chromium';
  private scope: PlaywrightExplorerOptions['scope'];
  private readonly launcher: BrowserLauncher;
  private contextPromise: Promise<StubBrowserContext> | null = null;
  private resolvedVersion = 'playwright (未起動)';

  constructor(options: PlaywrightExplorerOptions) {
    this.scope = options.scope;
    this.launcher = options.launcher ?? createDefaultLauncher(options.cookies);
  }

  /** 案件の作成・切替時に、送信前強制へ使う scope を更新する。 */
  updateScope(scope: PlaywrightExplorerOptions['scope']): void {
    this.scope = {
      allowedOrigins: [...new Set(scope.allowedOrigins.map((origin) => new URL(origin).origin))],
      deniedOrigins: [...new Set(scope.deniedOrigins.map((origin) => new URL(origin).origin))],
    };
  }

  private ensureContext(): Promise<StubBrowserContext> {
    if (this.contextPromise === null) {
      this.contextPromise = this.launcher().then(async (context) => {
        this.resolvedVersion = 'playwright-chromium';
        return context;
      });
    }
    return this.contextPromise;
  }

  /** 実 browser を使う場合の版表示 (未起動ならその旨)。 */
  get engineVersionLabel(): string {
    return this.resolvedVersion;
  }

  async observe(url: string): Promise<PageObservation | null> {
    return await this.observeInternal(url, undefined);
  }

  /**
   * 認証済み session での観測 (design/f09 の探索経路)。cookie は呼出ごとに context へ
   * 注入し、adapter 自身には保持しない。scope 強制は observe と同じ入口で行う (Enforced)。
   */
  async observeWithSession(
    url: string,
    session: { readonly cookies: readonly { readonly name: string; readonly value: string; readonly domain: string; readonly path: string }[] },
  ): Promise<PageObservation | null> {
    return await this.observeInternal(url, session.cookies);
  }

  private async observeInternal(url: string, sessionCookies: readonly BrowserCookie[] | undefined): Promise<PageObservation | null> {
    // scope 強制は経路の入口でも行う (Enforced: ここは送信前)。
    if (!ScopePolicy.decide(this.scope, url).allowed) {
      return null;
    }
    const context = await this.ensureContext();
    const page = await context.newPage(sessionCookies);
    try {
      const response = await page.goto(url);
      if (response === null) {
        return null;
      }
      const status = response.status();
      if (status >= 400) {
        // 観測としては記録するが page 解析 (link 抽出) は行わない。
        return {
          url,
          status,
          contentType: response.headers()['content-type'] ?? 'application/octet-stream',
          discoveredFrom: null,
          depth: 0,
          originType: 'crawl',
          links: [],
          forms: [],
        };
      }
      const title = await page.title();
      const links = await page.$$eval('a[href]', (anchors) =>
        anchors.map((anchor) => {
          const href = (anchor as HTMLAnchorElement).href;
          return typeof href === 'string' ? href : '';
        }),
      );
      const forms = await page.$$eval('form', (elements) => elements.map((element) => {
        const form = element as HTMLFormElement;
        const fields = Array.from(form.elements)
          .filter((field): field is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
            field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)
          .map((field) => ({ name: field.name, type: field instanceof HTMLInputElement ? field.type : field.tagName.toLowerCase() }))
          .filter((field) => field.name !== '');
        const fieldTypes = fields.map((field) => field.type.toLowerCase());
        const method = (form.method || 'GET').toUpperCase();
        const classification = fieldTypes.includes('password')
          ? 'login'
          : method !== 'GET'
            ? 'data-write'
            : fields.some((field) => /^(q|query|search|keyword)$/i.test(field.name))
              ? 'search'
              : fields.length > 0 ? 'filter' : 'unknown';
        return { actionUrl: form.action || location.href, method, fields, classification };
      }));
      return {
        url,
        status,
        contentType: response.headers()['content-type'] ?? 'application/octet-stream',
        ...(title === '' ? {} : { title }),
        discoveredFrom: null,
        depth: 0,
        originType: 'crawl',
        links: (links as readonly string[]).filter((link) => link.startsWith('http://') || link.startsWith('https://')),
        forms: forms as PageObservation['forms'],
      };
    } catch (cause) {
      throw new Error(`Playwright exploration failed for ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    if (this.contextPromise !== null) {
      const context = await this.contextPromise;
      await context.close();
      this.contextPromise = null;
    }
  }
}
