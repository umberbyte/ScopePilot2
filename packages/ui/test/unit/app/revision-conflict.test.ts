import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { revisionConflictDecision } from '../../../src/app/revision-conflict.ts';

describe('revisionConflict', () => {
  test('[UI-UT-006] stale revision は自動上書きせず再読込を案内する', () => {
    const conflicted = revisionConflictDecision(
      { caseId: 'case-0001', revision: 3 },
      { caseId: 'case-0001', revision: 5 },
    );
    assert.equal(conflicted.conflicted, true);
    assert.match(conflicted.message ?? '', /表示 3 \/ 最新 5/);
    assert.match(conflicted.message ?? '', /自動上書きは行いません/);

    assert.deepEqual(
      revisionConflictDecision({ caseId: 'case-0001', revision: 5 }, { caseId: 'case-0001', revision: 5 }),
      { conflicted: false },
    );
    assert.deepEqual(
      revisionConflictDecision({ caseId: 'case-0001', revision: 1 }, { caseId: 'case-0002', revision: 9 }),
      { conflicted: false },
    );
  });
});
