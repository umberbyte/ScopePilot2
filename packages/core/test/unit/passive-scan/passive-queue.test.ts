import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PassiveQueue, planPassiveBatches, ZapAlertImporter, normalizeSeverity, coverageLimitations, type PassiveAlertInput } from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

const alert: PassiveAlertInput = {
  ruleId: '10035',
  sourceInstance: 'pscanrules-76',
  messageReference: 'msg-0001',
  name: 'Strict-Transport-Security Header Not Set (fixture)',
  sourceSeverity: 'Medium',
  url: 'http://fixture.target.test/',
  evidenceId: 'evidence-0001',
};

describe('PassiveQueue', () => {
  test('[F10-UT-001] 同一 exchange の再登録は 1 item だけを保持する', () => {
    const queue = new PassiveQueue();
    assert.deepEqual(queue.register({ exchangeEvidenceId: 'ev-1', sizeBytes: 100 }), { registered: true });
    assert.deepEqual(queue.register({ exchangeEvidenceId: 'ev-1', sizeBytes: 100 }), { registered: false });
    assert.equal(queue.pending().length, 1);
  });

  test('[F10-UT-007] analyzer 失敗は retryable failure となり queue 全体を成功扱いしない', () => {
    const queue = new PassiveQueue();
    queue.register({ exchangeEvidenceId: 'ev-1', sizeBytes: 100 });
    queue.register({ exchangeEvidenceId: 'ev-2', sizeBytes: 100 });
    queue.markRetryableFailure('ev-1', 'analyzer exception');
    assert.equal(queue.failures().length, 1);
    assert.equal(queue.failures()[0]?.failureReason, 'analyzer exception');
    assert.equal(queue.pending().length, 1, '失敗 item を pending から除外し、全体成功扱いにしない');
  });
});

describe('PassiveBatchPlanner', () => {
  test('[F10-UT-002] 1,000 件 / 25 MiB 境界の超過前で分割する', () => {
    const thousand = Array.from({ length: 1000 }, (_, i) => ({ exchangeEvidenceId: `ev-${i}`, sizeBytes: 1024 }));
    const batches = planPassiveBatches(thousand);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.length, 1000);

    const thousandOne = [...thousand, { exchangeEvidenceId: 'ev-extra', sizeBytes: 1024 }];
    const split = planPassiveBatches(thousandOne);
    assert.equal(split.length, 2);
    assert.equal(split[0]?.length, 1000);
    assert.equal(split[1]?.length, 1);

    const bigByte = planPassiveBatches([
      { exchangeEvidenceId: 'a', sizeBytes: 20 * 1024 * 1024 },
      { exchangeEvidenceId: 'b', sizeBytes: 10 * 1024 * 1024 },
    ]);
    assert.equal(bigByte.length, 2, 'byte 上限でも同様に超過前に分割');
  });
});

describe('ZapAlertImporter / FindingNormalizer', () => {
  test('[F10-UT-003] alert 重複は既存 finding candidate を参照する', () => {
    const importer = new ZapAlertImporter();
    const first = importer.importAlert(alert);
    const second = importer.importAlert({ ...alert, evidenceId: 'evidence-0002' });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.candidate.key, first.candidate.key);
    assert.deepEqual(second.candidate.evidenceIds, ['evidence-0001', 'evidence-0002']);
    assert.equal(importer.list().length, 1);
  });

  test('[F10-UT-004] source severity 不明は Unknown を保持し推測しない', () => {
    const importer = new ZapAlertImporter();
    const { candidate } = importer.importAlert({ ...alert, sourceSeverity: 'informational (custom)' });
    assert.equal(candidate.severity, 'unknown');
    assert.equal(candidate.sourceSeverity, 'informational (custom)', '原値を保持');
    assert.equal(normalizeSeverity('High'), 'high');
    assert.equal(normalizeSeverity('低'), 'unknown');
  });

  test('[F10-UT-005] evidence なしでは finding 生成を拒否する', () => {
    const importer = new ZapAlertImporter();
    assert.throws(() => importer.importAlert({ ...alert, evidenceId: '' }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'ValidationFailed');
      assert.match((error as DomainError).message, /at least one observed evidence/);
      return true;
    });
  });
});

describe('CoverageSummary', () => {
  test('[F10-UT-006] body truncate は limitation として表示する', () => {
    const limitations = coverageLimitations([
      { url: 'http://a.test/1', bodyTruncated: true, bodyAbsent: false },
      { url: 'http://a.test/2', bodyTruncated: false, bodyAbsent: true },
      { url: 'http://a.test/3', bodyTruncated: false, bodyAbsent: false },
    ]);
    assert.equal(limitations.length, 2);
    assert.match(limitations[0] ?? '', /切り詰め/);
    assert.match(limitations[1] ?? '', /保存されていない/);
    assert.deepEqual(coverageLimitations([{ url: 'http://a.test/3', bodyTruncated: false, bodyAbsent: false }]), []);
  });
});
