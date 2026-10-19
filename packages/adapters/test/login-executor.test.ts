import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoginSessionCookie } from '@scopepilot2/core';
import { PlaywrightLoginExecutor, type StubLoginBrowser, type StubLoginPage } from '../src/login-executor.ts';

/**
 * login 実行器の契約検証。実 browser は使わず stub browser で step DSL の実行・
 * 秘密値解決・認証判断 (URL + assert)・cookie 写像を検証する。
 * 実 browser との結合 (DVWA) は gated acceptance 側。
 */
class StubLoginPageImpl implements StubLoginPage {
  readonly filled: { selector: string; value: string }[] = [];
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

  async click(selector: string): Promise<void> {
    this.clicked.push(selector);
    this.urlValue = 'http://target.test/index.php';
  }

  async waitFor(): Promise<void> {}

  async inputValue(): Promise<string> {
    return 'token-xyz';
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

  async close(): Promise<void> {}
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
});
