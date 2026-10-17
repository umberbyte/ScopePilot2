import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DomainError } from '@scopepilot2/contracts';
import { bootstrapFlow, TEST_NOW } from '../support/test-flow.ts';

describe('AuthorizationPolicy (BaselineFlowService.authorizePlan)', () => {
  test('[F01-UT-003] 認可されていない OperationClass の計画は PermissionDenied となる', async () => {
    const { service, operator } = await bootstrapFlow({ allowedOperationClasses: ['Browse'] });
    const { plan: scanPlan } = service.buildActiveScanPlan(operator, ['http://fixture.target.test/']);
    assert.throws(
      () => service.authorizePlan(scanPlan),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'PermissionDenied');
        assert.match(error.message, /ActiveScan/);
        return true;
      },
    );
  });

  test('[F01-UT-004] 認可期限の境界では終了時刻以降を拒否する', async () => {
    // validUntil == now (境界): now >= validUntil なので拒否する。
    const expired = await bootstrapFlow({ validFrom: '2026-10-18T00:00:00.000Z', validUntil: TEST_NOW });
    const { plan: expiredPlan } = expired.service.buildExplorationPlan(expired.operator, ['http://fixture.target.test/']);
    assert.throws(
      () => expired.service.authorizePlan(expiredPlan),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'PermissionDenied');
        return true;
      },
    );

    // validUntil が now より後: 検証を通る。
    const active = await bootstrapFlow({ validUntil: '2026-10-18T09:00:00.001Z' });
    const { plan: activePlan } = active.service.buildExplorationPlan(active.operator, ['http://fixture.target.test/']);
    active.service.authorizePlan(activePlan);
  });
});
