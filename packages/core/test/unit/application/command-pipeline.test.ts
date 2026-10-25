import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DomainError } from '@scopepilot2/contracts';
import { createTestService } from '../support/test-flow.ts';

describe('command pipeline permission gate (BaselineFlowService)', () => {
  test('[SYS-UT-001] 権限判定に失敗した command は副作用を実行しない', async () => {
    const { service } = createTestService({ operatorPermissions: ['case.read'] });
    const operator = {
      operatorId: 'operator-readonly',
      displayName: 'Readonly Operator',
      permissions: ['case.read' as const],
    };

    assert.throws(
      () =>
        service.createCase(operator, {
          name: 'should not be created',
          allowedOrigins: ['http://fixture.target.test'],
          deniedOrigins: [],
          limits: { maxRequests: 100, maxPages: 10, maxDurationMinutes: 10 },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'PermissionDenied');
        return true;
      },
    );

    // 案件は作られておらず、監査 event も残らない。
    assert.throws(() => service.currentCase(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'ValidationFailed');
      return true;
    });
    assert.deepEqual(service.events(), []);
  });
});
