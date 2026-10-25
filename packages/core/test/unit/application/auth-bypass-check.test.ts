import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { InteractiveBrowserPort, LoginExecutorPort, LoginFlowStep } from '@scopepilot2/core';
import { bootstrapFlow } from '../support/test-flow.ts';

const BASE = 'http://fixture.target.test';
const PASSWORD = 'correct-password';

function loginSteps(): readonly LoginFlowStep[] {
  return [
    { kind: 'navigate', target: 'login.php' },
    { kind: 'fill', target: 'input[name="password"]', secretReference: 'password' },
    { kind: 'click', target: 'input[name="Login"]' },
    { kind: 'assert', target: 'Logout' },
  ];
}

/** password が正値のときだけ認証する login 実行器の fake。 */
function strictLoginExecutor(acceptEmptyPassword = false): LoginExecutorPort {
  return {
    engineVersion: 'fake-login-exec-1',
    execute: async (input) => {
      const filled = input.steps.some((step) => step.kind === 'fill' && step.secretReference === 'password');
      const password = input.secretValues.password ?? '';
      const authenticated = filled && (password === PASSWORD || (acceptEmptyPassword && password === ''));
      return {
        authenticated,
        finalUrl: authenticated ? input.expectedUrlPrefix : `${BASE}/login.php`,
        cookies: authenticated ? [{ name: 'sid', value: 'session-1', domain: 'fixture.target.test', path: '/' }] : [],
      };
    },
  };
}

/**
 * sid cookie が空でない値で存在する場合だけ認証後ページ (marker: Logout) を返す
 * browser の fake。未認証は login への遷移として表現する。
 */
function secureBrowser(): InteractiveBrowserPort {
  return {
    engineVersion: 'fake-auth-bypass-browser-1',
    execute: async (input) => {
      const sid = input.sessionCookies?.find((cookie) => cookie.name === 'sid');
      if (sid !== undefined && sid.value !== '') {
        return { finalUrl: input.targetUrl, status: 200, bodyHash: 'hash-member', bodyText: 'Welcome member Logout', headers: [], elapsedMs: 5, assertions: [] };
      }
      return { finalUrl: `${BASE}/login.php`, status: 200, bodyHash: 'hash-login', bodyText: 'Please login', headers: [], elapsedMs: 5, assertions: [] };
    },
  };
}

/** cookie が無くても認証後ページを返してしまう (脆弱) browser の fake。 */
function vulnerableBrowser(): InteractiveBrowserPort {
  return {
    engineVersion: 'fake-auth-bypass-browser-2',
    execute: async (input) => ({
      finalUrl: input.targetUrl,
      status: 200,
      bodyHash: 'hash-member',
      bodyText: 'Welcome member Logout',
      headers: [],
      elapsedMs: 5,
      assertions: [],
    }),
  };
}

interface FlowOptions {
  readonly browser: InteractiveBrowserPort;
  readonly loginExecutor?: LoginExecutorPort;
  readonly allowedOperationClasses?: readonly string[];
}

/** login まで済ませた flow を組み立てる (session cookie は sid=session-1)。 */
async function flowWithSession(options: FlowOptions) {
  const { service, operator } = await bootstrapFlow({
    interactiveBrowser: options.browser,
    loginExecutor: options.loginExecutor ?? strictLoginExecutor(),
    ...(options.allowedOperationClasses === undefined ? {} : { allowedOperationClasses: options.allowedOperationClasses as never[] }),
  });
  service.registerLoginFlow(operator, { role: 'admin', flowVersion: 'f1', steps: loginSteps() });
  const login = await service.runLogin(operator, {
    role: 'admin',
    baseUrl: `${BASE}/`,
    secretValues: { password: PASSWORD },
    expectedUrlPrefix: `${BASE}/`,
  });
  assert.equal(login.authenticated, true);
  return { service, operator };
}

describe('auth bypass check (service, ZAP非対応テーマ1)', () => {
  test('ActiveScan が認可に無い場合は OutOfScope', async () => {
    const { service, operator } = await flowWithSession({ browser: secureBrowser(), allowedOperationClasses: ['Browse'] });
    await assert.rejects(service.runAuthBypassCheck(operator, { role: 'admin' }), /ActiveScan/u);
  });

  test('login 済み session が無い role は validation error', async () => {
    const { service, operator } = await bootstrapFlow({ interactiveBrowser: secureBrowser() });
    await assert.rejects(service.runAuthBypassCheck(operator, { role: 'nobody' }), /no authenticated session/u);
  });

  test('対象 URL が scope 外なら OutOfScope', async () => {
    const { service, operator } = await flowWithSession({ browser: secureBrowser() });
    await assert.rejects(
      service.runAuthBypassCheck(operator, { role: 'admin', targetUrls: ['http://other.example/member'] }),
      /out of scope/u,
    );
  });

  test('cookie 書き換え・未認証直アクセス・password 変種がすべて拒否されれば pass', async () => {
    const { service, operator } = await flowWithSession({ browser: secureBrowser(), loginExecutor: strictLoginExecutor() });
    const summary = await service.runAuthBypassCheck(operator, {
      role: 'admin',
      authCookieNames: ['sid'],
      includeLoginVariants: true,
      secretValues: { password: PASSWORD },
    });
    assert.equal(summary.status, 'pass');
    assert.equal(summary.totalRequests, 7);
    const byPattern = new Map(summary.results.map((probe) => [`${probe.kind}:${probe.pattern}`, probe]));
    assert.equal(byPattern.get('page:session-baseline')?.markersFound, true);
    assert.equal(byPattern.get('page:auth-cookie-emptied')?.outcome, 'denied');
    assert.equal(byPattern.get('page:auth-cookie-removed')?.outcome, 'denied');
    assert.equal(byPattern.get('page:no-session')?.outcome, 'denied');
    assert.equal(byPattern.get('login:password-emptied')?.outcome, 'denied');
    assert.equal(byPattern.get('login:password-omitted')?.outcome, 'denied');
    assert.equal(byPattern.get('login:password-plus-one-char')?.outcome, 'denied');
    assert.deepEqual(summary.loginVariantsNotRun, []);

    // 監査: 結果と履歴に cookie 値・秘密値が含まれないこと。
    const serialized = JSON.stringify(summary) + JSON.stringify(service.listAuthBypassChecks());
    assert.equal(serialized.includes('session-1'), false);
    assert.equal(serialized.includes(PASSWORD), false);
    const events = service.events().filter((event) => event.type === 'AuthBypassCheckCompleted');
    assert.equal(events.length, 1);
  });

  test('未認証でも認証後情報が出る場合は exposed となり fail', async () => {
    const { service, operator } = await flowWithSession({ browser: vulnerableBrowser(), loginExecutor: strictLoginExecutor() });
    const summary = await service.runAuthBypassCheck(operator, { role: 'admin', authCookieNames: ['sid'] });
    assert.equal(summary.status, 'fail');
    for (const probe of summary.results.filter((entry) => entry.pattern !== 'session-baseline')) {
      assert.equal(probe.outcome, 'exposed');
    }
  });

  test('空 password で認証が成立する場合は exposed となり fail', async () => {
    const { service, operator } = await flowWithSession({ browser: secureBrowser(), loginExecutor: strictLoginExecutor(true) });
    const summary = await service.runAuthBypassCheck(operator, {
      role: 'admin',
      authCookieNames: ['sid'],
      includeLoginVariants: true,
      secretValues: { password: PASSWORD },
    });
    assert.equal(summary.status, 'fail');
    assert.equal(summary.results.find((probe) => probe.pattern === 'password-emptied')?.outcome, 'exposed');
  });

  test('秘密値未指定でもページ観測は実行し、ログイン変種は not run として記録する', async () => {
    const { service, operator } = await flowWithSession({ browser: secureBrowser() });
    const summary = await service.runAuthBypassCheck(operator, { role: 'admin', authCookieNames: ['sid'], includeLoginVariants: true });
    assert.equal(summary.status, 'pass');
    assert.equal(summary.totalRequests, 4);
    assert.equal(summary.results.every((probe) => probe.kind === 'page'), true);
    assert.equal(summary.loginVariantsNotRun.includes('password-emptied'), true);
    const list = service.listAuthBypassChecks();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.checkId, summary.checkId);
    assert.equal(list[0]?.themeNo, '1');
  });

  test('baseline で認証後 marker が確認できない対象は無駄打ちせず inconclusive', async () => {
    const expiredSession: InteractiveBrowserPort = {
      engineVersion: 'fake-auth-bypass-browser-3',
      execute: async (input) => ({
        finalUrl: input.targetUrl,
        status: 200,
        bodyHash: 'hash-login',
        bodyText: 'Please login',
        headers: [],
        elapsedMs: 5,
        assertions: [],
      }),
    };
    const { service, operator } = await flowWithSession({ browser: expiredSession });
    const summary = await service.runAuthBypassCheck(operator, { role: 'admin', authCookieNames: ['sid'] });
    assert.equal(summary.status, 'inconclusive');
    // baseline 1 通だけで変種を送らない (session 期限切れ等で判定不能な場合の安全側)。
    assert.equal(summary.totalRequests, 1);
  });

  test('代表対象は5件まで。超過すれば validation error', async () => {
    const { service, operator } = await flowWithSession({ browser: secureBrowser() });
    const six = Array.from({ length: 6 }, (_, index) => `${BASE}/p${index}`);
    await assert.rejects(service.runAuthBypassCheck(operator, { role: 'admin', targetUrls: six }), /at most/u);
  });

  test('認証用 Cookie 名は明示指定が必須で、session にない名前は拒否する', async () => {
    const { service, operator } = await flowWithSession({ browser: secureBrowser() });
    await assert.rejects(service.runAuthBypassCheck(operator, { role: 'admin' }), /explicitly identified/u);
    await assert.rejects(service.runAuthBypassCheck(operator, { role: 'admin', authCookieNames: ['tracking-only'] }), /not present/u);
  });
});
