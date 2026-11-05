import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BrowserSessionState } from '@scopepilot2/core';
import type { ObservedHttpRequest } from '@scopepilot2/contracts';
import {
  PlaywrightExplorerAdapter,
  extractResourceIdsFromJson,
  extractResourceIdsFromUrlSegments,
  extractScriptApiCalls,
  extractScriptRouteLiterals,
  type StubBrowserContext,
  type StubPage,
} from '../src/playwright-explorer.ts';

/**
 * Playwright explorer adapter の契約検証。実 browser は使わず、最小面の stub
 * context/page を注入して、scope 強制 (Enforced)・観測写像 (title/link/content-type)・
 * navigation 失敗の扱いを検証する。実 browser との結合は実環境での確認項目。
 */

interface StubResponse {
  status(): number;
  headers(): Record<string, string>;
}

function stubPage(options: {
  url: string;
  status: number;
  contentType: string;
  title: string;
  hrefs: readonly string[];
  finalUrl?: string;
  scriptSources?: readonly string[];
  observedRequests?: readonly ObservedHttpRequest[];
  resourceIds?: readonly string[];
  javascriptSignals?: { scriptElements: number; inlineEventHandlers: number; javascriptUrls: number };
  fail?: boolean;
}): StubPage {
  return {
    goto: async (url: string) => {
      if (options.fail) {
        throw new Error('net::ERR_CONNECTION_REFUSED');
      }
      if (url !== options.url) {
        return null;
      }
      const response: StubResponse = {
        status: () => options.status,
        headers: () => ({ 'content-type': options.contentType }),
      };
      return response;
    },
    settle: async () => undefined,
    url: () => options.finalUrl ?? options.url,
    title: async () => options.title,
    scriptSources: async () => options.scriptSources ?? [],
    observedRequests: () => options.observedRequests ?? [],
    observedResourceIds: async () => options.resourceIds ?? [],
    $$eval: async (selector: string) => selector.includes('a[href]')
      ? [...options.hrefs]
      : selector === '*' && options.javascriptSignals !== undefined
        ? [options.javascriptSignals]
        : [],
    close: async () => undefined,
  };
}

describe('Playwright explorer adapter (stub browser 契約検証)', () => {
  test('scope 内 URL は観測し title・link・content-type を写像する', async () => {
    const page = stubPage({
      url: 'http://fixture.target.test/page',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      title: 'Stub Page',
      hrefs: ['http://fixture.target.test/next', 'javascript:void(0)', 'http://elsewhere.example/x'],
    });
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] },
      launcher: async () => ({
        newPage: async () => page,
        close: async () => undefined,
      }),
    });
    const observation = await adapter.observe('http://fixture.target.test/page');
    assert.notEqual(observation, null);
    assert.equal(observation?.status, 200);
    assert.equal(observation?.title, 'Stub Page');
    assert.equal(observation?.contentType, 'text/html; charset=utf-8');
    assert.equal(observation?.finalUrl, 'http://fixture.target.test/page');
    // http(s) の link だけ残す (javascript: 等は除外。scope 外 link は core 側で拒否記録になる)。
    assert.deepEqual(observation?.links, ['http://fixture.target.test/next', 'http://elsewhere.example/x']);
    await adapter.close();
  });

  test('already-loaded SPA scriptsから静的route定義だけを追加通信なしで抽出する', async () => {
    const page = stubPage({
      url: 'http://fixture.target.test/app',
      status: 200,
      contentType: 'text/html',
      title: 'Compiled SPA',
      hrefs: [],
      scriptSources: [
        'const routes=[{path:"reports"},{path:"admin/users"},{path:"item/:id"},{path:"**"}];',
        'router.navigate(["/settings"]); const asset={path:"logo.svg"};',
        'const attrs=[`mat-list-item`,``,`routerLink`,`privacy-security/privacy-policy`,`aria-label`,`Privacy Policy`];',
      ],
    });
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] },
      launcher: async () => ({ newPage: async () => page, close: async () => undefined }),
    });

    const observation = await adapter.observe('http://fixture.target.test/app');

    assert.deepEqual(observation?.links, [
      'http://fixture.target.test/reports',
      'http://fixture.target.test/admin/users',
      'http://fixture.target.test/settings',
      'http://fixture.target.test/privacy-security/privacy-policy',
    ]);
    // :param 付きルートは巡回候補にならず、テンプレートとしてだけ報告される。
    assert.deepEqual(observation?.routeTemplates, ['http://fixture.target.test/item/:id']);
    await adapter.close();
  });

  test(':param付きルートはテンプレート候補になり、ワイルドカードや外部Originは除外される', () => {
    const { candidates, templates } = extractScriptRouteLiterals(
      'const routes=[{path:"orders/:id/summary"},{path:"a/:id/b/:name"},{path:"x/:p/:q/:r/:s"},{path:"**"},{path:"wild*"},{path:"https://elsewhere.example/x"}];',
      'http://fixture.target.test/app',
    );
    assert.deepEqual(candidates, []);
    assert.deepEqual(templates, [
      'http://fixture.target.test/orders/:id/summary',
      'http://fixture.target.test/a/:id/b/:name',
      // 4パラメータ以上は対象外。
    ]);
  });

  test('JSON応答から識別子様の値だけを抽出する (本文・自由文字列は対象外)', () => {
    const ids = extractResourceIdsFromJson({
      id: 42,
      orderId: '1001',
      user_id: 7,
      uuid: 'c9a4f0de-6b31-4c3f-8e1e-2f2c6b9b0001',
      token: 'eyJhbGciOi.JWT.Bearer',
      name: 'not-an-id',
      items: [{ id: 1 }, { id: '2' }, { title: 'x' }],
      nested: { addressId: 900, note: 'free text' },
    });
    assert.deepEqual([...ids].sort(), [
      '1',
      '1001',
      '2',
      '42',
      '7',
      '900',
      'c9a4f0de-6b31-4c3f-8e1e-2f2c6b9b0001',
    ]);
  });

  test('URLパス要素から識別子様の値だけを抽出する (query・ファイル名は対象外)', () => {
    assert.deepEqual(
      extractResourceIdsFromUrlSegments('http://fixture.target.test/api/orders/42?cursor=abc'),
      ['42'],
    );
    assert.deepEqual(
      extractResourceIdsFromUrlSegments('http://fixture.target.test/assets/app.12345.js'),
      [],
    );
  });

  test('スクリプト内のHTTP呼び出し定義を抽出する (直接呼び出し + サービス基底ペアリング)', () => {
    const source = [
      'class LoginService{ login(e){ return this.http.post(this.hostServer+`/rest/user/login`,e) } }',
      'class FeedbackService{ host=this.hostServer+`/api/Feedbacks`; find(){return this.http.get(this.host+`/`)} save(f){return this.http.post(this.host,f)} del(i){return this.http.delete(this.host+`/`+i)} }',
      'class OrderService{ host=this.hostServer+`/api/Orders`; all(){return this.http.get(this.host)} }',
      'fetch("/rest/noise-free");',
    ].join('\n');
    const calls = extractScriptApiCalls(source, 'http://fixture.target.test/app');
    const pairs = calls.map((call) => `${call.method} ${new URL(call.url).pathname}`).sort();
    // 直接呼び出し
    assert.ok(pairs.includes('POST /rest/user/login'));
    // 基底ペアリング: Feedbacks には get/post/delete があり、Orders には get のみ。
    assert.ok(pairs.includes('POST /api/Feedbacks'));
    assert.ok(pairs.includes('DELETE /api/Feedbacks'));
    assert.ok(pairs.includes('GET /api/Feedbacks'));
    assert.ok(pairs.includes('GET /api/Orders'));
    assert.ok(!pairs.some((pair) => pair.startsWith('POST /api/Orders')), '基底直後の動詞だけを組にする');
    // fetch の単独リテラルは method が不明なため対象外 (GET として拾うのは観測側の役割)。
    assert.ok(!pairs.some((pair) => pair.includes('noise-free')));
  });

  test('スクリプトAPI呼び出し抽出は静的アセットと別Originを除外する', () => {
    const calls = extractScriptApiCalls(
      'this.http.post(this.hostServer+"/assets/logo.svg"); this.http.post("https://elsewhere.example/api/x"); this.http.put(this.hostServer+`/api/Cards`);',
      'http://fixture.target.test/app',
    );
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ['/api/Cards']);
  });

  test('観測結果にスクリプト内API呼び出し定義を載せる (追加通信なし)', async () => {
    const page = stubPage({
      url: 'http://fixture.target.test/app',
      status: 200,
      contentType: 'text/html',
      title: 'Compiled SPA',
      hrefs: [],
      scriptSources: [
        'class S{ host=this.hostServer+`/api/BasketItems`; add(x){return this.http.post(this.host,x)} }',
      ],
    });
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] },
      launcher: async () => ({ newPage: async () => page, close: async () => undefined }),
    });
    const observation = await adapter.observe('http://fixture.target.test/app');
    assert.deepEqual(observation?.scriptApiCalls, [
      { method: 'POST', url: 'http://fixture.target.test/api/BasketItems' },
    ]);
    await adapter.close();
  });

  test('観測した識別子 (JSON応答由来 + リクエストURLセグメント) を観測結果へ載せる', async () => {
    const request = (url: string): ObservedHttpRequest => ({
      requestId: 'browser-000001',
      url,
      method: 'GET',
      resourceType: 'xhr',
      contentType: 'application/json',
      inputPoints: [],
      sourceUrl: 'http://fixture.target.test/app',
    });
    const page = stubPage({
      url: 'http://fixture.target.test/app',
      status: 200,
      contentType: 'text/html',
      title: 'API page',
      hrefs: [],
      resourceIds: ['1001', 'not-an-id-slug'],
      observedRequests: [
        request('http://fixture.target.test/rest/basket/3'),
        request('http://fixture.target.test/api/Quantitys/9'),
        // scope 外リクエストの URL セグメントは観測値に混ぜない。
        request('http://elsewhere.example/api/items/77'),
      ],
    });
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] },
      launcher: async () => ({ newPage: async () => page, close: async () => undefined }),
    });

    const observation = await adapter.observe('http://fixture.target.test/app');

    // page 由来の値も識別子形状で検査され、自由文字列 (not-an-id-slug) は除外される。
    assert.deepEqual(observation?.observedResourceIds, ['1001', '3', '9']);
    await adapter.close();
  });

  test('JavaScript実行要素を本文なしの件数として観測する', async () => {
    const page = stubPage({
      url: 'http://fixture.target.test/client',
      status: 200,
      contentType: 'text/html',
      title: 'Client page',
      hrefs: [],
      javascriptSignals: { scriptElements: 2, inlineEventHandlers: 1, javascriptUrls: 1 },
    });
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] },
      launcher: async () => ({ newPage: async () => page, close: async () => undefined }),
    });
    const observation = await adapter.observe('http://fixture.target.test/client');
    assert.deepEqual(observation?.javascriptSignals, { scriptElements: 2, inlineEventHandlers: 1, javascriptUrls: 1 });
    await adapter.close();
  });

  test('scope 外 URL は送信前に拒否 (Enforced: null を返し page を開かない)', async () => {
    let pagesCreated = 0;
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] },
      launcher: async () => ({
        newPage: async () => {
          pagesCreated += 1;
          return stubPage({ url: 'x', status: 200, contentType: 'text/html', title: '', hrefs: [] });
        },
        close: async () => undefined,
      }),
    });
    const observation = await adapter.observe('http://elsewhere.example/out');
    assert.equal(observation, null);
    assert.equal(pagesCreated, 0, 'scope 外は page すら開かない');
    await adapter.close();
  });

  test('実装エラーは明示 throw、接続拒否は status 0 観測、4xx は解析なしとして扱う', async () => {
    // 実装ミスに相当する非 navigation エラーは握りつぶさず throw する。
    const brokenPage: StubPage = {
      goto: async () => { throw new TypeError('unexpected adapter bug'); },
      title: async () => '',
      $$eval: async () => [],
      close: async () => undefined,
    };
    const failing = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] },
      launcher: async () => ({ newPage: async () => brokenPage, close: async () => undefined }),
    });
    await assert.rejects(() => failing.observe('http://fixture.target.test/x'), /Playwright exploration failed/);
    await failing.close();

    // 接続拒否 (net::ERR_*) は status 0 観測として記録し探索を続行する。
    const refused = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] },
      launcher: async () => ({
        newPage: async () => stubPage({ url: 'http://fixture.target.test/x', status: 0, contentType: '', title: '', hrefs: [], fail: true }),
        close: async () => undefined,
      }),
    });
    const refusedObservation = await refused.observe('http://fixture.target.test/x');
    assert.equal(refusedObservation?.status, 0);
    assert.equal(refusedObservation?.contentType, 'application/x-navigation-failure');
    await refused.close();

    const notFound = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] },
      launcher: async () => ({
        newPage: async () => stubPage({ url: 'http://fixture.target.test/missing', status: 404, contentType: 'text/html', title: '', hrefs: ['http://fixture.target.test/link'] }),
        close: async () => undefined,
      }),
    });
    const observation = await notFound.observe('http://fixture.target.test/missing');
    assert.notEqual(observation, null);
    assert.equal(observation?.status, 404);
    assert.deepEqual(observation?.links, [], '4xx は page 解析 (link 抽出) を行わない');
    await notFound.close();
  });

  test('到達不能・証明書エラー等の navigation 失敗は status 0 観測として続行する', async () => {
    let pageClosed = false;
    const unreachablePage: StubPage = {
      goto: async () => { throw new Error('page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://elsewhere.example/'); },
      title: async () => { throw new Error('must not parse failed navigation'); },
      $$eval: async () => { throw new Error('must not parse failed navigation'); },
      close: async () => { pageClosed = true; },
    };
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] },
      launcher: async () => ({ newPage: async () => unreachablePage, close: async () => undefined }),
    });

    const observation = await adapter.observe('http://fixture.target.test/redirect');
    assert.deepEqual(observation, {
      url: 'http://fixture.target.test/redirect',
      status: 0,
      contentType: 'application/x-navigation-failure',
      discoveredFrom: null,
      depth: 0,
      originType: 'crawl',
      links: [],
      forms: [],
    });
    assert.equal(pageClosed, true);
    await adapter.close();
  });

  test('ダウンロード開始URLは探索全体を止めず非HTMLの観測結果として残す', async () => {
    let pageClosed = false;
    const downloadPage: StubPage = {
      goto: async () => { throw new Error('page.goto: Download is starting'); },
      title: async () => { throw new Error('download response must not be parsed as HTML'); },
      $$eval: async () => { throw new Error('download response must not be parsed as HTML'); },
      close: async () => { pageClosed = true; },
    };
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] },
      launcher: async () => ({
        newPage: async () => downloadPage,
        close: async () => undefined,
      }),
    });

    const observation = await adapter.observe('http://fixture.target.test/config.inc.php.dist');
    assert.deepEqual(observation, {
      url: 'http://fixture.target.test/config.inc.php.dist',
      status: 0,
      contentType: 'application/octet-stream',
      discoveredFrom: null,
      depth: 0,
      originType: 'crawl',
      links: [],
      forms: [],
    });
    assert.equal(pageClosed, true);
    await adapter.close();
  });

  test('observeWithSession は session cookie を page 生成へ渡し、scope 強制も同じ入口で効く', async () => {
    const receivedStates: (BrowserSessionState | undefined)[] = [];
    const preparedUrls: string[] = [];
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] },
      beforeSessionObservation: async (url) => { preparedUrls.push(url); },
      launcher: async () => ({
        newPage: async (state?: BrowserSessionState) => {
          receivedStates.push(state);
          return stubPage({ url: 'http://fixture.target.test/authed', status: 200, contentType: 'text/html', title: 'Authed', hrefs: [] });
        },
        close: async () => undefined,
      }),
    });
    const session = {
      cookies: [{ name: 'PHPSESSID', value: 'sid-1', domain: 'fixture.target.test', path: '/' }],
      origins: [{
        origin: 'http://fixture.target.test',
        localStorage: [{ name: 'access_token', value: 'local-secret' }],
        sessionStorage: [{ name: 'csrf', value: 'session-secret' }],
      }],
    };
    const observation = await adapter.observeWithSession('http://fixture.target.test/authed', session);
    assert.notEqual(observation, null);
    assert.equal(observation?.title, 'Authed');
    assert.deepEqual(receivedStates, [session]);
    assert.deepEqual(preparedUrls, ['http://fixture.target.test']);

    // 同じ login session / origin の後続ページでは ZAP session 解除を繰り返さない。
    await adapter.observeWithSession('http://fixture.target.test/second', session);
    assert.deepEqual(preparedUrls, ['http://fixture.target.test']);

    // 新しい login session は同じ origin でも安全準備をやり直す。
    const refreshedSession = {
      cookies: [{ name: 'PHPSESSID', value: 'sid-2', domain: 'fixture.target.test', path: '/' }],
      origins: [],
    };
    await adapter.observeWithSession('http://fixture.target.test/third', refreshedSession);
    assert.deepEqual(preparedUrls, ['http://fixture.target.test', 'http://fixture.target.test']);

    // scope 外は session があっても送信前に拒否 (page を開かない)。
    receivedStates.length = 0;
    const denied = await adapter.observeWithSession('http://elsewhere.example/authed', session);
    assert.equal(denied, null);
    assert.deepEqual(receivedStates, []);
    assert.deepEqual(preparedUrls, ['http://fixture.target.test', 'http://fixture.target.test']);
    await adapter.close();
  });
});
