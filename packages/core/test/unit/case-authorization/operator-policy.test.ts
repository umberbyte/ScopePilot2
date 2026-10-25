import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertOperatorMayActOnRole } from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

describe('OperatorPolicy', () => {
  test('[F01-UT-005] operator 名と対象 role 名が一致しても独立した権限として判定する', () => {
    // operator 'admin' が対象 role 'admin' への操作を要求しても、
    // 明示的な permission がなければ拒否する。
    assert.throws(
      () =>
        assertOperatorMayActOnRole({
          operatorId: 'admin',
          permissions: ['case.read'],
          targetRole: 'admin',
          required: 'run.manage',
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'PermissionDenied');
        assert.match((error as DomainError).message, /name matching the target role grants nothing/);
        return true;
      },
    );

    // permission を明示的に持っていれば、role 名の一致に関係なく許可する。
    assert.doesNotThrow(() =>
      assertOperatorMayActOnRole({
        operatorId: 'admin',
        permissions: ['run.manage'],
        targetRole: 'admin',
        required: 'run.manage',
      }),
    );
    assert.doesNotThrow(() =>
      assertOperatorMayActOnRole({
        operatorId: 'operator-a',
        permissions: ['run.manage'],
        targetRole: 'general-user',
        required: 'run.manage',
      }),
    );
  });
});
