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
import type { ObservedHttpRequest, PageObservation, RequestInputPoint } from '@scopepilot2/contracts';
import { ScopePolicy } from '@scopepilot2/core';
import type { Request as PlaywrightRequest, Response as PlaywrightResponse } from 'playwright';

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
  observedRequests?(): readonly ObservedHttpRequest[];
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
function requestInputPoints(request: PlaywrightRequest): readonly RequestInputPoint[] {
  const parsed = new URL(request.url());
  const points: RequestInputPoint[] = [...new Set(parsed.searchParams.keys())].map((name) => ({ name, location: 'query', type: 'string' }));
  const postData = request.postData() ?? '';
  const contentType = request.headers()['content-type'] ?? '';
  if (postData !== '') {
    if (/application\/x-www-form-urlencoded/i.test(contentType)) {
      for (const name of new Set(new URLSearchParams(postData).keys())) points.push({ name, location: 'body', type: 'string' });
    } else if (/multipart\/form-data/i.test(contentType)) {
      const names = [...postData.matchAll(/\bname="([^"]+)"/g)].map((match) => match[1]).filter((name): name is string => name !== undefined);
      for (const name of new Set(names)) points.push({ name, location: 'file', type: 'multipart' });
    } else if (/application\/(?:[\w.+-]*\+)?json/i.test(contentType)) {
      try {
        const value = JSON.parse(postData) as unknown;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          for (const name of Object.keys(value)) points.push({ name, location: 'body', type: 'json' });
        }
      } catch {
        points.push({ name: '$body', location: 'body', type: 'json' });
      }
    } else {
      points.push({ name: '$body', location: 'body', type: contentType || 'opaque' });
    }
  }
  return points;
}

const createDefaultLauncher = (fixedCookies?: readonly BrowserCookie[], proxyServer?: string): BrowserLauncher => {
  return async () => {
    const playwright = await import('playwright');
    const browser = await playwright.chromium.launch(proxyServer === undefined ? {} : { proxy: { server: proxyServer } });
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
        const requests: ObservedHttpRequest[] = [];
        const captureRequest = (request: PlaywrightRequest): void => {
          const method = request.method().toUpperCase();
          requests.push({
            requestId: `browser-${String(requests.length + 1).padStart(6, '0')}`,
            url: request.url(),
            method,
            resourceType: request.resourceType(),
            ...(request.headers()['content-type'] === undefined ? {} : { contentType: request.headers()['content-type'] }),
            inputPoints: requestInputPoints(request),
            sourceUrl: page.url() || request.url(),
          });
        };
        page.on('request', captureRequest);
        return {
          goto: async (url: string) => {
            let navigationResponse: PlaywrightResponse | null = null;
            const captureNavigationResponse = (response: PlaywrightResponse): void => {
              if (response.frame() === page.mainFrame() && response.request().isNavigationRequest()) {
                navigationResponse = response;
              }
            };
            page.on('response', captureNavigationResponse);
            try {
              return await page.goto(url, { waitUntil: 'domcontentloaded' });
            } catch (cause) {
              // Chromium turns Content-Disposition: attachment into a download and
              // page.goto rejects even though an HTTP response was received.
              if (isDownloadNavigationError(cause) && navigationResponse !== null) {
                const captured = navigationResponse as PlaywrightResponse;
                return {
                  status: () => captured.status(),
                  headers: () => captured.headers(),
                };
              }
              throw cause;
            } finally {
              page.off('response', captureNavigationResponse);
            }
          },
          title: async () => await page.title(),
          $$eval: async (selector: string, fn: (elements: readonly unknown[]) => readonly unknown[]): Promise<readonly unknown[]> =>
            await page.$$eval(selector, fn as never) as readonly unknown[],
          observedRequests: () => [...requests],
          close: async () => {
            page.off('request', captureRequest);
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
  /** Route exploration through ZAP so authenticated browser traffic seeds its site tree. */
  readonly proxyServer?: string;
}

function isDownloadNavigationError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /download is starting/i.test(message);
}

function downloadObservation(url: string): PageObservation {
  return {
    url,
    // Playwright does not expose a navigation Response when the response is
    // converted into a download. The server accepted the request, so retain
    // the URL as a non-HTML observation instead of aborting the entire crawl.
    status: 0,
    contentType: 'application/octet-stream',
    discoveredFrom: null,
    depth: 0,
    originType: 'crawl',
    links: [],
    forms: [],
  };
}

export class PlaywrightExplorerAdapter implements ExplorationPort {
  readonly engineVersion = 'playwright-chromium';
  private scope: PlaywrightExplorerOptions['scope'];
  private readonly launcher: BrowserLauncher;
  private contextPromise: Promise<StubBrowserContext> | null = null;
  private resolvedVersion = 'playwright (未起動)';

  constructor(options: PlaywrightExplorerOptions) {
    this.scope = options.scope;
    this.launcher = options.launcher ?? createDefaultLauncher(options.cookies, options.proxyServer);
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
      const contentType = response.headers()['content-type'] ?? 'application/octet-stream';
      if (status >= 400 || !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
        // エラー応答と非HTML応答は観測として記録するが、DOM解析は行わない。
        return {
          url,
          status,
          contentType,
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
      const javascriptSignalRows = await page.$$eval('*', (elements) => {
        let scriptElements = 0;
        let inlineEventHandlers = 0;
        let javascriptUrls = 0;
        for (const candidate of elements) {
          const element = candidate as Element;
          if (element.tagName.toLowerCase() === 'script') {
            const type = element.getAttribute('type')?.trim().toLowerCase() ?? '';
            if (type === '' || type === 'module' || type.includes('javascript') || type.includes('ecmascript')) scriptElements += 1;
          }
          for (const attribute of Array.from(element.attributes)) {
            if (attribute.name.toLowerCase().startsWith('on') && attribute.value.trim() !== '') inlineEventHandlers += 1;
            if ((attribute.name.toLowerCase() === 'href' || attribute.name.toLowerCase() === 'src')
              && attribute.value.trim().toLowerCase().startsWith('javascript:')) javascriptUrls += 1;
          }
        }
        return [{ scriptElements, inlineEventHandlers, javascriptUrls }];
      });
      const javascriptSignals = javascriptSignalRows[0] as PageObservation['javascriptSignals'] | undefined;
      const observedRequests = (page.observedRequests?.() ?? []).filter((request) => ScopePolicy.decide(this.scope, request.url).allowed);
      return {
        url,
        status,
        contentType,
        ...(title === '' ? {} : { title }),
        discoveredFrom: null,
        depth: 0,
        originType: 'crawl',
        links: (links as readonly string[]).filter((link) => link.startsWith('http://') || link.startsWith('https://')),
        forms: forms as PageObservation['forms'],
        requests: observedRequests,
        ...(javascriptSignals === undefined ? {} : { javascriptSignals }),
      };
    } catch (cause) {
      if (isDownloadNavigationError(cause)) {
        return downloadObservation(url);
      }
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
