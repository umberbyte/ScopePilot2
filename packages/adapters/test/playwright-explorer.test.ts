import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PlaywrightExplorerAdapter, type StubBrowserContext, type StubPage } from '../src/playwright-explorer.ts';

/**
 * Playwright explorer adapter の契約検証。実 browser は使わず、最小面の stub
 * context/page を注入して、scope 強制 (Enforced)・観測写像 (title/link/content-type)・
 * navigation 失敗の扱いを検証する。実 browser との結合は実環境での確認項目。
 */

interface StubResponse {
  status(): number;
  headers(): Record<string, string>;
}

function stubPage(options: { url: string; status: number; contentType: string; title: string; hrefs: readonly string[]; fail?: boolean }): StubPage {
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
    title: async () => options.title,
    $$eval: async (selector: string) => (selector === 'a[href]' ? [...options.hrefs] : []),
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
    // http(s) の link だけ残す (javascript: 等は除外。scope 外 link は core 側で拒否記録になる)。
    assert.deepEqual(observation?.links, ['http://fixture.target.test/next', 'http://elsewhere.example/x']);
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

  test('navigation 失敗は明示エラー、4xx は解析なしとして扱う', async () => {
    const failing = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] },
      launcher: async () => ({
        newPage: async () => stubPage({ url: 'http://fixture.target.test/x', status: 0, contentType: '', title: '', hrefs: [], fail: true }),
        close: async () => undefined,
      }),
    });
    await assert.rejects(() => failing.observe('http://fixture.target.test/x'), /Playwright exploration failed/);
    await failing.close();

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

  test('observeWithSession は session cookie を page 生成へ渡し、scope 強制も同じ入口で効く', async () => {
    const receivedCookies: (readonly { name: string; value: string; domain: string; path: string }[] | undefined)[] = [];
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] },
      launcher: async () => ({
        newPage: async (cookies?: readonly { name: string; value: string; domain: string; path: string }[]) => {
          receivedCookies.push(cookies);
          return stubPage({ url: 'http://fixture.target.test/authed', status: 200, contentType: 'text/html', title: 'Authed', hrefs: [] });
        },
        close: async () => undefined,
      }),
    });
    const session = {
      cookies: [{ name: 'PHPSESSID', value: 'sid-1', domain: 'fixture.target.test', path: '/' }],
    };
    const observation = await adapter.observeWithSession('http://fixture.target.test/authed', session);
    assert.notEqual(observation, null);
    assert.equal(observation?.title, 'Authed');
    assert.deepEqual(receivedCookies, [session.cookies]);

    // scope 外は session があっても送信前に拒否 (page を開かない)。
    receivedCookies.length = 0;
    const denied = await adapter.observeWithSession('http://elsewhere.example/authed', session);
    assert.equal(denied, null);
    assert.deepEqual(receivedCookies, []);
    await adapter.close();
  });
});
