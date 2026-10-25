import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  DomObservationPort,
  FuzzTransportPort,
  InteractiveBrowserPort,
  LoginExecutorPort,
  LoginFlowStep,
  NucleiScanPort,
  RepeaterTransportPort,
} from '@scopepilot2/core';
import { bootstrapFlow } from '../support/test-flow.ts';

const BASE = 'http://fixture.target.test';
const PASSWORD = 'correct-password';

/** flow DSL を解釈する browser fake。handler に (targetUrl, fills, sessionCookies) を渡す。 */
function flowBrowser(
  handler: (input: { targetUrl: string; fills: Readonly<Record<string, string>>; hasSession: boolean; sessionValues: readonly string[]; bodyText?: string }) => {
    readonly finalUrl: string;
    readonly status: number;
    readonly bodyText: string;
    readonly assertionsPassed: boolean;
    readonly elapsedMs?: number;
    readonly headers?: readonly (readonly [string, string])[];
  },
): InteractiveBrowserPort {
  return {
    engineVersion: 'fake-theme-browser-1',
    execute: async (input) => {
      const fills: Record<string, string> = {};
      for (const step of input.steps) {
        if (step.kind === 'fill') {
          fills[step.target] = step.value;
        }
      }
      const result = handler({
        targetUrl: input.targetUrl,
        fills,
        hasSession: (input.sessionCookies ?? []).some((cookie) => cookie.value !== ''),
        sessionValues: (input.sessionCookies ?? []).map((cookie) => cookie.value),
        ...((input.sessionCookies ?? []).length === 0 ? {} : {}),
      });
      return {
        finalUrl: result.finalUrl,
        status: result.status,
        bodyHash: `hash:${result.bodyText.slice(0, 24)}`,
        bodyText: result.bodyText,
        headers: result.headers ?? [],
        elapsedMs: result.elapsedMs ?? 5,
        assertions: input.steps.filter((step) => step.kind === 'assert').map((step) => ({ kind: 'assert' as const, target: step.target, passed: result.assertionsPassed })),
      };
    },
  };
}

/** requestBytes (method・header・body) から応答を決める repeater fake。 */
function rawTransport(
  handler: (input: { method: string; targetUrl: string; headers: Readonly<Record<string, string>>; body: string; hasSession: boolean }) => {
    readonly status: number;
    readonly headers?: readonly (readonly [string, string])[];
    readonly body?: string;
    readonly redirects?: readonly string[];
  },
): RepeaterTransportPort {
  return {
    send: async (input) => {
      const separator = input.requestBytes.indexOf('\n\n');
      const head = separator === -1 ? input.requestBytes : input.requestBytes.slice(0, separator);
      const body = separator === -1 ? '' : input.requestBytes.slice(separator + 2);
      const lines = head.split('\n');
      const first = (lines[0] ?? '').split(' ');
      const method = first.length >= 3 ? first[0]! : 'GET';
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const at = line.indexOf(':');
        if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      const result = handler({ method, targetUrl: input.targetUrl, headers, body, hasSession: (input.sessionCookies ?? []).length > 0 });
      return {
        status: result.status,
        headers: result.headers ?? [],
        body: Buffer.from(result.body ?? '', 'utf8'),
        redirectLocations: result.redirects ?? [],
      };
    },
  };
}

function loginSteps(): readonly LoginFlowStep[] {
  return [
    { kind: 'navigate', target: 'login.php' },
    { kind: 'fill', target: 'input[name="username"]', secretReference: 'username' },
    { kind: 'fill', target: 'input[name="password"]', secretReference: 'password' },
    { kind: 'click', target: 'input[name="Login"]' },
    { kind: 'assert', target: 'Logout' },
  ];
}

/** login 済み session (sid=session-1) を作る。 */
async function flowWithSession(options: {
  readonly browser: InteractiveBrowserPort;
  readonly loginExecutor?: LoginExecutorPort;
  readonly repeater?: RepeaterTransportPort;
  readonly fuzz?: FuzzTransportPort;
  readonly domObserver?: DomObservationPort;
  readonly nuclei?: NucleiScanPort;
  readonly allowedOrigins?: readonly string[];
}) {
  const { service, operator } = await bootstrapFlow({
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    interactiveBrowser: options.browser,
    loginExecutor: options.loginExecutor ?? {
      engineVersion: 'fake-login-exec-1',
      execute: async (input) => ({
        authenticated: input.secretValues.password === PASSWORD,
        finalUrl: input.secretValues.password === PASSWORD ? input.expectedUrlPrefix : `${BASE}/login.php`,
        cookies: input.secretValues.password === PASSWORD ? [{ name: 'sid', value: `session-${input.secretValues.username ?? 'user'}`, domain: 'fixture.target.test', path: '/' }] : [],
      }),
    },
    ...(options.repeater === undefined ? {} : { repeaterTransport: options.repeater }),
    ...(options.fuzz === undefined ? {} : { fuzzTransport: options.fuzz }),
    ...(options.domObserver === undefined ? {} : { domObserver: options.domObserver }),
    ...(options.nuclei === undefined ? {} : { nucleiRunner: options.nuclei }),
  });
  service.registerLoginFlow(operator, { role: 'admin', flowVersion: 'f1', steps: loginSteps() });
  const login = await service.runLogin(operator, { role: 'admin', baseUrl: `${BASE}/`, secretValues: { username: 'admin', password: PASSWORD }, expectedUrlPrefix: `${BASE}/app/` });
  assert.equal(login.authenticated, true);
  return { service, operator };
}

describe('zap-unsupported check (service, Top10 対象テーマ)', () => {
  test('未実装テーマ・テーマ1への誤投入・認可不足は拒否', async () => {
    const { service, operator } = await flowWithSession({ browser: flowBrowser(() => ({ finalUrl: '', status: 200, bodyText: '', assertionsPassed: false })) });
    await assert.rejects(service.runZapUnsupportedCheck(operator, { themeNo: '999' }), /not implemented/u);
    await assert.rejects(service.runZapUnsupportedCheck(operator, { themeNo: '1' }), /auth-bypass\/checks/u);
  });

  test('ActiveScan 未許可・scope 外対象は拒否', async () => {
    const { service, operator } = await bootstrapFlow({
      allowedOperationClasses: ['Browse'],
      interactiveBrowser: flowBrowser(() => ({ finalUrl: '', status: 200, bodyText: '', assertionsPassed: false })),
    });
    service.registerLoginFlow(operator, { role: 'admin', flowVersion: 'f1', steps: loginSteps() });
    await assert.rejects(
      service.runZapUnsupportedCheck(operator, { themeNo: '2', role: 'admin', params: { defaultPairs: 'admin:admin', expectedUrlPrefix: `${BASE}/login.php` } }),
      /ActiveScan/u,
    );

    const { service: service2, operator: operator2 } = await flowWithSession({ browser: flowBrowser(() => ({ finalUrl: '', status: 200, bodyText: '', assertionsPassed: false })) });
    await assert.rejects(
      service2.runZapUnsupportedCheck(operator2, { themeNo: '18', targetUrls: ['http://other.example/page'] }),
      /out of scope/u,
    );
  });

  test('テーマ2: 既定資格 admin/admin で認証されれば exposed', async () => {
    const browser = flowBrowser(({ fills }) => {
      const accepted = fills['input[name="username"]'] === 'admin' && fills['input[name="password"]'] === 'admin';
      return accepted
        ? { finalUrl: `${BASE}/app/index.php`, status: 200, bodyText: 'Welcome Logout', assertionsPassed: true }
        : { finalUrl: `${BASE}/login.php`, status: 200, bodyText: 'Login failed', assertionsPassed: false };
    });
    const { service, operator } = await flowWithSession({ browser });
    const summary = await service.runZapUnsupportedCheck(operator, {
      themeNo: '2',
      role: 'admin',
      params: { defaultPairs: 'admin:admin\nadmin:password', expectedUrlPrefix: `${BASE}/app/` },
    });
    assert.equal(summary.status, 'fail');
    assert.equal(summary.totalRequests, 2);
    assert.equal(summary.results.find((probe) => probe.pattern === 'default-credential:admin')?.outcome, 'exposed');
    assert.equal(summary.results.find((probe) => probe.pattern === 'default-credential:password') === undefined, true);
  });

  test('テーマ3: 弱いパスワードの受理と応答への露出を検出する', async () => {
    const steps = JSON.stringify([
      { kind: 'navigate', target: `${BASE}/profile.php` },
      { kind: 'fill', target: 'input[name="current"]', secretReference: 'current' },
      { kind: 'fill', target: 'input[name="new"]', secretReference: 'newPassword' },
      { kind: 'click', target: 'button[name="change"]' },
      { kind: 'assert', target: 'Password changed' },
    ]);
    const browser = flowBrowser(({ fills }) => {
      // '1234567' だけ受理してしまう脆弱な実装。かつ応答に新しい値を echo する。
      const weak = fills['input[name="new"]'] ?? '';
      const accepted = weak === '1234567';
      const bodyText = accepted ? `Password changed. Your password is now ${weak}` : 'Password requirements not met';
      return { finalUrl: `${BASE}/profile.php`, status: 200, bodyText, assertionsPassed: accepted };
    });
    const { service, operator } = await flowWithSession({ browser });
    const summary = await service.runZapUnsupportedCheck(operator, {
      themeNo: '3',
      targetUrls: [`${BASE}/profile.php`],
      params: { steps, fieldReference: 'newPassword' },
      secretValues: { current: PASSWORD },
    });
    assert.equal(summary.status, 'fail');
    assert.equal(summary.results.find((probe) => probe.pattern === 'password-policy:1234567')?.outcome, 'exposed');
    assert.equal(summary.results.find((probe) => probe.pattern === 'password-policy:abcdefg')?.outcome, 'denied');
    assert.equal(summary.results.find((probe) => probe.pattern === 'password-echo-in-response')?.outcome, 'exposed');
  });

  test('テーマ4: 無効 token で再設定が成立しなければ pass。成立すれば fail', async () => {
    const steps = JSON.stringify([
      { kind: 'navigate', target: `${BASE}/reset.php` },
      { kind: 'fill', target: 'input[name="token"]', secretReference: 'token' },
      { kind: 'fill', target: 'input[name="password"]', secretReference: 'newPassword' },
      { kind: 'click', target: 'button[name="reset"]' },
      { kind: 'assert', target: 'Reset complete' },
    ]);
    const secureBrowser = flowBrowser(({ fills }) => {
      const accepted = fills['input[name="token"]'] === 'valid-token-from-email';
      return { finalUrl: accepted ? `${BASE}/reset.php` : `${BASE}/reset.php?error=invalid`, status: 200, bodyText: accepted ? 'Reset complete' : 'Invalid token', assertionsPassed: accepted };
    });
    const { service, operator } = await flowWithSession({ browser: secureBrowser });
    const pass = await service.runZapUnsupportedCheck(operator, {
      themeNo: '4',
      targetUrls: [`${BASE}/reset.php`],
      params: { steps, fieldReference: 'token' },
      secretValues: { newPassword: 'NewStrong!Pass1' },
    });
    assert.equal(pass.status, 'inconclusive');
    assert.deepEqual(pass.results.map((probe) => probe.pattern), ['token-emptied', 'token-forged', 'token-omitted']);
    assert.ok(pass.results.every((probe) => probe.outcome === 'denied'));
    assert.ok((pass.skipped ?? []).some((note) => note.includes('email')));

    const vulnerableBrowser = flowBrowser(() => ({ finalUrl: `${BASE}/reset.php`, status: 200, bodyText: 'Reset complete', assertionsPassed: true }));
    const { service: vulnService, operator: vulnOperator } = await flowWithSession({ browser: vulnerableBrowser });
    const fail = await vulnService.runZapUnsupportedCheck(vulnOperator, {
      themeNo: '4',
      targetUrls: [`${BASE}/reset.php`],
      params: { steps, fieldReference: 'token' },
      secretValues: { newPassword: 'NewStrong!Pass1' },
    });
    assert.equal(fail.status, 'fail');
  });

  test('テーマ5: 連続失敗後に正当資格が通れば ロックなし (exposed)。拒否されれば denied', async () => {
    let failuresSeen = 0;
    let lockoutEngaged = false;
    const executor: LoginExecutorPort = {
      engineVersion: 'fake-login-exec-1',
      execute: async (input) => {
        const correct = input.secretValues.password === PASSWORD;
        if (!correct) {
          failuresSeen += 1;
          if (failuresSeen >= 3) lockoutEngaged = true;
          return { authenticated: false, finalUrl: `${BASE}/login.php`, cookies: [] };
        }
        return { authenticated: !lockoutEngaged, finalUrl: `${BASE}/app/`, cookies: [{ name: 'sid', value: 'session-1', domain: 'fixture.target.test', path: '/' }] };
      },
    };
    const browser = flowBrowser(() => ({ finalUrl: '', status: 200, bodyText: '', assertionsPassed: false }));
    const { service, operator } = await flowWithSession({ browser, loginExecutor: executor });
    const noLockout = await service.runZapUnsupportedCheck(operator, {
      themeNo: '5',
      role: 'admin',
      params: { failureCount: '2', baseUrl: `${BASE}/` },
      secretValues: { username: 'admin', password: PASSWORD },
    });
    assert.equal(noLockout.status, 'fail');
    assert.equal(noLockout.totalRequests, 3);
    assert.equal(noLockout.results.at(-1)?.outcome, 'exposed');

    failuresSeen = 0;
    lockoutEngaged = false;
    const locked = await service.runZapUnsupportedCheck(operator, {
      themeNo: '5',
      role: 'admin',
      params: { failureCount: '3', baseUrl: `${BASE}/` },
      secretValues: { username: 'admin', password: PASSWORD },
    });
    assert.equal(locked.status, 'inconclusive');
    assert.equal(locked.results.at(-1)?.outcome, 'denied');
    assert.ok((locked.skipped ?? []).some((note) => note.includes('JMeter')));
    await assert.rejects(
      service.runZapUnsupportedCheck(operator, { themeNo: '5', role: 'admin', params: { failureCount: '21', baseUrl: `${BASE}/` }, secretValues: { username: 'admin', password: PASSWORD } }),
      /1..20/u,
    );
  });

  test('テーマ7: 既存/不在ユーザの応答差を列按として検出する', async () => {
    const browser = flowBrowser(({ fills }) => {
      const existing = fills['input[name="username"]'] === 'admin';
      const correct = existing && fills['input[name="password"]'] === PASSWORD;
      return {
        finalUrl: correct ? `${BASE}/app/` : `${BASE}/login.php`,
        status: 200,
        bodyText: correct ? 'Welcome Logout' : existing ? 'Username or password is incorrect' : 'User not found',
        assertionsPassed: correct,
      };
    });
    const { service, operator } = await flowWithSession({ browser });
    const summary = await service.runZapUnsupportedCheck(operator, {
      themeNo: '7',
      role: 'admin',
      params: { nonexistentUsername: 'ghost-user', baseUrl: `${BASE}/` },
      secretValues: { username: 'admin', password: PASSWORD },
    });
    assert.equal(summary.status, 'fail');
    assert.equal(summary.results.find((probe) => probe.pattern === 'response-comparison')?.outcome, 'exposed');

    const identical = flowBrowser(({ fills }) => {
      const correct = fills['input[name="username"]'] === 'admin' && fills['input[name="password"]'] === PASSWORD;
      return correct
        ? { finalUrl: `${BASE}/app/`, status: 200, bodyText: 'Welcome Logout', assertionsPassed: true }
        : { finalUrl: `${BASE}/login.php`, status: 200, bodyText: 'Username or password is incorrect', assertionsPassed: false };
    });
    const { service: safeService, operator: safeOperator } = await flowWithSession({ browser: identical });
    const safe = await safeService.runZapUnsupportedCheck(safeOperator, {
      themeNo: '7',
      role: 'admin',
      params: { nonexistentUsername: 'ghost-user', baseUrl: `${BASE}/` },
      secretValues: { username: 'admin', password: PASSWORD },
    });
    assert.equal(safe.status, 'pass');
    await assert.rejects(
      safeService.runZapUnsupportedCheck(safeOperator, { themeNo: '7', role: 'admin', params: { nonexistentUsername: 'admin', baseUrl: `${BASE}/` }, secretValues: { username: 'admin', password: PASSWORD } }),
      /must differ/u,
    );
  });

  test('テーマ10: 2ロールの正当応答と候補ロールの応答を比較する', async () => {
    const browser = flowBrowser(({ targetUrl, hasSession, sessionValues }) => {
      const id = new URL(targetUrl).searchParams.get('id');
      if (id === '1' && hasSession) return { finalUrl: targetUrl, status: 200, bodyText: 'Own record Logout', assertionsPassed: true };
      if (id === '2' && sessionValues.includes('session-beta')) return { finalUrl: targetUrl, status: 200, bodyText: 'Other record Logout', assertionsPassed: true };
      if (id === '2' && sessionValues.includes('session-admin')) return { finalUrl: targetUrl, status: 200, bodyText: 'Other record Logout', assertionsPassed: true };
      return { finalUrl: `${BASE}/login.php`, status: 200, bodyText: 'Please login', assertionsPassed: false };
    });
    const { service, operator } = await flowWithSession({ browser });
    service.registerLoginFlow(operator, { role: 'beta', flowVersion: 'f1', steps: loginSteps() });
    await service.runLogin(operator, { role: 'beta', baseUrl: `${BASE}/`, secretValues: { username: 'beta', password: PASSWORD }, expectedUrlPrefix: `${BASE}/app/` });
    const summary = await service.runZapUnsupportedCheck(operator, {
      themeNo: '10',
      role: 'admin',
      targetUrls: [`${BASE}/item.php?id=1`],
      params: { otherRole: 'beta', objectParam: 'id', ownValue: '1', otherValues: '2' },
    });
    assert.equal(summary.status, 'fail');
    assert.equal(summary.results.find((probe) => probe.pattern === 'other-object-candidate:2')?.outcome, 'exposed');
  });

  test('テーマ11: 特権 field の merge 要求が拒否されれば pass。受理されれば fail', async () => {
    const repeater = rawTransport(({ body }) => {
      const rejected = body.includes('"role"');
      return { status: rejected ? 400 : 200, body: rejected ? 'forbidden field' : 'profile updated' };
    });
    const { service, operator } = await flowWithSession({ browser: flowBrowser(() => ({ finalUrl: '', status: 200, bodyText: '', assertionsPassed: false })), repeater });
    const pass = await service.runZapUnsupportedCheck(operator, {
      themeNo: '11',
      role: 'admin',
      targetUrls: [`${BASE}/api/profile`],
      params: { method: 'POST', jsonBody: '{"name":"diag"}', extraFieldsJson: '{"role":"admin"}' },
    });
    assert.equal(pass.status, 'pass');
    assert.equal(pass.results.find((probe) => probe.pattern === 'mass-assignment')?.outcome, 'denied');

    const open = rawTransport(() => ({ status: 200, body: 'profile updated' }));
    const { service: vulnService, operator: vulnOperator } = await flowWithSession({ browser: flowBrowser(() => ({ finalUrl: '', status: 200, bodyText: '', assertionsPassed: false })), repeater: open });
    const fail = await vulnService.runZapUnsupportedCheck(vulnOperator, {
      themeNo: '11',
      targetUrls: [`${BASE}/api/profile`],
      params: { method: 'POST', jsonBody: '{"name":"diag"}', extraFieldsJson: '{"role":"admin"}' },
    });
    assert.equal(fail.status, 'inconclusive');
  });

  test('テーマ13: Origin 反射 ACAO を検出する (preflight 含む)', async () => {
    const repeater = rawTransport(({ headers }) => {
      const origin = headers['origin'] ?? '';
      const isOptions = (headers['access-control-request-method'] ?? '') !== '';
      if (isOptions) {
        return { status: 204, headers: [['Access-Control-Allow-Origin', origin], ['Access-Control-Allow-Methods', 'GET,POST']] };
      }
      return { status: 200, headers: [['Access-Control-Allow-Origin', origin], ['Access-Control-Allow-Credentials', 'true']], body: 'ok' };
    });
    const { service, operator } = await flowWithSession({ browser: flowBrowser(() => ({ finalUrl: '', status: 200, bodyText: '', assertionsPassed: false })), repeater });
    const summary = await service.runZapUnsupportedCheck(operator, {
      themeNo: '13',
      role: 'admin',
      targetUrls: [`${BASE}/api/data`],
      params: { evilOrigins: 'https://evil.example' },
    });
    assert.equal(summary.status, 'fail');
    assert.equal(summary.results.find((probe) => probe.pattern === 'origin-reflect:https://evil.example')?.outcome, 'exposed');
    const preflight = summary.results.find((probe) => probe.pattern === 'preflight:https://evil.example');
    assert.equal(preflight?.outcome, 'inconclusive');
    assert.ok(preflight?.detail?.includes('acaom=GET,POST'));

    const secure = rawTransport(() => ({ status: 200, body: 'ok' }));
    const { service: safeService, operator: safeOperator } = await flowWithSession({ browser: flowBrowser(() => ({ finalUrl: '', status: 200, bodyText: '', assertionsPassed: false })), repeater: secure });
    const safe = await safeService.runZapUnsupportedCheck(safeOperator, { themeNo: '13', role: 'admin', targetUrls: [`${BASE}/api/data`], params: { evilOrigins: 'https://evil.example' } });
    assert.equal(safe.status, 'pass');
  });

  test('テーマ18: リクエスト履歴サンプルの直列化署名を候補として観察する', async () => {
    const browser = flowBrowser(({ targetUrl }) => ({ finalUrl: targetUrl, status: 200, bodyText: '', assertionsPassed: false }));
    const { service, operator } = await flowWithSession({ browser });
    const summary = await service.runZapUnsupportedCheck(operator, { themeNo: '18', params: { requestSamples: 'Cookie: state=rO0ABXN0cmVhbQ==' } });
    assert.equal(summary.status, 'inconclusive');
    assert.equal(summary.results[0]?.outcome, 'inconclusive');
    assert.ok(summary.results[0]?.detail?.includes('java-base64'));
    assert.ok((summary.skipped ?? []).some((note) => note.includes('gadgets')));
  });

  test('テーマ20: 順次再送で marker が毎回成立すれば exposed。応答差のみなら marker 時と無 marker 時で判定が分かれる', async () => {
    let call = 0;
    const repeater = rawTransport(({ body }) => {
      call += 1;
      const applied = body.includes('coupon');
      return { status: 200, body: applied ? 'coupon applied' : 'no coupon' };
    });
    const { service, operator } = await flowWithSession({ browser: flowBrowser(() => ({ finalUrl: '', status: 200, bodyText: '', assertionsPassed: false })), repeater });
    const fail = await service.runZapUnsupportedCheck(operator, {
      themeNo: '20',
      role: 'admin',
      targetUrls: [`${BASE}/api/coupon`],
      params: { method: 'POST', body: '{"coupon":"A"}', repeatCount: '3', successMarker: 'coupon applied' },
    });
    assert.equal(fail.status, 'fail');
    assert.equal(fail.results.find((probe) => probe.pattern === 'replay-comparison')?.outcome, 'exposed');
    assert.equal(fail.results.filter((probe) => /^replay-[0-9]+$/u.test(probe.pattern)).length, 3);

    const onceOnly = rawTransport(() => ({ status: 200, body: call === 99 ? '' : 'already used' }));
    const { service: safeService, operator: safeOperator } = await flowWithSession({ browser: flowBrowser(() => ({ finalUrl: '', status: 200, bodyText: '', assertionsPassed: false })), repeater: onceOnly });
    const pass = await safeService.runZapUnsupportedCheck(safeOperator, {
      themeNo: '20',
      targetUrls: [`${BASE}/api/coupon`],
      params: { method: 'POST', body: '{"coupon":"A"}', repeatCount: '2', successMarker: 'coupon applied' },
    });
    assert.equal(pass.status, 'inconclusive');
  });

  test('テーマ21: 長大文字列で 5xx を返す параметr を堃牢性不足として検出する', async () => {
    const fuzz: FuzzTransportPort = {
      send: async (input) => {
        const value = input.combination[0] ?? '';
        const crashed = value.length >= 1000 || value === '2147483648';
        return { requestUrl: input.targetUrl, status: crashed ? 500 : 400, contentType: 'text/plain', contentLength: 0, bodyHash: `h:${String(value.length)}` };
      },
    };
    const { service, operator } = await flowWithSession({ browser: flowBrowser(() => ({ finalUrl: '', status: 200, bodyText: '', assertionsPassed: false })), fuzz });
    const summary = await service.runZapUnsupportedCheck(operator, {
      themeNo: '21',
      role: 'admin',
      targetUrls: [`${BASE}/search`],
      params: { paramName: 'q' },
    });
    assert.equal(summary.status, 'fail');
    const exposed = summary.results.filter((probe) => probe.outcome === 'exposed');
    assert.equal(exposed.length, 1);
    assert.ok(exposed.every((probe) => probe.pattern.startsWith('robustness:')));
  });

  test('テーマ22: 審査済み template id だけのスポット実行。match があれば exposed', async () => {
    const runCalls: (readonly string[])[] = [];
    const nuclei: NucleiScanPort = {
      engineVersion: 'nuclei-fake-3.11.1',
      run: async (input) => {
        runCalls.push(input.templateIds ?? []);
        return { lines: [JSON.stringify({ 'template-id': 'old-tls-detected', 'matched-at': 'http://fixture.target.test' })] };
      },
    };
    const { service, operator } = await flowWithSession({ browser: flowBrowser(() => ({ finalUrl: '', status: 200, bodyText: '', assertionsPassed: false })), nuclei });
    const summary = await service.runZapUnsupportedCheck(operator, {
      themeNo: '22',
      targetUrls: [`${BASE}/`],
      params: { templateIds: 'old-tls-detected, weak-cipher' },
    });
    assert.equal(summary.status, 'fail');
    assert.deepEqual(runCalls, [['old-tls-detected', 'weak-cipher']]);
    assert.ok(summary.results[0]?.detail?.includes('matches=1'));
    await assert.rejects(service.runZapUnsupportedCheck(operator, { themeNo: '22', targetUrls: [`${BASE}/`], params: { templateIds: '' } }), /1..20/u);
  });

  test('テーマ23: 平文 http が 200 を返し混在が無ければ fail (平文のみ)。redirect なら pass', async () => {
    const browser = flowBrowser(({ targetUrl }) => ({ finalUrl: targetUrl, status: 200, bodyText: '<html><script src="https://cdn.test/app.js"></script></html>', assertionsPassed: false }));
    const openPlain = rawTransport(({ targetUrl }) => ({ status: 200, body: 'secure content', redirects: targetUrl.startsWith('http://') ? [] : [] }));
    const { service, operator } = await flowWithSession({ browser, repeater: openPlain, allowedOrigins: ['http://fixture.target.test', 'https://fixture.target.test'] });
    const fail = await service.runZapUnsupportedCheck(operator, {
      themeNo: '23',
      targetUrls: ['https://fixture.target.test/'],
    });
    assert.equal(fail.status, 'fail');
    assert.equal(fail.results.find((probe) => probe.pattern === 'plain-http')?.outcome, 'exposed');
    assert.equal(fail.results.find((probe) => probe.pattern === 'mixed-content')?.outcome, 'denied');

    const redirectPlain = rawTransport(() => ({ status: 301, body: '', redirects: ['https://fixture.target.test/'] }));
    const { service: safeService, operator: safeOperator } = await flowWithSession({ browser, repeater: redirectPlain, allowedOrigins: ['http://fixture.target.test', 'https://fixture.target.test'] });
    const pass = await safeService.runZapUnsupportedCheck(safeOperator, { themeNo: '23', targetUrls: ['https://fixture.target.test/'] });
    assert.equal(pass.status, 'pass');
    await assert.rejects(safeService.runZapUnsupportedCheck(safeOperator, { themeNo: '23', targetUrls: [`http://fixture.target.test/`] }), /https:\/\/ target/u);
  });

  test('テーマ29: DOM 観測の PII 疑い node を検出する', async () => {
    const domObserver: DomObservationPort = {
      observe: async ({ targetUrl }) => ({
        observations: [],
        nodes: targetUrl.endsWith('/profile')
          ? [{ text: '[category:payment-card-unmasked;count=1]', looksLikePii: true }, { text: '[coverage:dom-text-classification]', looksLikePii: false }]
          : targetUrl.endsWith('/about')
            ? [{ text: 'About', looksLikePii: false }]
            : [],
      }),
    };
    const { service, operator } = await flowWithSession({ browser: flowBrowser(({ targetUrl }) => ({ finalUrl: targetUrl, status: 200, bodyText: '', assertionsPassed: false, headers: [['Cache-Control', 'no-store']] })), domObserver });
    const summary = await service.runZapUnsupportedCheck(operator, {
      themeNo: '29',
      role: 'admin',
      targetUrls: [`${BASE}/profile`, `${BASE}/about`, `${BASE}/empty`],
    });
    assert.equal(summary.status, 'fail');
    assert.equal(summary.results.find((probe) => probe.targetUrl.endsWith('/profile') && probe.pattern === 'pii-exposure')?.outcome, 'exposed');
    assert.equal(summary.results.find((probe) => probe.targetUrl.endsWith('/about') && probe.pattern === 'pii-exposure')?.outcome, 'denied');
    // 実 adapter と同じく nodes を返さない観測は判定保留 (未観測を問題なしにしない)。
    assert.equal(summary.results.find((probe) => probe.targetUrl.endsWith('/empty') && probe.pattern === 'pii-exposure')?.outcome, 'inconclusive');
    assert.ok(summary.results.find((probe) => probe.targetUrl.endsWith('/profile') && probe.pattern === 'pii-exposure')?.detail?.includes('confirmedUnmasked=1'));
  });

  test('履歴と監査 event に結果が残り、秘密値・cookie 値を含まない', async () => {
    const browser = flowBrowser(({ targetUrl }) => ({ finalUrl: targetUrl, status: 200, bodyText: '<html>ok</html>', assertionsPassed: false, headers: [['Cache-Control', 'no-store']] }));
    const domObserver: DomObservationPort = { observe: async () => ({ observations: [], nodes: [] }) };
    const { service, operator } = await flowWithSession({ browser, domObserver });
    const summary = await service.runZapUnsupportedCheck(operator, { themeNo: '29', role: 'admin', targetUrls: [`${BASE}/profile`] });
    const list = service.listZapUnsupportedChecks();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.checkId, summary.checkId);
    const serialized = JSON.stringify(summary) + JSON.stringify(list);
    assert.equal(serialized.includes(PASSWORD), false);
    assert.equal(serialized.includes('session-1'), false);
    const events = service.events().filter((event) => event.type === 'ZapUnsupportedCheckCompleted');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.themeNo, '29');
  });
});
