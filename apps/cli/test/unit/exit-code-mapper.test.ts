import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ExitCodes, exitCodeForDomainError, exitCodeForStopReason } from '../../src/exit-codes.ts';

describe('ExitCodeMapper', () => {
  test('[F21-UT-005] engine 失敗・中断・上限停止・範囲違反は固定の異なる code になる', () => {
    assert.equal(exitCodeForDomainError('EngineFailure'), ExitCodes.EngineFailure);
    assert.equal(exitCodeForDomainError('EngineFailure'), 7);
    assert.equal(exitCodeForDomainError('Cancelled'), ExitCodes.Cancelled);
    assert.equal(exitCodeForDomainError('Cancelled'), 8);
    assert.equal(exitCodeForStopReason('budget-exhausted'), ExitCodes.BudgetStop);
    assert.equal(exitCodeForStopReason('budget-exhausted'), 5);
    assert.equal(exitCodeForStopReason('scope-violation'), ExitCodes.OutOfScope);
    assert.equal(exitCodeForStopReason('scope-violation'), 6);
    assert.equal(exitCodeForStopReason('authorization-expired'), ExitCodes.Permission);
    assert.equal(exitCodeForStopReason('authorization-expired'), 3);
    assert.equal(exitCodeForDomainError('ValidationFailed'), ExitCodes.Validation);
    assert.equal(exitCodeForDomainError('ValidationFailed'), 2);
    assert.equal(exitCodeForDomainError('PermissionDenied'), ExitCodes.Permission);
    assert.equal(exitCodeForDomainError('OutOfScope'), ExitCodes.OutOfScope);
    assert.equal(exitCodeForDomainError('ConfirmationRequired'), ExitCodes.ConfirmationRequired);
    assert.equal(exitCodeForStopReason('completed'), ExitCodes.Success);
    assert.equal(exitCodeForStopReason('completed'), 0);
    // 全体で code が一意に分離していること (所見あり 4 は domain error から出ない)。
    const codes = new Set([
      ExitCodes.Success,
      ExitCodes.Unexpected,
      ExitCodes.Validation,
      ExitCodes.Permission,
      ExitCodes.FindingsPresent,
      ExitCodes.BudgetStop,
      ExitCodes.OutOfScope,
      ExitCodes.EngineFailure,
      ExitCodes.Cancelled,
      ExitCodes.ConfirmationRequired,
    ]);
    assert.equal(codes.size, 10);
  });
});
