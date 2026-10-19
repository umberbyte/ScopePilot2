import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoginExecutionInput, LoginExecutorPort, LoginSessionCookie } from '@scopepilot2/core';
import { bootstrapFlow } from '../support/test-flow.ts';

/**
 * 能動診断 (F11) への role session 適用 (design/08)。scan request には適用 cookie の
 * 名前のみが添えられる (値は入れない — API 応答に scanRequest が映るため)。
 */
describe('active scan session (design/08)', () => {
  test('role 指定の診断は適用 cookie 名を scan request に添える。未登録 role は拒否', async () => {
    const executor = new (class implements LoginExecutorPort {
      readonly engineVersion = 'fake-login-1';
      nextCookies: readonly LoginSessionCookie[] = [{ name: 'PHPSESSID', value: 'session-value', domain: 'fixture.target.test', path: '/' }];
      async execute(
        input: LoginExecutionInput,
      ): Promise<{ authenticated: boolean; finalUrl: string; cookies: readonly LoginSessionCookie[] }> {
        return { authenticated: true, finalUrl: 'http://fixture.target.test/', cookies: [...this.nextCookies] };
      }
    })();
    const { service, operator } = await bootstrapFlow({ loginExecutor: executor });
    service.registerLoginFlow(operator, {
      role: 'admin',
      flowVersion: 'f1',
      steps: [
        { kind: 'navigate', target: 'http://fixture.target.test/login.php' },
        { kind: 'fill', target: '#u', secretReference: 'vault://admin-user' },
        { kind: 'fill', target: '#p', secretReference: 'vault://admin-pass' },
        { kind: 'click', target: 'input[type=submit]' },
        { kind: 'assert', target: 'Welcome' },
      ],
    });
    await service.runLogin(operator, {
      role: 'admin',
      baseUrl: 'http://fixture.target.test',
      secretValues: { 'vault://admin-user': 'admin', 'vault://admin-pass': 'password123' },
      expectedUrlPrefix: 'http://fixture.target.test/',
    });

    const { plan } = service.buildActiveScanPlan(operator, ['http://fixture.target.test/', 'http://fixture.target.test/login.php']);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);
    const adopted = [
      { candidateId: 'c1', url: 'http://fixture.target.test/', method: 'GET' as const, category: 'page' as const, guidelineBasis: [], confidence: 0.5, observationUrl: 'http://fixture.target.test/' },
    ];
    const result = await service.runActiveScan(operator, plan, confirmation, adopted, 'admin');
    assert.equal(result.runRecord.state, 'Completed');
    assert.deepEqual(result.scanRequest.sessionCookieNames, ['PHPSESSID']);
    assert.equal(JSON.stringify(result.scanRequest).includes('session-value'), false, 'cookie 値は要求に入れない');

    // role 未指定は従来どおり session なし。
    const plain = await service.runActiveScan(operator, plan, service.confirmPlan(plan, operator), adopted);
    assert.equal(plain.scanRequest.sessionCookieNames, undefined);

    // 未登録 role は拒否。
    await assert.rejects(service.runActiveScan(operator, plan, confirmation, adopted, 'ghost'), /no session for role/);

    // 対象 URL のどれにも一致しない domain の cookie は添えない。
    executor.nextCookies = [{ name: 'OTHER', value: 'v', domain: 'elsewhere.example', path: '/' }];
    await service.runLogin(operator, {
      role: 'admin',
      baseUrl: 'http://fixture.target.test',
      secretValues: { 'vault://admin-user': 'admin', 'vault://admin-pass': 'password123' },
      expectedUrlPrefix: 'http://fixture.target.test/',
    });
    const filtered = await service.runActiveScan(operator, plan, service.confirmPlan(plan, operator), adopted, 'admin');
    assert.deepEqual(filtered.scanRequest.sessionCookieNames, [], '別 Origin の cookie は適用しない');
  });
});
