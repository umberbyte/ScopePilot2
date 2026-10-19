import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { confirmationStillValid } from '../../../src/commands/plan-confirmation.ts';
import type { PlanConfirmation } from '@scopepilot2/contracts';

const confirmation = (planHash: string): PlanConfirmation => ({
  confirmationId: 'confirm-0001',
  planHash,
  confirmedBy: 'operator-1',
  confirmedAt: '2026-10-19T00:00:00.000Z',
  confirmedView: [],
});

describe('planConfirmation command', () => {
  test('[UI-UT-005] 表示後に plan hash が変化したら confirmation を無効化する', () => {
    const hash = 'a'.repeat(64);
    assert.equal(confirmationStillValid({ displayedPlanHash: hash, confirmation: confirmation(hash) }, hash), true);
    // 現在の計画 hash が変わった。
    assert.equal(confirmationStillValid({ displayedPlanHash: hash, confirmation: confirmation(hash) }, 'b'.repeat(64)), false);
    // 表示と確認の hash が食い違う (確認後に再生成された等)。
    assert.equal(confirmationStillValid({ displayedPlanHash: 'c'.repeat(64), confirmation: confirmation(hash) }, 'c'.repeat(64)), false);
    // confirmation 未発行。
    assert.equal(confirmationStillValid({ displayedPlanHash: hash }, hash), false);
  });
});
