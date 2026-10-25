import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Finding } from '@scopepilot2/contracts';
import { CaseRepository, FindingRepository, migrate, openDatabase, SqliteEvidenceStore } from '../../src/index.ts';

test('evidence bodies and complete findings survive a workspace reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scopepilot2-evidence-'));
  const dbPath = join(dir, 'scopepilot.db');
  try {
    const db = openDatabase(dbPath);
    migrate(db);
    new CaseRepository(db).save({
      caseId: 'case-1', name: 'durable', revision: 1,
      scope: { allowedOrigins: ['http://a.test'], deniedOrigins: [], limits: { maxRequests: 10, maxPages: 10, maxDurationMinutes: 10 } },
      createdAt: '2026-10-20T00:00:00.000Z',
    });
    const evidence = await new SqliteEvidenceStore(db, join(dir, 'evidence', 'blobs')).saveText('raw-zap', '{"alerts":[]}');
    const blob = evidence.metadata?.['blob'];
    assert.equal(typeof blob, 'string');
    const blobPath = join(dir, ...(blob ?? '').split('/'));
    assert.equal(existsSync(blobPath), true);
    assert.equal(readFileSync(blobPath, 'utf8'), '{"alerts":[]}');

    const finding: Finding = {
      findingId: 'finding-1', title: 'durable finding', source: { kind: 'zap-alert', engineVersion: 'zap 2.17.0', unverified: true },
      url: 'http://a.test/?q=1', method: 'GET', param: 'q', severity: 'medium', status: 'candidate',
      evidenceRefs: [evidence.evidenceId], firstSeenAt: '2026-10-20T00:00:00.000Z', lastSeenAt: '2026-10-20T00:00:00.000Z',
      occurrences: 3, enginePluginId: '40012',
    };
    new FindingRepository(db).save('case-1', '40012|http://a.test/?q=1|q', finding);
    db.close();

    const reopened = openDatabase(dbPath);
    migrate(reopened);
    assert.deepEqual(new FindingRepository(reopened).list('case-1'), [finding]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
