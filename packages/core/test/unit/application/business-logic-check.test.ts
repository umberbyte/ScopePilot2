import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

/** 業務ロジック検証の service 経路 (design/f17)。認可・session・観測・restore の連結。 */
describe('business logic check (service)', () => {
  test('CrossRoleTest 未許可の認可では実行できない', async () => {
    const { service, operator } = await bootstrapFlow();
    service.registerLoginFlow(operator, { role: 'admin', flowVersion: 'f', steps: [{ kind: 'navigate' }] });
    service.registerLoginFlow(operator, { role: 'guest', flowVersion: 'f', steps: [{ kind: 'navigate' }] });
    await assert.rejects(
      service.runBusinessLogicCheck(operator, {
        roles: ['admin', 'guest'],
        targetUrl: 'http://fixture.target.test/admin-only',
        expectation: { expression: 'body.contains', args: ['business-response:admin'] },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'OutOfScope');
        assert.match((error as { message?: string }).message ?? '', /CrossRoleTest/);
        return true;
      },
    );
  });

  test('session 未 refresh の role があると inconclusive、揃うと pass/fail が確定する', async () => {
    const { service, operator } = await bootstrapFlow();
    // CrossRoleTest を許可する認可を付与し直す。
    await service.grantAuthorization(operator, {
      allowedOperationClasses: ['Browse', 'ActiveScan', 'CrossRoleTest'],
      targetRoles: ['admin', 'guest'],
      validFrom: '2026-10-18T00:00:00.000Z',
      validUntil: '2026-10-19T00:00:00.000Z',
      evidence: { label: '認可', content: 'x' },
    });
    service.registerLoginFlow(operator, { role: 'admin', flowVersion: 'f', steps: [{ kind: 'navigate' }] });
    service.registerLoginFlow(operator, { role: 'guest', flowVersion: 'f', steps: [{ kind: 'navigate' }] });

    // guest が未 refresh → 観測欠落は inconclusive (成功/失敗を推測しない)。
    await service.refreshSession(operator, 'admin');
    const inconclusive = await service.runBusinessLogicCheck(operator, {
      roles: ['admin', 'guest'],
      targetUrl: 'http://fixture.target.test/admin-only',
      expectation: { expression: 'body.contains', args: ['business-response:admin'] },
    });
    assert.equal(inconclusive.comparison.outcome, 'inconclusive');
    assert.equal(inconclusive.status, 'fail', 'inconclusive は pass 扱いにしない');

    // 両 role の session が揃い期待と一致すれば pass。
    await service.refreshSession(operator, 'guest');
    const pass = await service.runBusinessLogicCheck(operator, {
      roles: ['admin', 'guest'],
      targetUrl: 'http://fixture.target.test/admin-only',
      expectation: { expression: 'body.contains', args: ['business-response:admin'] },
    });
    assert.equal(pass.comparison.outcome, 'pass');
    assert.equal(pass.restore.outcome, 'restored');
    assert.equal(pass.status, 'pass');
    assert.equal(pass.matrix.evidenceSeparated, true, 'role 間で session/evidence は分離');

    // 期待と不一致なら fail + restore も失敗扱い (全体を成功にしない)。
    const fail = await service.runBusinessLogicCheck(operator, {
      roles: ['admin', 'guest'],
      targetUrl: 'http://fixture.target.test/admin-only',
      expectation: { expression: 'body.contains', args: ['business-response:guest'] },
    });
    assert.equal(fail.comparison.outcome, 'fail');
    assert.equal(fail.restore.outcome, 'restore-failed');
    assert.equal(fail.status, 'fail');
  });
});
