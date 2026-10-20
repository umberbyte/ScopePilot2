import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CaseRecord } from '@scopepilot2/contracts';
import { createTestService } from '../support/test-flow.ts';

/** 手書き fake: 保存を記録するだけ (run-sink.test.ts と同じ形式)。 */
class RecordingCaseSink {
  readonly saved: CaseRecord[] = [];
  save(record: CaseRecord): void {
    this.saved.push(record);
  }
}

const CASE_INPUT = {
  name: 'sink-test',
  allowedOrigins: ['http://fixture.target.test'],
  deniedOrigins: [] as string[],
  limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
} as const;

describe('case persistence (caseSink)', () => {
  test('保存済み案件と認可を監査eventを捏造せず復元する', () => {
    const { service } = createTestService();
    const record: CaseRecord = {
      caseId: 'case-restored',
      name: 'restored',
      revision: 3,
      scope: { allowedOrigins: ['https://example.test'], deniedOrigins: [], limits: { maxRequests: 20, maxPages: 10, maxDurationMinutes: 5 } },
      createdAt: '2026-10-20T00:00:00.000Z',
    };
    service.restoreWorkspace(record, {
      authorizationId: 'authz-restored',
      caseId: record.caseId,
      allowedOperationClasses: ['Browse'],
      targetRoles: ['member'],
      validFrom: '2026-10-20T00:00:00.000Z',
      validUntil: '2026-11-20T00:00:00.000Z',
      evidenceRef: { evidenceId: 'evidence-restored', sha256: 'b'.repeat(64), label: '依頼書' },
    });
    assert.deepEqual(service.currentCase(), record);
    assert.equal(service.currentAuthorization().authorizationId, 'authz-restored');
    assert.deepEqual(service.events(), []);
  });

  test('案件作成と scope 更新のたびに案件記録を保存する (runs FK の参照先)', () => {
    const sink = new RecordingCaseSink();
    const { service, operator } = createTestService({ caseSink: sink });
    const created = service.createCase(operator, CASE_INPUT);
    assert.equal(sink.saved.length, 1);
    assert.equal(sink.saved[0]?.caseId, created.caseId);
    assert.equal(sink.saved[0]?.revision, 1);

    service.updateCaseScope(operator, {
      expectedRevision: created.revision,
      allowedOrigins: ['http://fixture.target.test'],
      deniedOrigins: ['http://denied.fixture.target.test'],
      limits: CASE_INPUT.limits,
    });
    assert.equal(sink.saved.length, 2);
    assert.equal(sink.saved[1]?.revision, 2, 'scope 更新後の revision を保存する');
  });

  test('保存に失敗したら案件操作も失敗する (保存を黙見しない)', () => {
    const { service, operator } = createTestService({
      caseSink: {
        save(): void {
          throw new Error('disk full');
        },
      },
    });
    assert.throws(() => service.createCase(operator, CASE_INPUT), /disk full/);
  });
});
