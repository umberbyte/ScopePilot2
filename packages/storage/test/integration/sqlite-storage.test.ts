import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { Finding, RunRecord } from '@scopepilot2/contracts';
import { AiInvocationRepository, AuthorizationRepository, CaseRepository, FindingRepository, migrate, openDatabase, RunRepository, SqliteEvidenceStore } from '../../src/index.ts';

// IT: 局所的な SQLite I/O は許可する (docs/detailed-design/03-unit-test-strategy.md §2)。
describe('SQLite storage', () => {
  test('migration は冪等で、version 記録が重複しない', () => {
    const db = openDatabase(':memory:');
    const first = migrate(db);
    const second = migrate(db);
    assert.deepEqual(first.appliedVersions, [1, 2, 3]);
    assert.deepEqual(second.appliedVersions, [1, 2, 3]);
    const rows = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number };
    assert.equal(rows.c, 3);
    db.close();
  });

  test('証拠保存は hash と metadata を保持し、同一内容でも原本として別 ID を振る', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const store = new SqliteEvidenceStore(db);
    const first = await store.saveText('label-a', 'content-x', { contractName: '契約-1' });
    const second = await store.saveText('label-a', 'content-x');
    assert.notEqual(first.evidenceId, second.evidenceId);
    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(first.metadata, { contractName: '契約-1' });
    assert.equal(store.list().length, 2);
    db.close();
  });

  test('run 保存と crash 検出: Running/Stopping は Interrupted になり、terminal は変わらない', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const cases = new CaseRepository(db);
    cases.save({ caseId: 'case-0001', name: 'it', revision: 1, scope: { allowedOrigins: ['http://a.test'], deniedOrigins: [], limits: { maxRequests: 1, maxPages: 1, maxDurationMinutes: 1 } }, createdAt: '2026-10-18T09:00:00.000Z' });
    const runs = new RunRepository(db);
    const running: RunRecord = { runId: 'run-0001', planId: 'plan-1', caseId: 'case-0001', state: 'Running', attempt: 1 };
    const stopping: RunRecord = { runId: 'run-0002', planId: 'plan-1', caseId: 'case-0001', state: 'Stopping', attempt: 1 };
    const completed: RunRecord = { runId: 'run-0003', planId: 'plan-1', caseId: 'case-0001', state: 'Completed', attempt: 1, stopReason: 'completed' };
    runs.save(running);
    runs.save(stopping);
    runs.save(completed);

    const interrupted = runs.markInterrupted();
    assert.deepEqual(interrupted.map((run) => run.runId).sort(), ['run-0001', 'run-0002']);
    assert.ok(interrupted.every((run) => run.state === 'Interrupted' && run.stopReason === 'interrupted'));
    assert.equal(runs.get('run-0003')?.state, 'Completed');
    // 自動再開はしない: 再実行しても対象が残らない。
    assert.deepEqual(runs.markInterrupted(), []);
    assert.deepEqual(runs.listInterruptedCandidates(), []);
    db.close();
  });

  test('finding upsert は dedupe key で重複を観測回数へ畳む', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const cases = new CaseRepository(db);
    cases.save({ caseId: 'case-0001', name: 'it', revision: 1, scope: { allowedOrigins: ['http://a.test'], deniedOrigins: [], limits: { maxRequests: 1, maxPages: 1, maxDurationMinutes: 1 } }, createdAt: '2026-10-18T09:00:00.000Z' });
    const findings = new FindingRepository(db);
    const base: Finding = {
      findingId: 'finding-0001',
      title: 'XSS (fixture)',
      source: { kind: 'zap-alert', engineVersion: '2.17.0-fixture', unverified: true },
      url: 'http://a.test/?x=1',
      method: 'GET',
      param: 'x',
      severity: 'medium',
      status: 'candidate',
      evidenceRefs: ['evidence-0001'],
      firstSeenAt: '2026-10-18T09:00:00.000Z',
      lastSeenAt: '2026-10-18T09:00:00.000Z',
      occurrences: 1,
      enginePluginId: '40012',
    };
    const first = findings.upsert('case-0001', '40012|http://a.test/?x=1|x', base);
    const second = findings.upsert('case-0001', '40012|http://a.test/?x=1|x', { ...base, lastSeenAt: '2026-10-18T09:05:00.000Z' });
    const other = findings.upsert('case-0001', '40018|http://a.test/?i=1|i', { ...base, findingId: 'finding-0002', enginePluginId: '40018' });
    assert.deepEqual(first, { inserted: true, occurrences: 1 });
    assert.deepEqual(second, { inserted: false, occurrences: 2 });
    assert.deepEqual(other, { inserted: true, occurrences: 1 });
    const all = findings.list('case-0001');
    assert.equal(all.length, 2);
    assert.equal(all.find((finding) => finding.findingId === 'finding-0001')?.occurrences, 2);
    db.close();
  });

  test('案件の最新認可を対象role・証拠参照付きで再オープンできる', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    new CaseRepository(db).save({ caseId: 'case-auth', name: 'auth', revision: 1, scope: { allowedOrigins: ['https://a.test'], deniedOrigins: [], limits: { maxRequests: 10, maxPages: 10, maxDurationMinutes: 10 } }, createdAt: '2026-10-20T00:00:00.000Z' });
    const repository = new AuthorizationRepository(db);
    repository.save({
      authorizationId: 'authz-1',
      caseId: 'case-auth',
      allowedOperationClasses: ['Browse', 'ActiveScan'],
      targetRoles: ['member'],
      validFrom: '2026-10-20T00:00:00.000Z',
      validUntil: '2026-11-20T00:00:00.000Z',
      evidenceRef: { evidenceId: 'evidence-1', sha256: 'a'.repeat(64), label: '診断依頼書' },
    });
    assert.deepEqual(repository.latest('case-auth'), {
      authorizationId: 'authz-1',
      caseId: 'case-auth',
      allowedOperationClasses: ['Browse', 'ActiveScan'],
      targetRoles: ['member'],
      validFrom: '2026-10-20T00:00:00.000Z',
      validUntil: '2026-11-20T00:00:00.000Z',
      evidenceRef: { evidenceId: 'evidence-1', sha256: 'a'.repeat(64), label: '診断依頼書' },
    });
    db.close();
  });

  test('AI支援はprovider/model/hashと検証済み提案を監査記録へ保存する', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const repository = new AiInvocationRepository(db);
    repository.save({
      invocationId: 'ai-1', taskKind: 'DocumentExtract', provider: 'codex', model: 'configured-default',
      inputHash: 'a'.repeat(64), outputHash: 'b'.repeat(64), status: 'succeeded',
      proposal: { documents: [] }, startedAt: '2026-10-20T00:00:00.000Z', completedAt: '2026-10-20T00:00:01.000Z',
    });
    assert.deepEqual(repository.list(), [{
      invocationId: 'ai-1', taskKind: 'DocumentExtract', provider: 'codex', model: 'configured-default',
      inputHash: 'a'.repeat(64), outputHash: 'b'.repeat(64), status: 'succeeded',
      proposal: { documents: [] }, startedAt: '2026-10-20T00:00:00.000Z', completedAt: '2026-10-20T00:00:01.000Z',
    }]);
    db.close();
  });

  test('ファイル DB は再オープン後も状態を保持する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scopepilot2-storage-'));
    try {
      const path = join(dir, 'scopepilot.db');
      const first = openDatabase(path);
      migrate(first);
      new CaseRepository(first).save({ caseId: 'case-0001', name: 'persist', revision: 1, scope: { allowedOrigins: ['http://a.test'], deniedOrigins: [], limits: { maxRequests: 1, maxPages: 1, maxDurationMinutes: 1 } }, createdAt: '2026-10-18T09:00:00.000Z' });
      first.close();

      const second = openDatabase(path);
      const result = migrate(second);
      assert.deepEqual(result.appliedVersions, [1, 2, 3]);
      assert.equal(new CaseRepository(second).get('case-0001')?.name, 'persist');
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

after(() => {
  // tmpdir の掃除は各 test 内の finally で行う。
});
