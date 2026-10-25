import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FindingImporter, type NucleiMatch } from '@scopepilot2/core';
import type { EngineAlert } from '@scopepilot2/contracts';

const CONTEXT = {
  now: '2026-10-18T09:00:00.000Z',
  engineVersion: '3.4.0-fixture',
  makeFindingId: (() => {
    let sequence = 0;
    return () => `finding-${String((sequence += 1)).padStart(4, '0')}`;
  })(),
  evidenceRef: 'evidence-0001',
};

const CRITICAL_MATCH: NucleiMatch = {
  templateId: 'fixture-sqli-error-based.yaml',
  matchedAt: 'http://fixture.target.test/vulnerabilities/sql_injection/?id=1',
  severity: 'critical',
  name: 'Fixture: SQL injection error marker',
};

describe('nuclei result importer (F18)', () => {
  test('[F18-UT-005] nuclei match は critical を high へ正規化し原値を併記、再取込は再観測のみ', () => {
    const importer = new FindingImporter();
    const first = importer.importNucleiMatches([CRITICAL_MATCH], CONTEXT);
    assert.equal(first.created.length, 1);
    const finding = first.created[0];
    assert.notEqual(finding, undefined);
    assert.equal(finding?.severity, 'high');
    assert.equal(finding?.sourceSeverity, 'critical');
    assert.equal(finding?.source.kind, 'nuclei-match');
    assert.equal(finding?.source.unverified, true);
    assert.equal(finding?.enginePluginId, 'fixture-sqli-error-based.yaml');
    assert.equal(finding?.occurrences, 1);

    const second = importer.importNucleiMatches([CRITICAL_MATCH], CONTEXT);
    assert.equal(second.created.length, 0);
    assert.equal(second.duplicateCount, 1);
    assert.equal(second.reobserved[0]?.occurrences, 2);
    assert.equal(second.reobserved[0]?.sourceSeverity, 'critical', '再観測でも原値を保つ');
  });

  test('[F18-UT-005] severity 原値が正規化後と同一の match は sourceSeverity を冗長に持たない', () => {
    const importer = new FindingImporter();
    const created = importer.importNucleiMatches(
      [{ templateId: 'fixture-missing-header.yaml', matchedAt: 'http://fixture.target.test/', severity: 'info', name: 'x' }],
      CONTEXT,
    );
    assert.equal(created.created[0]?.severity, 'info');
    assert.equal(created.created[0]?.sourceSeverity, undefined);
  });

  test('[F18-UT-005] nuclei と ZAP alert の dedupe key 空間は分離する', () => {
    const importer = new FindingImporter();
    const nuclei = importer.importNucleiMatches(
      [{ templateId: '40012', matchedAt: 'http://fixture.target.test/login.php', severity: 'info', name: 'nuclei side' }],
      CONTEXT,
    );
    const zapAlert: EngineAlert = {
      engineAlertId: 'zap-alert-0001',
      pluginId: '40012',
      name: 'zap side',
      risk: 'Low',
      url: 'http://fixture.target.test/login.php',
      method: 'GET',
      evidenceSummary: 'fixture',
    };
    const zap = importer.importAlerts([zapAlert], CONTEXT);
    assert.equal(nuclei.created.length, 1);
    assert.equal(zap.created.length, 1, '同一 pluginId 文字列・URL でも source が違えば別所見');
    assert.equal(importer.list().length, 2);
  });
});
