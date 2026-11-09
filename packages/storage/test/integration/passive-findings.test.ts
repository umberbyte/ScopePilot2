import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FindingImporter } from '@scopepilot2/core';
import { CaseRepository, FindingRepository, migrate, openDatabase } from '../../src/index.ts';

test('shared Findings persistence retains passive provenance and evidence on restore', () => {
  const db = openDatabase(':memory:');
  try {
    migrate(db);
    new CaseRepository(db).save({ caseId: 'case-passive', name: 'passive fixture', revision: 1,
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [], limits: { maxRequests: 1, maxPages: 1, maxDurationMinutes: 1 } }, createdAt: '2026-11-10T00:00:00.000Z' });
    const importer = new FindingImporter();
    const { created } = importer.importObservationCandidates([{ key: 'passive-password-http', title: 'Password over HTTP', url: 'http://fixture.target.test/', severity: 'medium',
      passive: { ruleId: 'passive-password-http', ruleVersion: '1', detail: 'Observed HTTP password form', observationUrl: 'http://fixture.target.test/' } }],
      { now: '2026-11-10T00:00:00.000Z', engineVersion: 'scopepilot-passive-1', makeFindingId: () => 'finding-passive', evidenceRef: 'evidence-passive' });
    const repository = new FindingRepository(db);
    repository.save('case-passive', 'passive-password-http|http://fixture.target.test/|', created[0]!);
    const restored = new FindingImporter(repository.list('case-passive')).list();
    assert.deepEqual(restored, created);
    assert.equal(restored[0]!.passive!.ruleId, 'passive-password-http');
  } finally { db.close(); }
});
