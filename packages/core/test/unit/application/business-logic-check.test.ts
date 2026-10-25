import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { InteractiveBrowserPort, LoginExecutorPort } from '../../../src/ports/engines.ts';
import { bootstrapFlow } from '../support/test-flow.ts';

describe('business logic check (service)', () => {
  test('CrossRoleTest未許可ならブラウザーを起動しない', async () => {
    const { service, operator } = await bootstrapFlow();
    service.registerLoginFlow(operator, { role: 'admin', flowVersion: 'f', steps: [{ kind: 'navigate' }] });
    service.registerLoginFlow(operator, { role: 'guest', flowVersion: 'f', steps: [{ kind: 'navigate' }] });
    await assert.rejects(service.runBusinessLogicCheck(operator, {
      roles: ['admin', 'guest'], targetUrl: 'http://fixture.target.test/admin-only',
      expectation: { expression: 'body.contains', args: ['business-response:admin'] },
    }), /CrossRoleTest/u);
  });

  test('実ブラウザーポートでロール別応答を観測し、未認証ロールはinconclusiveにする', async () => {
    let loginIndex = 0;
    const loginExecutor: LoginExecutorPort = {
      engineVersion: 'fake-login-1',
      execute: async (input) => {
        const role = loginIndex++ === 0 ? 'admin' : 'guest';
        return { authenticated: true, finalUrl: input.expectedUrlPrefix, cookies: [{ name: 'sid', value: role, domain: 'fixture.target.test', path: '/' }] };
      },
    };
    const interactiveBrowser: InteractiveBrowserPort = {
      engineVersion: 'fake-business-browser-1',
      execute: async (input) => {
        const role = input.sessionCookies?.find((cookie) => cookie.name === 'sid')?.value ?? 'unknown';
        return {
          finalUrl: input.targetUrl, status: 200, bodyHash: `hash-${role}`, bodyText: `business-response:${role}`,
          headers: [['content-type', 'text/html']], elapsedMs: 5, assertions: [],
        };
      },
    };
    const { service, operator } = await bootstrapFlow({ loginExecutor, interactiveBrowser });
    await service.grantAuthorization(operator, {
      allowedOperationClasses: ['Browse', 'ActiveScan', 'CrossRoleTest'], targetRoles: ['admin', 'guest'],
      validFrom: '2026-10-18T00:00:00.000Z', validUntil: '2026-10-19T00:00:00.000Z',
      evidence: { label: '認可', content: 'x' },
    });
    service.registerLoginFlow(operator, { role: 'admin', flowVersion: 'f', steps: [{ kind: 'navigate' }] });
    service.registerLoginFlow(operator, { role: 'guest', flowVersion: 'f', steps: [{ kind: 'navigate' }] });

    await service.runLogin(operator, { role: 'admin', baseUrl: 'http://fixture.target.test/', secretValues: {}, expectedUrlPrefix: 'http://fixture.target.test/' });
    const inconclusive = await service.runBusinessLogicCheck(operator, {
      roles: ['admin', 'guest'], targetUrl: 'http://fixture.target.test/admin-only',
      expectation: { expression: 'body.contains', args: ['business-response:admin'] },
    });
    assert.equal(inconclusive.comparison.outcome, 'inconclusive');
    assert.equal(inconclusive.status, 'fail');

    await service.runLogin(operator, { role: 'guest', baseUrl: 'http://fixture.target.test/', secretValues: {}, expectedUrlPrefix: 'http://fixture.target.test/' });
    const pass = await service.runBusinessLogicCheck(operator, {
      roles: ['admin', 'guest'], targetUrl: 'http://fixture.target.test/admin-only',
      expectation: { expression: 'body.contains', args: ['business-response:admin'] },
    });
    assert.equal(pass.comparison.outcome, 'pass');
    assert.equal(pass.restore.outcome, 'restored');
    assert.equal(pass.status, 'pass');
    assert.equal(pass.matrix.evidenceSeparated, true);

    const fail = await service.runBusinessLogicCheck(operator, {
      roles: ['admin', 'guest'], targetUrl: 'http://fixture.target.test/admin-only',
      expectation: { expression: 'body.contains', args: ['business-response:guest'] },
    });
    assert.equal(fail.comparison.outcome, 'fail');
    assert.equal(fail.restore.outcome, 'restore-failed');
    assert.equal(fail.status, 'fail');
  });
});
