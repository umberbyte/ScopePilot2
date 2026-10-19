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
  newPage(): Promise<StubPage>;
  close(): Promise<void>;
}

export interface StubPage {
  goto(url: string): Promise<{ status(): number; headers(): Record<string, string> } | null>;
  title(): Promise<string>;
  $$eval(selector: string, fn: (elements: readonly unknown[]) => readonly string[]): Promise<readonly string[]>;
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
const createDefaultLauncher = (cookies?: readonly BrowserCookie[]): BrowserLauncher => {
  return async () => {
    const playwright = await import('playwright');
    const browser = await playwright.chromium.launch();
    return {
      newPage: async () => {
        const context = await browser.newContext();
        if (cookies !== undefined && cookies.length > 0) {
          // 認証済み session (design/f09) を探索に使う: cookie は context 単位で注入する。
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
          $$eval: async (selector: string, fn: (elements: readonly unknown[]) => readonly string[]) =>
            await page.$$eval(selector, fn as never),
          close: async () => {
            await page.close();
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
  readonly engineVersion = 'playwright (未起動)';
  private readonly scope: PlaywrightExplorerOptions['scope'];
  private readonly launcher: BrowserLauncher;
  private contextPromise: Promise<StubBrowserContext> | null = null;
  private resolvedVersion = 'playwright (未起動)';

  constructor(options: PlaywrightExplorerOptions) {
    this.scope = options.scope;
    this.launcher = options.launcher ?? createDefaultLauncher(options.cookies);
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
    // scope 強制は経路の入口でも行う (Enforced: ここは送信前)。
    if (!ScopePolicy.decide(this.scope, url).allowed) {
      return null;
    }
    const context = await this.ensureContext();
    const page = await context.newPage();
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
      return {
        url,
        status,
        contentType: response.headers()['content-type'] ?? 'application/octet-stream',
        ...(title === '' ? {} : { title }),
        discoveredFrom: null,
        depth: 0,
        originType: 'crawl',
        links: links.filter((link) => link.startsWith('http://') || link.startsWith('https://')),
        forms: [],
      };
    } catch {
      // navigation 失敗 (接続拒否・timeout 等) は観測なしとして扱う。
      return null;
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
