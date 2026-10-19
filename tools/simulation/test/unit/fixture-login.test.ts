import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FixtureExplorer, FixtureLoginExecutor } from '@scopepilot2/simulation';

/**
 * FixtureLoginExecutor (design/f09 §4 の fixture 版) と FixtureExplorer の
 * session 観測。認証判定は PlaywrightLoginExecutor と同じ規則 (F09-UT-002)。
 */
const LOGIN_FLOW_STEPS = [
  { kind: 'navigate', target: 'http://fixture.target.test/login.php' },
  { kind: 'fill', target: '#username', secretReference: 'vault://admin-user' },
  { kind: 'fill', target: '#password', secretReference: 'vault://admin-pass' },
  { kind: 'click', target: 'input[type=submit]' },
  { kind: 'assert', target: 'Fixture Target Home' },
] as const;

describe('FixtureLoginExecutor', () => {
  test('login.php で資格情報を submit すると index へ遷移し session cookie を返す', async () => {
    const executor = new FixtureLoginExecutor();
    const result = await executor.execute({
      baseUrl: 'http://fixture.target.test',
      steps: [...LOGIN_FLOW_STEPS],
      secretValues: { 'vault://admin-user': 'admin', 'vault://admin-pass': 'password123' },
      expectedUrlPrefix: 'http://fixture.target.test/',
    });
    assert.equal(result.authenticated, true);
    assert.equal(result.finalUrl, 'http://fixture.target.test/');
    assert.deepEqual(result.cookies.map((cookie) => cookie.name), ['PHPSESSID']);
  });

  test('assert step が無い flow は未認証 (F09-UT-002: URL 一致だけでは認証済みとしない)', async () => {
    const executor = new FixtureLoginExecutor();
    const result = await executor.execute({
      baseUrl: 'http://fixture.target.test',
      steps: LOGIN_FLOW_STEPS.filter((step) => step.kind !== 'assert'),
      secretValues: { 'vault://admin-user': 'admin', 'vault://admin-pass': 'password123' },
      expectedUrlPrefix: 'http://fixture.target.test/',
    });
    assert.equal(result.authenticated, false);
    assert.deepEqual(result.cookies, []);
  });

  test('assert marker が page に無い場合も未認証。秘密値の参照解決に失敗すると throw', async () => {
    const executor = new FixtureLoginExecutor();
    const wrongMarker = await executor.execute({
      baseUrl: 'http://fixture.target.test',
      steps: [...LOGIN_FLOW_STEPS, { kind: 'assert', target: 'Welcome, admin!' }],
      secretValues: { 'vault://admin-user': 'admin', 'vault://admin-pass': 'password123' },
      expectedUrlPrefix: 'http://fixture.target.test/',
    });
    assert.equal(wrongMarker.authenticated, false);

    await assert.rejects(
      executor.execute({
        baseUrl: 'http://fixture.target.test',
        steps: [...LOGIN_FLOW_STEPS],
        secretValues: { 'vault://admin-user': 'admin' },
        expectedUrlPrefix: 'http://fixture.target.test/',
      }),
      /could not resolve secret reference/,
    );
  });
});

describe('FixtureExplorer observeWithSession', () => {
  test('session の cookie を記録して同じ fixture page を観測する', async () => {
    const explorer = new FixtureExplorer();
    const observation = await explorer.observeWithSession('http://fixture.target.test/', {
      cookies: [{ name: 'PHPSESSID', value: 'fixture-session', domain: 'fixture.target.test', path: '/' }],
    });
    assert.equal(observation?.title, 'Fixture Target Home');
    assert.deepEqual(explorer.sessionCalls(), [
      { url: 'http://fixture.target.test/', cookieNames: ['PHPSESSID'] },
    ]);
    // 非認証の呼出記録とは分離される。
    assert.deepEqual(explorer.calls(), []);
  });

  test('認証後のみ見える頁は session 探索でのみ観測できる (design/f09)', async () => {
    const explorer = new FixtureExplorer();
    const session = { cookies: [{ name: 'PHPSESSID', value: 'fixture-session', domain: 'fixture.target.test', path: '/' }] };
    const menuUrl = 'http://fixture.target.test/authenticated/menu.php';

    // 非 session の観測では頁が存在しない (null)。
    assert.equal(await explorer.observe(menuUrl), null);

    // session 探索では認証後 menu が観測される。
    const observation = await explorer.observeWithSession(menuUrl, session);
    assert.equal(observation?.title, 'Authenticated Menu (fixture)');
    assert.deepEqual(observation?.links, []);
  });
});
