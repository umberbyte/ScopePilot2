import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoginExecutionInput, LoginExecutorPort, LoginSessionCookie, ExplorationPort } from '@scopepilot2/core';
import type { PageObservation } from '@scopepilot2/contracts';
import { bootstrapFlow } from '../support/test-flow.ts';

/**
 * runLogin (design/f09 §4) の service 経路。登録済み flow の実行・session 保存・
 * 探索への role session 適用・監査 (参照のみ) を検証する。executor は fake。
 */
class FakeLoginExecutor implements LoginExecutorPort {
  readonly engineVersion = 'fake-login-1';
  readonly inputs: readonly LoginExecutionInput[] = [];
  nextResult: { authenticated: boolean; finalUrl: string; cookies: readonly LoginSessionCookie[] } = {
    authenticated: true,
    finalUrl: 'http://fixture.target.test/index.php',
    cookies: [{ name: 'PHPSESSID', value: 'session-secret-value', domain: 'fixture.target.test', path: '/' }],
  };

  async execute(input: LoginExecutionInput): Promise<{ authenticated: boolean; finalUrl: string; cookies: readonly LoginSessionCookie[] }> {
    (this.inputs as LoginExecutionInput[]).push(input);
    return this.nextResult;
  }
}

/** observeWithSession を持つ explorer (cookie 受取を記録)。 */
class SessionRecordingExplorer implements ExplorationPort {
  readonly engineVersion = 'session-explorer-1';
  readonly sessionCookiesPerCall: (readonly LoginSessionCookie[])[] = [];
  observeCalls = 0;

  async observe(): Promise<PageObservation | null> {
    throw new Error('observe should not be called when a role session is given');
  }

  async observeWithSession(
    url: string,
    session: { readonly cookies: readonly LoginSessionCookie[] },
  ): Promise<PageObservation | null> {
    this.observeCalls += 1;
    this.sessionCookiesPerCall.push(session.cookies);
    return {
      url,
      status: 200,
      contentType: 'text/html',
      discoveredFrom: null,
      depth: 0,
      originType: 'crawl',
      links: [],
      forms: [],
    };
  }
}

const LOGIN_STEPS = [
  { kind: 'navigate', target: 'http://fixture.target.test/login.php' },
  { kind: 'fill', target: 'input[name=username]', secretReference: 'vault://admin-user' },
  { kind: 'fill', target: 'input[name=password]', secretReference: 'vault://admin-pass' },
  { kind: 'click', target: 'input[type=submit]' },
  { kind: 'assert', target: 'Welcome' },
] as const;

describe('runLogin (service・design/f09)', () => {
  test('登録済み flow を実行し session を保存、探索の role 指定で cookie が使われる', async () => {
    const executor = new FakeLoginExecutor();
    const explorer = new SessionRecordingExplorer();
    const { service, operator } = await bootstrapFlow({ loginExecutor: executor, explorer });
    service.registerLoginFlow(operator, { role: 'admin', flowVersion: 'flow-1', steps: [...LOGIN_STEPS] });

    const login = await service.runLogin(operator, {
      role: 'admin',
      baseUrl: 'http://fixture.target.test',
      secretValues: { 'vault://admin-user': 'admin', 'vault://admin-pass': 'password123' },
      expectedUrlPrefix: 'http://fixture.target.test/',
    });
    assert.equal(login.authenticated, true);
    assert.deepEqual(login.cookieNames, ['PHPSESSID']);
    // executor は step と秘密値を受け取っている。
    assert.equal(executor.inputs.length, 1);
    assert.equal(executor.inputs[0]?.steps.length, 5);
    assert.equal(executor.inputs[0]?.secretValues['vault://admin-pass'], 'password123');

    // 探索 (role 指定) は session cookie を explorer へ渡す。
    const { plan } = service.buildExplorationPlan(operator, ['http://fixture.target.test/']);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);
    const run = await service.runExploration(operator, plan, confirmation, { maxDepth: 1, role: 'admin' });
    assert.equal(run.runRecord.state, 'Completed');
    assert.equal(explorer.observeCalls, 1);
    assert.deepEqual(explorer.sessionCookiesPerCall[0]?.map((cookie) => cookie.name), ['PHPSESSID']);

    // 監査 event は参照のみで、秘密値を含まない (F09-UT-006)。
    const eventsText = JSON.stringify(service.events());
    assert.ok(eventsText.includes('LoginCompleted'));
    assert.ok(eventsText.includes('vault://admin-user'));
    assert.ok(!eventsText.includes('password123'));
    assert.ok(!eventsText.includes('session-secret-value'));
  });

  test('未登録 role・秘密値不足・executor 未構成・assert 失敗はそれぞれ拒否/未保存', async () => {
    const executor = new FakeLoginExecutor();
    const { service, operator } = await bootstrapFlow({ loginExecutor: executor });
    service.registerLoginFlow(operator, { role: 'admin', flowVersion: 'flow-1', steps: [...LOGIN_STEPS] });

    await assert.rejects(
      service.runLogin(operator, {
        role: 'ghost',
        baseUrl: 'http://fixture.target.test',
        secretValues: {},
        expectedUrlPrefix: 'http://fixture.target.test/',
      }),
      /is not registered/,
    );
    await assert.rejects(
      service.runLogin(operator, {
        role: 'admin',
        baseUrl: 'http://fixture.target.test',
        secretValues: { 'vault://admin-user': 'admin' },
        expectedUrlPrefix: 'http://fixture.target.test/',
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, 'NeedsInput');
        return true;
      },
    );

    // executor 未構成の service では runLogin 不可。
    const bare = await bootstrapFlow();
    await assert.rejects(
      bare.service.runLogin(bare.operator, {
        role: 'admin',
        baseUrl: 'http://fixture.target.test',
        secretValues: {},
        expectedUrlPrefix: 'http://fixture.target.test/',
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, 'ValidationFailed');
        return true;
      },
    );

    // assert 失敗 (未認証) では session を保存しない。
    executor.nextResult = { authenticated: false, finalUrl: 'http://fixture.target.test/login.php', cookies: [] };
    const failed = await service.runLogin(operator, {
      role: 'admin',
      baseUrl: 'http://fixture.target.test',
      secretValues: { 'vault://admin-user': 'admin', 'vault://admin-pass': 'x' },
      expectedUrlPrefix: 'http://fixture.target.test/',
    });
    assert.equal(failed.authenticated, false);

    const { plan } = service.buildExplorationPlan(operator, ['http://fixture.target.test/']);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);
    await assert.rejects(
      service.runExploration(operator, plan, confirmation, { maxDepth: 1, role: 'admin' }),
      /no session for role/,
    );
  });

  test('role 指定探索は session 未登録と session 非対応 explorer を拒否する', async () => {
    const executor = new FakeLoginExecutor();
    const { service, operator } = await bootstrapFlow({ loginExecutor: executor });
    const { plan } = service.buildExplorationPlan(operator, ['http://fixture.target.test/']);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);
    await assert.rejects(
      service.runExploration(operator, plan, confirmation, { maxDepth: 1, role: 'nobody' }),
      /no session for role/,
    );

    // session はあるが explorer が observeWithSession 非対応。
    service.registerLoginFlow(operator, { role: 'admin', flowVersion: 'flow-1', steps: [...LOGIN_STEPS] });
    await service.runLogin(operator, {
      role: 'admin',
      baseUrl: 'http://fixture.target.test',
      secretValues: { 'vault://admin-user': 'a', 'vault://admin-pass': 'b' },
      expectedUrlPrefix: 'http://fixture.target.test/',
    });
    await assert.rejects(
      service.runExploration(operator, plan, confirmation, { maxDepth: 1, role: 'admin' }),
      /does not support session observation/,
    );
  });
});
