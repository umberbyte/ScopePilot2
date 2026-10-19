import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { executionSummary } from '../../../src/presenters/execution-summary.ts';
import type { PlanStep } from '@scopepilot2/contracts';

const step = (guarantee: PlanStep['guarantee']): PlanStep => ({
  stepId: 'plan-0001-s1',
  kind: 'explore',
  operationClass: 'Browse',
  targetSnapshot: ['http://a.test/'],
  engineKind: 'zap',
  guarantee,
  limits: { maxRequests: 1, maxPages: 1, maxDurationMinutes: 1, maxConcurrency: 1, requestsPerSecond: 1 },
});

describe('executionSummary presenter', () => {
  test('[UI-UT-003] 委譲 step は ScopePilot 強制と分けて表示する', () => {
    const rows = executionSummary([step('Enforced'), step('Delegated')]);
    assert.equal(rows[0]?.preSendGuaranteed, true);
    assert.match(rows[0]?.label ?? '', /ScopePilot が各送信/);
    assert.equal(rows[1]?.preSendGuaranteed, false);
    assert.match(rows[1]?.label ?? '', /送信前拒否は保証しない/);
    const unsupported = executionSummary([step('Unsupported')]);
    assert.equal(unsupported[0]?.preSendGuaranteed, false);
    assert.match(unsupported[0]?.label ?? '', /公開されない/);
  });
});
