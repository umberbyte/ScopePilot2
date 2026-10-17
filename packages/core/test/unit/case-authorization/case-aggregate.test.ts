import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CaseAggregate, isScopeNarrower } from '@scopepilot2/core';
import type { CaseRecord, CaseScope, DomainError } from '@scopepilot2/contracts';
import { bootstrapFlow } from '../support/test-flow.ts';

function recordOf(scope: CaseScope, revision = 1): CaseRecord {
  return { caseId: 'case-0001', name: 'test', revision, scope, createdAt: '2026-10-18T09:00:00.000Z' };
}

const baseScope: CaseScope = {
  allowedOrigins: ['http://a.test', 'http://b.test'],
  deniedOrigins: [],
  limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
};

describe('CaseAggregate', () => {
  test('[F01-UT-007] stale revision では state を変えず Conflict になる', () => {
    const aggregate = CaseAggregate.open(recordOf(baseScope));
    aggregate.updateScope({ expectedRevision: 1, scope: baseScope });
    assert.equal(aggregate.revision, 2);

    assert.throws(
      () => aggregate.updateScope({ expectedRevision: 1, scope: { ...baseScope, allowedOrigins: ['http://a.test'] } }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'Conflict');
        return true;
      },
    );
    // state は変わらない。
    assert.equal(aggregate.revision, 2);
    assert.equal(aggregate.scope.allowedOrigins.length, 2);
  });

  test('[F01-UT-006] scope 縮小は confirmation を無効化し、拡張は無効化しない', () => {
    const aggregate = CaseAggregate.open(recordOf(baseScope));
    aggregate.registerConfirmation({ confirmationId: 'confirm-0001', planHash: 'hash-1' });
    aggregate.registerConfirmation({ confirmationId: 'confirm-0002', planHash: 'hash-2' });

    // 上限減 = 縮小。
    const narrowed = aggregate.updateScope({
      expectedRevision: 1,
      scope: { ...baseScope, limits: { maxRequests: 4000, maxPages: 500, maxDurationMinutes: 60 } },
    });
    assert.equal(narrowed.narrowed, true);
    assert.deepEqual(narrowed.invalidatedConfirmationIds, ['confirm-0001', 'confirm-0002']);
    assert.equal(aggregate.isConfirmationInvalidated('confirm-0001'), true);
    assert.equal(aggregate.invalidationReason('confirm-0001'), 'case scope narrowed');
    assert.deepEqual(aggregate.activeConfirmationIds(), []);

    // 再登録後に origin 追加 = 拡張では無効化しない。
    aggregate.registerConfirmation({ confirmationId: 'confirm-0003', planHash: 'hash-3' });
    const broadened = aggregate.updateScope({
      expectedRevision: 2,
      scope: { ...baseScope, allowedOrigins: ['http://a.test', 'http://b.test', 'http://c.test'] },
    });
    assert.equal(broadened.narrowed, false);
    assert.deepEqual(broadened.invalidatedConfirmationIds, []);
    assert.deepEqual(aggregate.activeConfirmationIds(), ['confirm-0003']);
  });

  test('isScopeNarrower は deny 追加と許可 origin 減を縮小と判定する', () => {
    assert.equal(isScopeNarrower(baseScope, { ...baseScope, deniedOrigins: ['http://x.test'] }), true);
    assert.equal(isScopeNarrower(baseScope, { ...baseScope, allowedOrigins: ['http://a.test'] }), true);
    assert.equal(isScopeNarrower(baseScope, { ...baseScope, limits: { maxRequests: 5000, maxPages: 499, maxDurationMinutes: 60 } }), true);
    assert.equal(isScopeNarrower(baseScope, baseScope), false);
  });

  test('[F01-UT-006] (service) scope 縮小で無効化 event が出て、無効化後の confirmation では実行できない', async () => {
    const { service, operator } = await bootstrapFlow();
    const { plan } = service.buildExplorationPlan(operator, ['http://fixture.target.test/']);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);

    const outcome = service.updateCaseScope(operator, {
      expectedRevision: 1,
      allowedOrigins: ['http://fixture.target.test'],
      deniedOrigins: [],
      limits: { maxRequests: 4000, maxPages: 500, maxDurationMinutes: 60 },
    });
    assert.equal(outcome.revision, 2);
    assert.equal(outcome.narrowed, true);
    assert.deepEqual(outcome.invalidatedConfirmationIds, [confirmation.confirmationId]);

    const events = service.events();
    const invalidated = events.find((event) => event.type === 'ConfirmationsInvalidated');
    assert.ok(invalidated !== undefined && invalidated.type === 'ConfirmationsInvalidated');
    assert.equal(invalidated.reason, 'case scope narrowed');
    assert.deepEqual(invalidated.confirmationIds, [confirmation.confirmationId]);
    const updated = events.find((event) => event.type === 'CaseScopeUpdated');
    assert.ok(updated !== undefined && updated.type === 'CaseScopeUpdated');
    assert.equal(updated.narrowed, true);

    // 無効化された confirmation では実行を開始できない。
    await assert.rejects(
      service.runExploration(operator, plan, confirmation, { maxDepth: 2 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'ConfirmationRequired');
        assert.match((error as DomainError).message, /invalidated/);
        return true;
      },
    );
  });
});
