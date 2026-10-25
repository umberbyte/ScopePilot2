import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clampToGrant, ProgressSubscriber, SignalController, verifyAutomationGrant, type AutomationGrantShape } from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

const grant: AutomationGrantShape = {
  issuer: 'ci@example',
  subject: 'operator-ci',
  caseId: 'case-0001',
  planHash: 'a'.repeat(64),
  allowedCommands: ['run.start'],
  operationClasses: ['ActiveScan'],
  expiresAt: '2026-10-18T12:00:00.000Z',
  maxRequests: 1000,
  maxDurationMinutes: 30,
};

describe('cli-automation (F21 残り)', () => {
  test('[F21-UT-002] plan hash・期限不一致は実行を拒否する', () => {
    assert.deepEqual(verifyAutomationGrant(grant, { planHash: grant.planHash, command: 'run.start', now: '2026-10-18T09:00:00.000Z' }), { allowed: true });
    const expired = verifyAutomationGrant(grant, { planHash: grant.planHash, command: 'run.start', now: '2026-10-18T12:00:00.000Z' });
    assert.equal(expired.allowed, false);
    assert.match((expired as { reason: string }).reason, /expired/);
    const wrongHash = verifyAutomationGrant(grant, { planHash: 'b'.repeat(64), command: 'run.start', now: '2026-10-18T09:00:00.000Z' });
    assert.equal(wrongHash.allowed, false);
    assert.match((wrongHash as { reason: string }).reason, /different plan hash/);
    const wrongCommand = verifyAutomationGrant(grant, { planHash: grant.planHash, command: 'case.delete', now: '2026-10-18T09:00:00.000Z' });
    assert.equal(wrongCommand.allowed, false);
  });

  test('[F21-UT-003] CLI option で grant の上限を拡張できない', () => {
    assert.deepEqual(clampToGrant({ maxRequests: 500, maxDurationMinutes: 10 }, grant), { maxRequests: 500, maxDurationMinutes: 10 });
    assert.throws(() => clampToGrant({ maxRequests: 1001, maxDurationMinutes: 10 }, grant), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'PermissionDenied');
      assert.match((error as DomainError).message, /cannot exceed automation grant limits/);
      return true;
    });
    assert.throws(() => clampToGrant({ maxRequests: 500, maxDurationMinutes: 31 }, grant), /cannot exceed/);
  });

  test('[F21-UT-006] SSE 再接続は cursor から重複なく再開する', () => {
    const subscriber = new ProgressSubscriber();
    const first = subscriber.receive([
      { eventId: 1, payload: 'a' },
      { eventId: 2, payload: 'b' },
    ]);
    assert.equal(first.duplicates, 0);
    assert.equal(subscriber.cursor(), 2);
    // 再接続時に server が cursor 以前も再送してきても重複採らない。
    const reconnected = subscriber.receive([
      { eventId: 2, payload: 'b' },
      { eventId: 3, payload: 'c' },
    ]);
    assert.deepEqual(
      reconnected.accepted.map((event) => event.eventId),
      [3],
    );
    assert.equal(reconnected.duplicates, 1);
    assert.deepEqual(
      subscriber.all().map((event) => event.payload),
      ['a', 'b', 'c'],
    );
  });

  test('[F21-UT-008] SIGINT 二回: 1 回目は協調停止、期限後 2 回目は interrupted', () => {
    const controller = new SignalController();
    assert.equal(controller.signal(0, 10_000), 'stop-requested');
    assert.equal(controller.signal(5_000, 10_000), 'stop-requested');
    assert.equal(controller.signal(10_000, 10_000), 'interrupted');
    assert.equal(controller.signalCount, 3);
  });
});
