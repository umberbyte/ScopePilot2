import { isStaticReference, readStaticAsset } from './static-assets.ts';
/**
 * Playwright explorer adapter。`docs/detailed-design/f08-browser-exploration.md`。
 * 実 adapter は browser context の request interception で scope を強制する
 * (Enforced — design/22 の経路別線引きで、ScopePilot 自身が発する通信だけ送信前拒否を保証)。
 *
 * playwright は activation 時に動的 import する (fixture 利用時・bundle 時に依存しない)。
 * browser launcher は差し替え可能で、契約テストは stub context で行う
 * (実 browser での結合は実環境での確認項目)。
 */
import type { BrowserSessionState, ExplorationControl, ExplorationPort, LoginSessionCookie } from '@scopepilot2/core';
import type { ObservedHttpRequest, PageObservation, RequestInputPoint } from '@scopepilot2/contracts';
import { analyzeClientAsset, discoveryFingerprint, allowedTextAsset, extractAssetReferences, MAX_ASSET_BYTES, validateComponentDatabase, ScopePolicy, type ComponentDatabase } from '@scopepilot2/core';
import type { Request as PlaywrightRequest, Response as PlaywrightResponse } from 'playwright';

/** テスト差替え用の最小 browser 面 (playwright の該当部分に対応)。 */
export interface StubBrowserContext {
  /** session cookie を指定した観測 (observeWithSession 経由)。差替え実装は引数を無視できる。 */
  newPage(session?: BrowserSessionState, control?: ExplorationControl): Promise<StubPage>;
  /** payload 実行検証 (dialog・console 監視付きで URL を開く)。実装は検証結果だけを返す。 */
  verifyExecution?(url: string, session?: BrowserSessionState): Promise<{ executed: boolean; signals: readonly string[] }>;
  close(): Promise<void>;
}

export interface StubPage {
  goto(url: string): Promise<{ status(): number; headers(): Record<string, string> } | null>;
  /** Wait briefly for SPA rendering and initial API calls. */
  settle?(): Promise<void>;
  /** Current main-frame URL after redirects or client-side routing. */
  url?(): string;
  title(): Promise<string>;
  $$eval(selector: string, fn: (elements: readonly unknown[]) => readonly unknown[]): Promise<readonly unknown[]>;
  observedRequests?(): readonly ObservedHttpRequest[];
  /**
   * Identifier-like values from same-origin JSON responses observed while
   * rendering (API XHR/fetch bodies and JSON navigations). Response bodies
   * themselves must not be retained or returned.
   */
  observedResourceIds?(): Promise<readonly string[]>;
  /** Already-loaded JavaScript response bodies. Reading these must not issue another request. */
  scriptSources?(): Promise<readonly string[]>;
  observedAssets?(): Promise<Pick<PageObservation, 'assets' | 'discoveryLinks' | 'contentFingerprint' | 'serviceWorkerRegistrations'>>;
  clientRoutes?(): Promise<NonNullable<PageObservation['clientRoutes']>>;
  close(): Promise<void>;
}

export type BrowserLauncher = () => Promise<StubBrowserContext>;

/** browser context へ事前設定する cookie (playwright addCookies 形式の部分)。 */
export type BrowserCookie = LoginSessionCookie;

const MAX_SINGLE_SCRIPT_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_SCRIPT_SOURCE_BYTES = 24 * 1024 * 1024;
const MAX_SCRIPT_ROUTE_CANDIDATES = 512;
const MAX_PAGE_RESOURCE_IDS = 256;
const MAX_SINGLE_API_BODY_BYTES = 512 * 1024;
const MAX_TOTAL_API_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURED_API_RESPONSES = 64;
const MAX_JSON_TRAVERSAL_NODES = 4096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTE_PARAM_SEGMENT_PATTERN = /^:[A-Za-z][\w-]*$/;

/**
 * Extract client-side route literals from already-loaded application scripts.
 *
 * This is deliberately limited to route-related syntax used by common SPA
 * routers. It does not retain script bodies or turn arbitrary strings into
 * crawl targets. Literals with `:param` segments are reported as templates:
 * they are never navigated as-is, only instantiated with observed resource
 * ids by the exploration core.
 */
export interface ScriptRouteLiterals {
  /** Navigable same-origin URLs without parameter segments. */
  readonly candidates: readonly string[];
  /** Same-origin route templates with `:param` segments (not navigable as-is). */
  readonly templates: readonly string[];
}

export function extractScriptRouteLiterals(source: string, pageUrl: string): ScriptRouteLiterals {
  const rawCandidates: string[] = [];
  const patterns = [
    /\b(?:path|route|redirectTo)\s*:\s*(["'`])([^"'`\\\r\n]{1,256})\1/g,
    /\b(?:routerLink|routerlink|navigate|navigateByUrl)\s*(?:\(|:|=)\s*(?:\[\s*)?(["'`])([^"'`\\\r\n]{1,256})\1/g,
    /["'`](?:routerLink|routerlink|path|route|redirectTo)["'`]\s*[, :]\s*(["'`])([^"'`\\\r\n]{1,256})\1/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = match[2];
      if (value !== undefined) rawCandidates.push(value);
      if (rawCandidates.length >= MAX_SCRIPT_ROUTE_CANDIDATES) break;
    }
    if (rawCandidates.length >= MAX_SCRIPT_ROUTE_CANDIDATES) break;
  }

  const origin = new URL(pageUrl).origin;
  const candidates = new Set<string>();
  const templates = new Set<string>();
  for (const candidate of rawCandidates) {
    const value = candidate.trim().replaceAll('\\/', '/');
    if (value === '' || value === '**' || /^(?:path|route|redirectTo|routerLink|navigate|navigateByUrl)$/i.test(value)) continue;
    if (/[*{}$]/.test(value)) continue;
    if (!/^[\w./#?&=%:~-]+$/u.test(value)) continue;
    if (/\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)(?:[?#]|$)/i.test(value)) continue;
    // ':' は :param セグメントだけに許す (URL scheme 等を含む文字列は候補化しない)。
    const segments = value.split('/');
    if (segments.some((segment) => segment.includes(':') && !ROUTE_PARAM_SEGMENT_PATTERN.test(segment.replace(/[?#].*$/, '')))) continue;
    try {
      const absolute = value.startsWith('/')
        ? new URL(value, origin).href
        : new URL(`/${value}`, origin).href;
      const parsedAbsolute = new URL(absolute);
      if (parsedAbsolute.origin !== origin) continue;
      const paramSegments = parsedAbsolute.pathname.split('/').filter((segment) => ROUTE_PARAM_SEGMENT_PATTERN.test(segment));
      if (paramSegments.length === 0) {
        candidates.add(absolute);
      } else if (paramSegments.length <= 3) {
        templates.add(absolute);
      }
    } catch {
      // Ignore malformed literals from minified or generated sources.
    }
    if (candidates.size + templates.size >= MAX_SCRIPT_ROUTE_CANDIDATES) break;
  }
  return { candidates: [...candidates], templates: [...templates] };
}

/**
 * Conservative identifier shape used to ground dynamic route instantiation:
 * short numerics and UUIDs only. Free text, slugs and token-like values are
 * deliberately excluded so observed values cannot smuggle content into URLs.
 */
export function looksLikeResourceIdentifier(value: string): boolean {
  return /^\d{1,18}$/.test(value) || UUID_PATTERN.test(value);
}

const HTTP_METHODS_IN_SCRIPTS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const MAX_SCRIPT_API_CALLS = 256;

/**
 * Extract HTTP API call definitions from already-loaded application scripts.
 *
 * Two generalized shapes are recognised (minified bundles keep string and
 * template literals intact):
 * 1. Direct call with a path literal in the first argument expression:
 *    `.post(this.hostServer + \`/rest/user/login\`, ...)`
 * 2. Service-base pairing: a base path assigned via string concatenation
 *    (`host = this.hostServer + \`/api/Feedbacks\``) paired with the HTTP
 *    verbs used against that base until the next base assignment.
 *
 * Only same-origin absolute URLs with plausible path literals are returned.
 * Script bodies are not retained. This is how write APIs (POST/PUT/PATCH/
 * DELETE), which never fire during browse-only crawling, become diagnosable.
 */
export function extractScriptApiCalls(source: string, pageUrl: string): readonly { url: string; method: string }[] {
  const origin = new URL(pageUrl).origin;
  const results = new Set<string>();
  const add = (method: string, literal: string): void => {
    if (results.size >= MAX_SCRIPT_API_CALLS) return;
    const value = literal.trim().replaceAll('\\/', '/');
    if (!value.startsWith('/') || value === '/' || value.length > 200) return;
    if (!/^[\w./#?&=%:{}-]+$/u.test(value)) return;
    if (/\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)(?:[?#]|$)/i.test(value)) return;
    try {
      const absolute = new URL(value, origin).href;
      if (new URL(absolute).origin !== origin) return;
      results.add(`${method.toUpperCase()} ${absolute}`);
    } catch {
      // Ignore malformed literals.
    }
  };

  // 1. 直接呼び出し: 第一引数式の中にパスリテラルを含む HTTP 動詞呼び出し。
  const directPattern = /\.(get|post|put|patch|delete)\(\s*[^,()]{0,80}?["'`](\/[\w./#?&=%:{}-]{1,150})["'`]/g;
  for (const match of source.matchAll(directPattern)) {
    add(match[1]!, match[2]!);
  }

  // 2. サービス基底ペアリング: 文字列連結で代入された基底パスと、
  //    次の基底代入までの間に使われている HTTP 動詞を組にする。
  const basePattern = /["'`](\/[A-Za-z0-9_][\w./-]{1,120})["'`]/g;
  const bases: { readonly end: number; readonly path: string }[] = [];
  for (const match of source.matchAll(basePattern)) {
    const before = source.slice(Math.max(0, match.index - 40), match.index);
    if (/=\s*[A-Za-z_$][\w$.]*\s*\+\s*$/.test(before)) {
      bases.push({ end: (match.index ?? 0) + match[0].length, path: match[1]! });
    }
  }
  for (let index = 0; index < bases.length && results.size < MAX_SCRIPT_API_CALLS; index += 1) {
    const base = bases[index]!;
    const windowEnd = index + 1 < bases.length ? bases[index + 1]!.end : Math.min(base.end + 8000, source.length);
    const window = source.slice(base.end, windowEnd);
    for (const method of HTTP_METHODS_IN_SCRIPTS) {
      if (window.includes(`.${method}(`)) add(method, base.path);
    }
  }

  return [...results].map((key) => {
    const separator = key.indexOf(' ');
    return { method: key.slice(0, separator), url: key.slice(separator + 1) };
  });
}

/** JSON keys whose scalar values are treated as resource identifiers. */
function isIdentifierKey(key: string): boolean {
  if (key === 'id' || key === 'uuid') return true;
  if (/(?:^|[_.-])(?:id|uuid)$/i.test(key)) return true;
  return /^[a-z][A-Za-z0-9]*(?:Id|ID)$/.test(key);
}

/**
 * Collect identifier-like values from a parsed same-origin JSON payload.
 * Values are kept only when both the key looks like an identifier field and
 * the value matches the conservative identifier shape. The payload itself is
 * never retained.
 */
export function extractResourceIdsFromJson(value: unknown): readonly string[] {
  const ids = new Set<string>();
  let visited = 0;
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || visited >= MAX_JSON_TRAVERSAL_NODES || ids.size >= MAX_PAGE_RESOURCE_IDS) return;
    visited += 1;
    if (Array.isArray(node)) {
      for (const entry of node) {
        if (visited >= MAX_JSON_TRAVERSAL_NODES) break;
        walk(entry, depth + 1);
      }
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (isIdentifierKey(key)) {
          if (typeof child === 'string' && looksLikeResourceIdentifier(child)) {
            ids.add(child);
            continue;
          }
          if (typeof child === 'number' && Number.isInteger(child) && child >= 0 && Object.is(child, -0) === false) {
            ids.add(String(child));
            continue;
          }
        }
        walk(child, depth + 1);
      }
    }
  };
  walk(value, 0);
  return [...ids];
}

/** Identifier-like path segments of a request URL (query values are excluded). */
export function extractResourceIdsFromUrlSegments(url: string): readonly string[] {
  try {
    return new URL(url).pathname.split('/').filter((segment) => looksLikeResourceIdentifier(segment));
  } catch {
    return [];
  }
}

const RESPONSE_BODY_DEADLINE_MS = 3_000;
const CAPTURE_SETTLE_DEADLINE_MS = 10_000;

/**
 * playwright の response.body() は、対象が応答本文を返し切らない (streaming・
 * chunked 継続中など) 場合に永久に解決しないことがある。識別子・スクリプトの
 * 観測は他のページ観測で補えるため、応答ごとに短い期限で諦め、探索全体を
 * 止めない (design/22: 停止可能性の保証)。
 */
function withResponseBodyDeadline<T>(body: Promise<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), RESPONSE_BODY_DEADLINE_MS);
    body.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** settle 待ち全体にも上限を設け、 capture task の滞留が観測を固めないようにする。 */
async function withCaptureDeadline(tasks: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([tasks.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, CAPTURE_SETTLE_DEADLINE_MS); })]);
  } finally { clearTimeout(timer); }
}

/** 既定 launcher: playwright を動的 import して chromium を起動する。 */
export function requestInputPoints(request: PlaywrightRequest): readonly RequestInputPoint[] {
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

const createDefaultLauncher = (
  fixedCookies: readonly BrowserCookie[] | undefined,
  proxyServer: string | undefined,
  requestAllowed: (url: string) => boolean,
  database?: ComponentDatabase,
): BrowserLauncher => {
  return async () => {
    const playwright = await import('playwright');
    const browser = await playwright.chromium.launch(proxyServer === undefined ? {} : { proxy: { server: proxyServer } });
    const newScopedContext = async (control?: ExplorationControl) => {
      const context = await browser.newContext(proxyServer === undefined
        ? { serviceWorkers: 'block' }
        : { ignoreHTTPSErrors: true, serviceWorkers: 'block' });
      await context.route('**/*', async (route) => {
        const requestUrl = route.request().url();
        // blob:/data: and other browser-local resources do not cause network
        // egress. HTTP(S) requests, including redirects and subresources, must
        // pass the current case scope before the browser sends them.
        if (!/^https?:/i.test(requestUrl) || (requestAllowed(requestUrl) && !control?.signal?.aborted && (control?.consumeRequest() ?? true))) {
          await route.continue();
        } else {
          await route.abort('blockedbyclient');
        }
      });
      await context.routeWebSocket(/.*/, async (webSocket) => {
        // ScopePolicy is expressed in HTTP(S) origins. A WebSocket opened by
        // an allowed HTTP(S) page belongs to the equivalent WS(S) origin.
        const scopeUrl = webSocket.url()
          .replace(/^ws:/i, 'http:')
          .replace(/^wss:/i, 'https:');
        if (requestAllowed(scopeUrl) && !control?.signal?.aborted && (control?.consumeRequest() ?? true)) {
          webSocket.connectToServer();
        } else {
          await webSocket.close({ code: 1008, reason: 'blocked by scope' });
        }
      });
      return context;
    };
    return {
      newPage: async (session?: BrowserSessionState, control?: ExplorationControl) => {
        // ZAP 等の自前 proxy を通る HTTPS は proxy のルート CA で再署名される。
        // fresh な browser context はその CA を信頼しないため、明示的に proxy を
        // 指定した観測に限り証明書検証を免除する (対象・経路は我々の管理内)。
        const context = await newScopedContext(control);
        // 構成時 cookie と呼出時 cookie (runLogin で得た session) を context へ注入する。
        const cookies = [...(fixedCookies ?? []), ...(session?.cookies ?? [])];
        if (cookies.length > 0) {
          await context.addCookies(cookies.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
            ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
            ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
            ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
          })));
        }
        if ((session?.origins.length ?? 0) > 0) {
          await context.addInitScript((origins) => {
            const state = origins.find((candidate) => candidate.origin === globalThis.location.origin);
            if (state === undefined) return;
            for (const entry of state.localStorage) globalThis.localStorage.setItem(entry.name, entry.value);
            for (const entry of state.sessionStorage) globalThis.sessionStorage.setItem(entry.name, entry.value);
          }, session!.origins);
        }
        await context.addInitScript(() => {
          const workers: string[] = [];
          Object.defineProperty(globalThis, '__scopepilotWorkers', { value: workers });
          if (navigator.serviceWorker) {
            const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
            navigator.serviceWorker.register = (url, options) => {
              if (workers.length < 32) workers.push(new URL(String(url), location.href).href);
              return register(url, options);
            };
          }
          const routes: { url: string; source: 'history' | 'hash' }[] = [];
          Object.defineProperty(globalThis, '__scopepilotRoutes', { value: routes });
          const record = (source: 'history' | 'hash') => {
            if (routes.length < 128) routes.push({ url: location.href, source });
          };
          for (const method of ['pushState', 'replaceState'] as const) {
            const original = history[method].bind(history);
            history[method] = (...args) => { original(...args); record('history'); };
          }
          addEventListener('hashchange', () => record('hash'));
          addEventListener('popstate', () => record('history'));
        });
        const page = await context.newPage();
        const abort = () => { void context.close().catch(() => undefined); };
        control?.signal?.addEventListener('abort', abort, { once: true });
        if (control?.signal?.aborted) abort();
        const timeout = control ? setTimeout(abort, control.timeoutMs) : undefined;
        const requests: ObservedHttpRequest[] = [];
        const scriptSources: string[] = [];
        const assets = new Map<string, NonNullable<PageObservation['assets']>[number]>();
        const discoveryLinks: { url: string; source: string }[] = [];
        const assetTasks = new Set<Promise<void>>();
        let assetBytesReserved = 0;
        let assetCount = 0;
        let contentFingerprint: string | undefined;
        const captureAsset = (response: PlaywrightResponse): void => {
          const sourceUrl = page.url();
          const url = response.url();
          const contentType = response.headers()['content-type'] ?? '';
          if (assetCount >= 32 || assets.has(url) || response.status() >= 400 || !allowedTextAsset(url, contentType)) return;
          if (new URL(url).origin !== new URL(sourceUrl).origin) return;
          const declared = Number(response.headers()['content-length']);
          if (!response.headers()['content-length'] || declared > MAX_ASSET_BYTES || assetBytesReserved + MAX_ASSET_BYTES > 8 * MAX_ASSET_BYTES) return;
          assetCount++;
          assetBytesReserved += MAX_ASSET_BYTES;
          const task = withResponseBodyDeadline(response.body()).then((body) => {
            if (!body || body.byteLength > MAX_ASSET_BYTES) return;
            const text = body.toString('utf8');
            const asset = analyzeClientAsset({ url, sourceUrl, contentType, body: text, observedTokens: [...(session?.cookies ?? []).map((cookie) => cookie.value), ...(session?.origins ?? []).flatMap((origin) => [...origin.localStorage, ...origin.sessionStorage].map((entry) => entry.value)), ...(session?.headers ?? []).map((header) => header.value.replace(/^Bearer /i, ''))].slice(0, 128), headers: response.headers(), ...(database ? { database } : {}) });
            if (!asset) return;
            assets.set(url, asset);
            discoveryLinks.push(...extractAssetReferences(text, url));
            if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) contentFingerprint = discoveryFingerprint(text, url);
          }).catch(() => undefined).then(() => undefined);
          assetTasks.add(task);
          void task.finally(() => assetTasks.delete(task));
        };
        const scriptCaptureTasks = new Set<Promise<void>>();
        let capturedScriptBytes = 0;
        const captureRequest = (request: PlaywrightRequest): void => {
          if (requests.length >= 2048 || !ScopePolicy.decide({ allowedOrigins: [new URL(page.url()).origin], deniedOrigins: [] }, request.url()).allowed) return;
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
        // 同一Originの JSON 応答から識別子様の値だけをメモリ内で収集する。本文は保持しない。
        const capturedJsonIds: { readonly url: string; readonly ids: readonly string[] }[] = [];
        let capturedApiBytes = 0;
        let capturedApiResponses = 0;
        const bodyCaptureTasks = new Set<Promise<void>>();
        const captureJsonIds = async (response: PlaywrightResponse): Promise<void> => {
          const contentType = response.headers()['content-type'] ?? '';
          if (!/application\/(?:[\w.+-]*\+)?json/i.test(contentType)) return;
          if (capturedApiResponses >= MAX_CAPTURED_API_RESPONSES) return;
          const declaredLength = Number.parseInt(response.headers()['content-length'] ?? '', 10);
          if (Number.isFinite(declaredLength) && declaredLength > MAX_SINGLE_API_BODY_BYTES) return;
          // Streaming/.chunked 応答では body() が返らないことがある。識別子観測は
          // 他の観測機会で補えるため、応答ごとに短い期限で諦めて探索を止めない。
          const body = await withResponseBodyDeadline(response.body());
          if (body === null || body.byteLength === 0 || body.byteLength > MAX_SINGLE_API_BODY_BYTES) return;
          if (capturedApiBytes + body.byteLength > MAX_TOTAL_API_BODY_BYTES) return;
          capturedApiBytes += body.byteLength;
          capturedApiResponses += 1;
          try {
            const ids = extractResourceIdsFromJson(JSON.parse(body.toString('utf8')) as unknown);
            if (ids.length > 0) capturedJsonIds.push({ url: response.url(), ids });
          } catch {
            // Not JSON or malformed: nothing to extract.
          }
        };
        const captureScriptResponse = (response: PlaywrightResponse): void => {
          if (response.request().resourceType() !== 'script' || new URL(response.url()).origin !== new URL(page.url()).origin) return;
          const declaredLength = Number.parseInt(response.headers()['content-length'] ?? '', 10);
          if (Number.isFinite(declaredLength) && declaredLength > MAX_SINGLE_SCRIPT_SOURCE_BYTES) return;
          const task = withResponseBodyDeadline(response.body()).then((body) => {
            if (body === null) return;
            if (body.byteLength > MAX_SINGLE_SCRIPT_SOURCE_BYTES) return;
            if (capturedScriptBytes + body.byteLength > MAX_TOTAL_SCRIPT_SOURCE_BYTES) return;
            capturedScriptBytes += body.byteLength;
            scriptSources.push(body.toString('utf8'));
          }).catch(() => undefined).then(() => undefined);
          scriptCaptureTasks.add(task);
          void task.finally(() => scriptCaptureTasks.delete(task));
        };
        const captureApiResponse = (response: PlaywrightResponse): void => {
          const resourceType = response.request().resourceType();
          if (resourceType !== 'xhr' && resourceType !== 'fetch') return;
          const task = captureJsonIds(response).then(() => undefined);
          bodyCaptureTasks.add(task);
          void task.finally(() => bodyCaptureTasks.delete(task));
        };
        page.on('request', captureRequest);
        page.on('response', captureAsset);
        page.on('response', captureScriptResponse);
        page.on('response', captureApiResponse);
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
              const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
              // JSON 文書への直接 navigation も識別子の観測源になる (例: API URL への直接遷移)。
              if (response !== null) {
                const task = captureJsonIds(response).then(() => undefined);
                bodyCaptureTasks.add(task);
                void task.finally(() => bodyCaptureTasks.delete(task));
              }
              return response;
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
          settle: async () => {
            await page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => undefined);
            await withCaptureDeadline(Promise.all([...scriptCaptureTasks, ...bodyCaptureTasks, ...assetTasks]));
          },
          url: () => page.url(),
          title: async () => await page.title(),
          $$eval: async (selector: string, fn: (elements: readonly unknown[]) => readonly unknown[]): Promise<readonly unknown[]> =>
            await page.$$eval(selector, fn as never) as readonly unknown[],
          observedRequests: () => [...requests],
          observedResourceIds: async () => {
            await Promise.all([...bodyCaptureTasks]);
            const pageOrigin = new URL(page.url()).origin;
            const ids = new Set<string>();
            for (const captured of capturedJsonIds) {
              if (new URL(captured.url).origin !== pageOrigin) continue;
              for (const id of captured.ids) {
                if (ids.size >= MAX_PAGE_RESOURCE_IDS) return [...ids];
                ids.add(id);
              }
            }
            return [...ids];
          },
          scriptSources: async () => {
            await Promise.all([...scriptCaptureTasks]);
            return [...scriptSources];
          },
          observedAssets: async () => {
            await withCaptureDeadline(Promise.all([...assetTasks]));
            const workerRegistrations = await page.evaluate(() => (globalThis as unknown as { __scopepilotWorkers?: string[] }).__scopepilotWorkers ?? []);
            return { assets: [...assets.values()], serviceWorkerRegistrations: workerRegistrations.filter((url) => new URL(url).origin === new URL(page.url()).origin).map((url) => ({ url, status: 'attempted' as const })), discoveryLinks: discoveryLinks.slice(0, 256), ...(contentFingerprint ? { contentFingerprint } : {}) };
          },
          clientRoutes: async () => await page.evaluate(() => {
            return (globalThis as unknown as { __scopepilotRoutes?: { url: string; source: 'history' | 'hash' }[] }).__scopepilotRoutes ?? [];
          }),
          close: async () => {
            clearTimeout(timeout);
            control?.signal?.removeEventListener('abort', abort);
            page.off('response', captureAsset);
            page.off('request', captureRequest);
            page.off('response', captureScriptResponse);
            page.off('response', captureApiResponse);
            await context.close();
          },
        } satisfies StubPage;
      },
      close: async () => {
        await browser.close();
      },
      verifyExecution: async (url: string, session?: BrowserSessionState) => {
        // 検証専用 page: dialog は自動で dismiss しつつ種別と文言 (先頭のみ) を記録する。
        const context = await newScopedContext();
        const cookies = [...(fixedCookies ?? []), ...(session?.cookies ?? [])];
        if (cookies.length > 0) {
          await context.addCookies(cookies.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
            ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
            ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
            ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
          })));
        }
        if ((session?.origins.length ?? 0) > 0) {
          await context.addInitScript((origins) => {
            const state = origins.find((candidate) => candidate.origin === globalThis.location.origin);
            if (state === undefined) return;
            for (const entry of state.localStorage) globalThis.localStorage.setItem(entry.name, entry.value);
            for (const entry of state.sessionStorage) globalThis.sessionStorage.setItem(entry.name, entry.value);
          }, session!.origins);
        }
        const page = await context.newPage();
        const signals: string[] = [];
        page.on('dialog', async (dialog) => {
          signals.push(`dialog:${dialog.type()} ${dialog.message().slice(0, 80)}`.trimEnd());
          await dialog.dismiss().catch(() => undefined);
        });
        page.on('pageerror', (error) => {
          signals.push(`pageerror ${error.message.slice(0, 80)}`);
        });
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
          await page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => undefined);
          // 遅延発火 (setTimeout 系 payload) ための短期間の追加観測。
          await page.waitForTimeout(750);
          const executed = signals.some((signal) => signal.startsWith('dialog:'));
          return { executed, signals: signals.slice(0, 16) };
        } finally {
          await context.close();
        }
      },
    };
  };
};

export interface PlaywrightExplorerOptions {
  readonly scope: { readonly allowedOrigins: readonly string[]; readonly deniedOrigins: readonly string[] };
  readonly launcher?: BrowserLauncher;
  readonly componentDatabase?: ComponentDatabase;
  /** 認証済み session の cookie。既定 launcher でのみ使う (差替え launcher は自前で扱う)。 */
  readonly cookies?: readonly BrowserCookie[];
  /** Route exploration through ZAP so authenticated browser traffic seeds its site tree. */
  readonly proxyServer?: string;
  /**
   * ZAP 等の proxy が保持する旧 active session を、認証 cookie の送信前に解除する。
   * 解除失敗時は匿名状態で探索を続けず、そのまま失敗させる。
   */
  readonly beforeSessionObservation?: (url: string) => Promise<void>;
}

function isDownloadNavigationError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /download is starting/i.test(message);
}

/**
 * 実対象には一時的に到達できない URL・証明書検証に失敗する経路が混ざる。
 * 1 件の navigation 失敗で探索全体を落とさず、status 0 の観測として記録して
 * 続行する (design/22: 停止可能性は保証しつつ観測は欠落させない)。
 * 実装ミス (TypeError 等) は握りつぶさずそのまま throw する。
 */
function isRecoverableNavigationError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /net::ERR_|navigation failed because|target closed|timeout .*exceeded/i.test(message);
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

function navigationFailureObservation(url: string): PageObservation {
  return {
    url,
    status: 0,
    contentType: 'application/x-navigation-failure',
    discoveredFrom: null,
    depth: 0,
    originType: 'crawl',
    links: [],
    forms: [],
  };
}

/**
 * ページ観測で得た識別子様の値を 1 つにまとめる。観測源は (1) launcher が
 * メモリ内解析した同一Origin JSON 応答、(2) scope 許可済みリクエスト URL の
 * パス要素。どちらも「対象が実際に返した値」だけで、推測値を含まない。
 */
async function collectObservedResourceIds(
  page: StubPage,
  scopeAllowedRequests?: readonly ObservedHttpRequest[],
): Promise<readonly string[]> {
  const ids = new Set<string>();
  for (const id of await page.observedResourceIds?.() ?? []) {
    if (looksLikeResourceIdentifier(id)) ids.add(id);
    if (ids.size >= MAX_PAGE_RESOURCE_IDS) return [...ids];
  }
  const requests = scopeAllowedRequests ?? (page.observedRequests?.() ?? []);
  for (const request of requests) {
    for (const segment of extractResourceIdsFromUrlSegments(request.url)) {
      if (ids.size >= MAX_PAGE_RESOURCE_IDS) return [...ids];
      ids.add(segment);
    }
  }
  return [...ids];
}

export class PlaywrightExplorerAdapter implements ExplorationPort {
  readonly engineVersion = 'playwright-chromium';
  private scope: PlaywrightExplorerOptions['scope'];
  private readonly launcher: BrowserLauncher;
  private readonly staticReader: boolean;
  private readonly database: ComponentDatabase | undefined;
  private readonly beforeSessionObservation: ((url: string) => Promise<void>) | undefined;
  /**
   * ZAP の active HTTP session 解除は同じ login session / origin につき一度でよい。
   * URL ごとに実行すると crawl 中に同じ ZAP API を数百回呼び、ZAP が混雑した際に
   * AbortError (timeout) で正常な探索結果を失う。WeakMap にして cookie 値自体は保持・
   * 記録せず、新しい login が新しい cookie 配列を渡した時は改めて解除する。
   */
  private readonly preparedSessionOrigins = new WeakMap<BrowserSessionState, Set<string>>();
  private contextPromise: Promise<StubBrowserContext> | null = null;
  private resolvedVersion = 'playwright (未起動)';

  constructor(options: PlaywrightExplorerOptions) {
    this.scope = options.scope;
    this.staticReader = options.launcher === undefined && options.proxyServer === undefined;
    this.database = options.componentDatabase ? structuredClone(options.componentDatabase) : undefined;
    if (options.componentDatabase) validateComponentDatabase(options.componentDatabase);
    this.launcher = options.launcher ?? createDefaultLauncher(
      options.cookies,
      options.proxyServer,
      (url) => ScopePolicy.decide(this.scope, url).allowed,
      this.database,
    );
    this.beforeSessionObservation = options.beforeSessionObservation;
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

  async observe(url: string, control?: ExplorationControl): Promise<PageObservation | null> {
    return await this.observeInternal(url, undefined, control);
  }

  /**
   * 認証済み session での観測 (design/f09 の探索経路)。cookie は呼出ごとに context へ
   * 注入し、adapter 自身には保持しない。scope 強制は observe と同じ入口で行う (Enforced)。
   */
  async observeWithSession(
    url: string,
    session: BrowserSessionState,
    control?: ExplorationControl,
  ): Promise<PageObservation | null> {
    return await this.observeInternal(url, session, control);
  }

  /**
   * 検証用 URL (payload 付き) を実 browser で開き、攻撃コードの実行を観測する。
   * scope 強制は観測と同じ入口で行う (Enforced: 送信前拒否)。
   */
  async verifyPayloadExecution(
    url: string,
    session?: BrowserSessionState,
  ): Promise<{ executed: boolean; signals: readonly string[] }> {
    if (!ScopePolicy.decide(this.scope, url).allowed) {
      throw new Error(`payload execution verification denied by scope: ${url}`);
    }
    const context = await this.ensureContext();
    if (context.verifyExecution === undefined) {
      throw new Error('configured browser context does not support payload execution verification');
    }
    return await context.verifyExecution(url, session);
  }

  private async observeInternal(url: string, sessionState: BrowserSessionState | undefined, control?: ExplorationControl): Promise<PageObservation | null> {
    // scope 強制は経路の入口でも行う (Enforced: ここは送信前)。
    if (!ScopePolicy.decide(this.scope, url).allowed) {
      return null;
    }
    if (this.staticReader && sessionState === undefined && isStaticReference(url)) {
      try {
        return await readStaticAsset({ url, scope: this.scope, ...(control ? { control } : {}), ...(this.database ? { database: this.database } : {}), analyseScript: (body, assetUrl) => ({ links: extractScriptRouteLiterals(body, assetUrl).candidates, routeTemplates: extractScriptRouteLiterals(body, assetUrl).templates, scriptApiCalls: extractScriptApiCalls(body, assetUrl) }) });
      } catch (cause) {
        if (control?.signal?.aborted || cause instanceof TypeError || (cause instanceof Error && /abort|timeout/i.test(cause.name))) return navigationFailureObservation(url);
        throw cause;
      }
    }
    if (sessionState !== undefined) {
      // ZAP の HTTP Sessions add-on は active session の cookie を上書き注入する。
      // login executor から受け取った最新 cookie が優先されるよう、送信前に解除する。
      const origin = new URL(url).origin;
      let preparedOrigins = this.preparedSessionOrigins.get(sessionState);
      if (preparedOrigins === undefined) {
        preparedOrigins = new Set<string>();
        this.preparedSessionOrigins.set(sessionState, preparedOrigins);
      }
      if (!preparedOrigins.has(origin)) {
        await this.beforeSessionObservation?.(origin);
        // 失敗時は記録しない。次回の観測で安全準備を再試行できるようにする。
        preparedOrigins.add(origin);
      }
    }
    const context = await this.ensureContext();
    const page = await context.newPage(sessionState, control);
    try {
      const response = await page.goto(url);
      if (response === null) {
        return null;
      }
      await page.settle?.();
      const finalUrl = page.url?.() ?? url;
      const status = response.status();
      const assetObservation = await page.observedAssets?.() ?? {};
      const clientRoutes = (await page.clientRoutes?.() ?? []).filter((route) => ScopePolicy.decide(this.scope, route.url).allowed);
      const contentType = response.headers()['content-type'] ?? 'application/octet-stream';
      const scopeAllowedRequests = (page.observedRequests?.() ?? []).filter((request) => ScopePolicy.decide(this.scope, request.url).allowed);
      if (status >= 400 || !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
        // エラー応答と非HTML応答は観測として記録するが、DOM解析は行わない。
        // 識別子の観測 (JSON 応答・URL セグメント) は解析対象外の応答でも行う。
        const errorPageResourceIds = await collectObservedResourceIds(page, scopeAllowedRequests);
        return {
          url,
          finalUrl,
          status,
          contentType,
          discoveredFrom: null,
          depth: 0,
          originType: 'crawl',
          ...assetObservation,
          links: [],
          ...(errorPageResourceIds.length === 0 ? {} : { observedResourceIds: errorPageResourceIds }),
          forms: [],
        };
      }
      const title = await page.title();
      const links = await page.$$eval(
        'a[href], area[href], [role="link"][href], [data-href], [data-to], [routerlink]',
        (elements) => elements.map((candidate) => {
          const element = candidate as Element;
          const raw = element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement
            ? element.href
            : element.getAttribute('href')
              ?? element.getAttribute('data-href')
              ?? element.getAttribute('data-to')
              ?? element.getAttribute('routerlink')
              ?? '';
          if (raw === '' || raw.trim().toLowerCase().startsWith('javascript:')) return '';
          try {
            return new URL(raw, globalThis.location.href).href;
          } catch {
            return '';
          }
        }),
      );
      const staticReferences = await page.$$eval('script[src], link[rel="manifest"]', (elements) => elements.map((candidate) => {
        const element = candidate as Element;
        return new URL(element.getAttribute('src') ?? element.getAttribute('href') ?? '', location.href).href;
      }));
      const scriptAnalysis = (await page.scriptSources?.() ?? [])
        .reduce((accumulated: { candidates: string[]; templates: string[]; apiCalls: { url: string; method: string }[] }, source) => {
          const extracted = extractScriptRouteLiterals(source, finalUrl);
          accumulated.candidates.push(...extracted.candidates);
          accumulated.templates.push(...extracted.templates);
          accumulated.apiCalls.push(...extractScriptApiCalls(source, finalUrl));
          return accumulated;
        }, { candidates: [], templates: [], apiCalls: [] });
      const scriptApiCallMap = new Map<string, { url: string; method: string }>();
      for (const call of scriptAnalysis.apiCalls) {
        scriptApiCallMap.set(`${call.method} ${call.url}`, call);
      }
      const scriptApiCalls = [...scriptApiCallMap.values()];
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
      const resourceIds = await collectObservedResourceIds(page, scopeAllowedRequests);
      return {
        url,
        finalUrl,
        status,
        contentType,
        ...(title === '' ? {} : { title }),
        discoveredFrom: null,
        depth: 0,
        originType: 'crawl',
        ...assetObservation,
        clientRoutes,
        links: [...new Set([
          ...(staticReferences as string[]).filter((value) => ScopePolicy.decide(this.scope, value).allowed),
          ...clientRoutes.map((route) => route.url),
          ...(links as readonly string[]).filter((link) => link.startsWith('http://') || link.startsWith('https://')),
          ...scriptAnalysis.candidates,
        ])],
        ...(scriptAnalysis.templates.length === 0 ? {} : { routeTemplates: [...new Set(scriptAnalysis.templates)] }),
        ...(scriptApiCalls.length === 0 ? {} : { scriptApiCalls }),
        ...(resourceIds.length === 0 ? {} : { observedResourceIds: resourceIds }),
        forms: forms as PageObservation['forms'],
        requests: scopeAllowedRequests,
        ...(javascriptSignals === undefined ? {} : { javascriptSignals }),
      };
    } catch (cause) {
      if (isDownloadNavigationError(cause)) {
        return downloadObservation(url);
      }
      if (isRecoverableNavigationError(cause)) {
        return navigationFailureObservation(url);
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
