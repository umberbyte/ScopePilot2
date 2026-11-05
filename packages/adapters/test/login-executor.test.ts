import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BrowserSessionState, LoginSessionCookie } from '@scopepilot2/core';
import { PlaywrightLoginExecutor, type StubLoginBrowser, type StubLoginPage } from '../src/login-executor.ts';

/**
 * login 実行器の契約検証。実 browser は使わず stub browser で step DSL の実行・
 * 秘密値解決・認証判断 (URL + assert)・cookie 写像を検証する。
 * 実 browser との結合 (DVWA) は gated acceptance 側。
 */
class StubLoginPageImpl implements StubLoginPage {
  readonly filled: { selector: string; value: string }[] = [];
  readonly selected: { selector: string; value: string }[] = [];
  readonly clicked: string[] = [];
  urlValue = 'http://target.test/login.php';
  contentValue = '<html><body>Welcome back</body></html>';
  cookiesValue: readonly LoginSessionCookie[] = [
    { name: 'PHPSESSID', value: 'sid-1', domain: 'target.test', path: '/' },
  ];

  async goto(url: string): Promise<void> {
    this.urlValue = url;
  }

  async fill(selector: string, value: string): Promise<void> {
    this.filled.push({ selector, value });
  }

  async selectOption(selector: string, value: string): Promise<void> {
    this.selected.push({ selector, value });
  }

  async click(selector: string): Promise<void> {
    this.clicked.push(selector);
    this.urlValue = 'http://target.test/index.php';
  }

  async waitFor(): Promise<void> {}

  async inputValue(selector: string): Promise<string> {
    return this.selected.findLast((entry) => entry.selector === selector)?.value ?? 'token-xyz';
  }

  async content(): Promise<string> {
    return this.contentValue;
  }

  url(): string {
    return this.urlValue;
  }

  async cookies(): Promise<readonly LoginSessionCookie[]> {
    return this.cookiesValue;
  }

  async browserState(): Promise<BrowserSessionState> {
    return {
      cookies: this.cookiesValue,
      origins: [{
        origin: 'http://target.test',
        localStorage: [{ name: 'access_token', value: 'bearer-secret' }],
        sessionStorage: [{ name: 'csrf', value: 'csrf-secret' }],
      }],
    };
  }

  async close(): Promise<void> {}

  observedRequestsValue: readonly import('@scopepilot2/contracts').ObservedHttpRequest[] = [];

  observedRequests(): readonly import('@scopepilot2/contracts').ObservedHttpRequest[] {
    return this.observedRequestsValue;
  }
}

function createStubBrowser(): { browser: StubLoginBrowser; page: StubLoginPageImpl; proxyOptions: (string | undefined)[] } {
  const page = new StubLoginPageImpl();
  const proxyOptions: (string | undefined)[] = [];
  const browser: StubLoginBrowser = {
    newPage: async (options: { readonly proxyServer?: string }) => {
      proxyOptions.push(options.proxyServer);
      return page;
    },
    close: async () => {},
  };
  return { browser, page, proxyOptions };
}

describe('login executor (stub browser 契約検証)', () => {
  test('navigate → fill (秘密値) → click → assert で認証済みと判断し cookie を返す', async () => {
    const stub = createStubBrowser();
    const executor = new PlaywrightLoginExecutor({ launcher: async () => stub.browser });
    const result = await executor.execute({
      baseUrl: 'http://target.test',
      steps: [
        { kind: 'navigate', target: '/login.php' },
        { kind: 'fill', target: 'input[name=username]', secretReference: 'vault://user' },
        { kind: 'fill', target: 'input[name=password]', secretReference: 'vault://pass' },
        { kind: 'click', target: 'input[type=submit]' },
        { kind: 'assert', target: 'Welcome back' },
      ],
      secretValues: { 'vault://user': 'admin', 'vault://pass': 'password123' },
      expectedUrlPrefix: 'http://target.test/',
    });
    assert.equal(result.authenticated, true);
    assert.equal(result.finalUrl, 'http://target.test/index.php');
    assert.deepEqual(stub.page.filled, [
      { selector: 'input[name=username]', value: 'admin' },
      { selector: 'input[name=password]', value: 'password123' },
    ]);
    assert.deepEqual(stub.page.clicked, ['input[type=submit]']);
    assert.deepEqual(result.cookies.map((cookie) => cookie.name), ['PHPSESSID']);
    assert.deepEqual(result.browserState?.origins.map((entry) => ({
      origin: entry.origin,
      localNames: entry.localStorage.map((item) => item.name),
      sessionNames: entry.sessionStorage.map((item) => item.name),
    })), [{ origin: 'http://target.test', localNames: ['access_token'], sessionNames: ['csrf'] }]);
  });

  test('login 実行中の同一Originリクエストを入力点のみで観測し候補化できる形で返す', async () => {
    const stub = createStubBrowser();
    stub.page.observedRequestsValue = [
      {
        requestId: 'login-000001',
        url: 'http://target.test/api/login',
        method: 'POST',
        resourceType: 'xhr',
        contentType: 'application/json',
        inputPoints: [
          { name: 'email', location: 'body', type: 'json' },
          { name: 'password', location: 'body', type: 'json' },
        ],
        sourceUrl: 'http://target.test/login.php',
      },
      {
        requestId: 'login-000002',
        url: 'https://analytics.example/collect',
        method: 'POST',
        resourceType: 'xhr',
        contentType: 'application/json',
        inputPoints: [{ name: 'event', location: 'body', type: 'json' }],
        sourceUrl: 'http://target.test/login.php',
      },
    ];
    const executor = new PlaywrightLoginExecutor({ launcher: async () => stub.browser });
    const result = await executor.execute({
      baseUrl: 'http://target.test',
      steps: [
        { kind: 'navigate', target: '/login.php' },
        { kind: 'assert', target: 'Welcome back' },
      ],
      secretValues: {},
      expectedUrlPrefix: 'http://target.test/',
    });

    assert.equal(result.authenticated, true);
    // 同一Originだけを返し、第三者 (analytics) は含まない。値は元々含まれない。
    assert.deepEqual(result.observedRequests?.map((request) => request.url), ['http://target.test/api/login']);
    assert.deepEqual(result.observedRequests?.[0]?.inputPoints.map((point) => point.name), ['email', 'password']);
  });

  test('URL が一致しても assert が失敗すれば未認証 (F09-UT-002)', async () => {
    const stub = createStubBrowser();
    stub.page.contentValue = '<html><body>login failed</body></html>';
    const executor = new PlaywrightLoginExecutor({ launcher: async () => stub.browser });
    const result = await executor.execute({
      baseUrl: 'http://target.test',
      steps: [
        { kind: 'navigate', target: '/login.php' },
        { kind: 'assert', target: 'Welcome back' },
      ],
      secretValues: {},
      expectedUrlPrefix: 'http://target.test/',
    });
    assert.equal(result.authenticated, false);
  });

  test('秘密値の未解決参照は error。proxyServer は page 生成へ渡る', async () => {
    const stub = createStubBrowser();
    const executor = new PlaywrightLoginExecutor({ launcher: async () => stub.browser });
    await assert.rejects(
      executor.execute({
        baseUrl: 'http://target.test',
        steps: [{ kind: 'navigate', target: '/login.php' }, { kind: 'fill', target: '#u', secretReference: 'vault://missing' }],
        secretValues: {},
        expectedUrlPrefix: 'http://target.test/',
      }),
      /could not resolve secret reference/,
    );

    await executor.execute({
      baseUrl: 'http://target.test',
      steps: [{ kind: 'navigate', target: '/login.php' }, { kind: 'assert', target: 'Welcome back' }],
      secretValues: {},
      expectedUrlPrefix: 'http://target.test/',
      proxyServer: 'http://127.0.0.1:8090',
    });
    assert.deepEqual(stub.proxyOptions, [undefined, 'http://127.0.0.1:8090']);
  });

  test('login assertion failure stops before post-login actions', async () => {
    const stub = createStubBrowser();
    stub.page.contentValue = '<html><body>Login failed</body></html>';
    const executor = new PlaywrightLoginExecutor({ launcher: async () => stub.browser });
    const result = await executor.execute({
      baseUrl: 'http://target.test',
      steps: [
        { kind: 'navigate', target: '/login.php' },
        { kind: 'assert', target: 'Welcome back' },
        { kind: 'navigate', target: '/security.php' },
        { kind: 'select', target: 'select[name="security"]', value: 'low' },
      ],
      secretValues: {},
      expectedUrlPrefix: 'http://target.test/',
    });
    assert.equal(result.authenticated, false);
    assert.equal(result.finalUrl, 'http://target.test/login.php');
    assert.deepEqual(stub.page.selected, []);
  });

  test('extract で得た値を fill の参照として使える (CSRF token 等)', async () => {
    const stub = createStubBrowser();
    const executor = new PlaywrightLoginExecutor({ launcher: async () => stub.browser });
    const result = await executor.execute({
      baseUrl: 'http://target.test',
      steps: [
        { kind: 'navigate', target: '/login.php' },
        { kind: 'extract', target: 'input[name=csrf]', secretReference: 'csrf-token' },
        { kind: 'fill', target: 'input[name=csrf]', secretReference: 'csrf-token' },
        { kind: 'assert', target: 'Welcome back' },
      ],
      secretValues: {},
      expectedUrlPrefix: 'http://target.test/',
    });
    assert.equal(result.authenticated, true);
    assert.deepEqual(stub.page.filled, [{ selector: 'input[name=csrf]', value: 'token-xyz' }]);
  });
  test('ログイン後に設定画面へ移動し、選択・送信・反映確認を実行する', async () => {
    const stub = createStubBrowser();
    const executor = new PlaywrightLoginExecutor({ launcher: async () => stub.browser });
    const result = await executor.execute({
      baseUrl: 'http://target.test',
      steps: [
        { kind: 'navigate', target: '/login.php' },
        { kind: 'assert', target: 'Welcome back' },
        { kind: 'navigate', target: '/security.php' },
        { kind: 'select', target: 'select[name="security"]', value: 'low' },
        { kind: 'click', target: 'input[name="seclev_submit"]' },
        { kind: 'assertValue', target: 'select[name="security"]', value: 'low' },
      ],
      secretValues: {},
      expectedUrlPrefix: 'http://target.test/',
    });
    assert.equal(result.authenticated, true);
    assert.deepEqual(stub.page.selected, [{ selector: 'select[name="security"]', value: 'low' }]);
    assert.deepEqual(stub.page.clicked, ['input[name="seclev_submit"]']);
  });
});
