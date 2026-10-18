/**
 * F18 (既知脆弱性・Nuclei) 結果取込の fixture test。
 * 固定 JSONL fixture の境界ケース (重複・破損行・scope 外・critical) が
 * 取込経路で設計どおり扱われることを検証する (`docs/detailed-design/f18-known-vulnerabilities-nuclei.md` §4〜§6)。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DomainError } from '@scopepilot2/contracts';
import {
  createHarness,
  FIXTURE_NUCLEI_JSONL,
  FIXTURE_NUCLEI_VERSION,
  FIXTURE_OPERATOR,
  SITE_ORIGIN,
} from '@scopepilot2/simulation';

function harnessWithCase() {
  const harness = createHarness();
  harness.service.createCase(FIXTURE_OPERATOR, {
    name: 'Nuclei 取込検証',
    allowedOrigins: [SITE_ORIGIN],
    deniedOrigins: [],
    limits: { maxRequests: 100, maxPages: 100, maxDurationMinutes: 30 },
  });
  return harness;
}

describe('Nuclei 結果取込 (F18)', () => {
  test('[F18-FT-001] 壊れた行は quarantine し、scope 外・重複・critical を設計どおり扱う', async () => {
    const harness = harnessWithCase();
    const result = await harness.service.importNucleiResults(FIXTURE_OPERATOR, {
      lines: FIXTURE_NUCLEI_JSONL,
      engineVersion: FIXTURE_NUCLEI_VERSION,
    });

    assert.equal(result.quarantinedCount, 2, '不正 JSON 行と template-id 欠落行');
    assert.equal(result.excludedOutOfScope, 1, 'scope 外 matched-at は案件の所見にしない');
    assert.equal(result.importedCount, 3);
    assert.equal(result.duplicateCount, 1, '同一 template/matched-at の重複行');
    assert.ok(result.evidenceRef.length > 0, 'JSONL 原本の証拠参照');

    const nucleiFindings = result.findings.filter((finding) => finding.source.kind === 'nuclei-match');
    assert.equal(nucleiFindings.length, 3);
    assert.ok(nucleiFindings.every((finding) => finding.url.startsWith(SITE_ORIGIN)), 'scope 外 URL の所見は作らない');

    const critical = nucleiFindings.find((finding) => finding.enginePluginId === 'fixture-sqli-error-based.yaml');
    assert.notEqual(critical, undefined);
    assert.equal(critical?.severity, 'high', 'critical は本製品の severity 集合へ正規化');
    assert.equal(critical?.sourceSeverity, 'critical', '原値を併記する');
    assert.equal(critical?.source.engineVersion, FIXTURE_NUCLEI_VERSION);
    assert.equal(critical?.source.unverified, true, 'engine 由来は実影響未確認');
    assert.equal(critical?.status, 'candidate');

    const events = harness.service.events().filter((event) => event.type === 'FindingsImported');
    assert.equal(events.length, 1);
    const importedEvent = events[0];
    assert.ok(importedEvent !== undefined && importedEvent.type === 'FindingsImported');
    assert.equal(importedEvent.source, 'nuclei-match');
    assert.equal(importedEvent.engineVersion, FIXTURE_NUCLEI_VERSION);
    assert.equal(importedEvent.importedCount, 3);
    assert.equal(importedEvent.duplicateCount, 1);
  });

  test('[F18-FT-002] 同一 JSONL の再取込は新規所見を作らず再観測だけを増やす', async () => {
    const harness = harnessWithCase();
    const input = { lines: FIXTURE_NUCLEI_JSONL, engineVersion: FIXTURE_NUCLEI_VERSION };
    const first = await harness.service.importNucleiResults(FIXTURE_OPERATOR, input);
    const second = await harness.service.importNucleiResults(FIXTURE_OPERATOR, input);

    assert.equal(second.importedCount, 0);
    assert.equal(second.duplicateCount, 4, '同一 JSONL 内の重複 1 + 既取込 3 件の再観測');
    assert.equal(second.findings.length, first.findings.length);

    const header = second.findings.find((finding) => finding.enginePluginId === 'fixture-missing-header.yaml');
    assert.notEqual(header, undefined);
    assert.equal(header?.occurrences, 2, '重複行と再取込で観測 2 回');

    const events = harness.service.events().filter((event) => event.type === 'FindingsImported');
    assert.equal(events.length, 2, '取込のたびに監査 event を残す');
  });

  test('[F18-FT-003] 権限のない operator の取込は拒否し、監査 event を変化させない', async () => {
    const harness = harnessWithCase();
    const eventsBefore = harness.service.events().length;
    const unauthorized = { operatorId: 'operator-no-permission', displayName: 'No Permission', permissions: [] };
    await assert.rejects(
      harness.service.importNucleiResults(unauthorized, { lines: FIXTURE_NUCLEI_JSONL, engineVersion: FIXTURE_NUCLEI_VERSION }),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'PermissionDenied');
        return true;
      },
    );
    assert.equal(harness.service.events().length, eventsBefore);
    assert.equal(harness.service.events().some((event) => event.type === 'FindingsImported'), false);
  });
});
