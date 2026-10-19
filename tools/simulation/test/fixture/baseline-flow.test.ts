import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DomainError } from '@scopepilot2/contracts';
import {
  FIXTURE_NUCLEI_VERSION,
  FIXTURE_ZAP_VERSION,
  FixtureExplorer,
  runBaselineScenario,
  zapAlertsFixtureHash,
} from '@scopepilot2/simulation';

const EXPECTED_EVENT_SEQUENCE: readonly string[] = [
  'CaseCreated',
  'AuthorizationGranted',
  'PlanValidated',
  'PlanAuthorized',
  'PlanConfirmed',
  'RunStarted',
  'EgressDenied',
  'RunCompleted',
  'CandidatesAdopted',
  'PlanValidated',
  'PlanAuthorized',
  'PlanConfirmed',
  'RunStarted',
  'RunCompleted',
  'FindingsImported',
  'FindingsImported',
  'ReportGenerated',
];

describe('A0 基準シナリオ (探索→能動診断→所見)', () => {
  test('[F21-FT-001] 案件作成→認可→探索→候補採用→能動診断→取込→所見→報告が UI なしで自動完走する', async () => {
    const result = await runBaselineScenario();
    assert.equal(result.caseRecord.revision, 1);
    assert.equal(result.authorization.caseId, result.caseRecord.caseId);
    assert.equal(result.exploration.runRecord.state, 'Completed');
    assert.equal(result.exploration.runRecord.stopReason, 'completed');
    assert.ok(result.exploration.observations.length >= 5, '探索は seed から複数ページを観測する');
    assert.ok(result.adoptedCandidates.length > 0);
    assert.equal(result.activeScan.runRecord.state, 'Completed');
    assert.ok(result.findings.length > 0);
    assert.ok(result.report.content.length > 0);

    assert.deepEqual(
      result.events.map((event) => event.type),
      [...EXPECTED_EVENT_SEQUENCE],
    );
  });

  test('[F21-FT-002] 同じ入力から安定した計画 hash・報告 model hash が得られる', async () => {
    const first = await runBaselineScenario();
    const second = await runBaselineScenario();
    assert.equal(first.explorePlanHash, second.explorePlanHash);
    assert.equal(first.scanPlanHash, second.scanPlanHash);
    assert.equal(first.report.modelHash, second.report.modelHash);
    assert.notEqual(first.explorePlanHash, first.scanPlanHash);
  });

  test('[F21-FT-003] 探索 (Enforced) は scope 外 URL を adapter へ渡さず拒否記録を残す', async () => {
    const result = await runBaselineScenario();
    // 既定 harness の explorer は FixtureExplorer (呼出記録を持つ)。
    const calls = (result.harness.explorer as FixtureExplorer).calls();
    assert.ok(calls.every((url: string) => url.startsWith('http://fixture.target.test/')));
    assert.ok(!calls.includes('http://elsewhere.example/out-of-scope'));
    assert.deepEqual(result.exploration.deniedUrls.map((entry) => entry.url), ['http://elsewhere.example/out-of-scope']);
    assert.ok(result.events.some((event) => event.type === 'EgressDenied'));
  });

  test('[F21-FT-004] engine 警告は重複除外され、実影響未確認として取込まれる (Delegated)', async () => {
    const result = await runBaselineScenario();
    const zapFindings = result.findings.filter((finding) => finding.source.kind === 'zap-alert');
    assert.equal(zapFindings.length, 3);
    const reobserved = zapFindings.find((finding) => finding.enginePluginId === '40012');
    assert.notEqual(reobserved, undefined);
    assert.equal(reobserved?.occurrences, 2);
    for (const finding of result.findings) {
      assert.equal(finding.source.unverified, true);
      assert.equal(finding.status, 'candidate');
      assert.ok(finding.evidenceRefs.length > 0);
    }
    for (const finding of zapFindings) {
      assert.equal(finding.source.engineVersion, FIXTURE_ZAP_VERSION);
    }
    const imported = result.events.filter(
      (event): event is Extract<typeof event, { type: 'FindingsImported' }> => event.type === 'FindingsImported',
    );
    assert.equal(imported.length, 2);
    assert.deepEqual(
      { importedCount: imported[0]?.importedCount, duplicateCount: imported[0]?.duplicateCount },
      { importedCount: 3, duplicateCount: 1 },
    );
    assert.deepEqual(imported[0]?.source, 'zap-alert');
    assert.deepEqual(
      { importedCount: imported[1]?.importedCount, duplicateCount: imported[1]?.duplicateCount },
      { importedCount: 3, duplicateCount: 1 },
    );
    assert.deepEqual(imported[1]?.source, 'nuclei-match');
  });

  test('[F21-FT-005] engine 版・能力表 (fixture) ・overshoot 予約が実行記録へ残る', async () => {
    const result = await runBaselineScenario();
    assert.equal(result.activeScan.engineVersion, FIXTURE_ZAP_VERSION);
    assert.equal(result.scanPlan.steps[0]?.engineVersion, FIXTURE_ZAP_VERSION);

    const zapSnapshot = result.capabilities.find((capability) => capability.engineKind === 'zap');
    assert.notEqual(zapSnapshot, undefined);
    assert.equal(zapSnapshot?.source, 'fixture');
    assert.equal(zapSnapshot?.guaranteeLevels.preSendScopeEnforcement, 'Delegated');
    assert.equal(zapSnapshot?.fixtureHash, zapAlertsFixtureHash());

    const stepLimits = result.scanPlan.steps[0]?.limits;
    assert.notEqual(stepLimits, undefined);
    assert.ok(result.activeScan.overshootReservation > 0);
    assert.equal(
      result.activeScan.scanRequest.leasedLimits.maxRequests,
      (stepLimits?.maxRequests ?? 0) - result.activeScan.overshootReservation,
    );
  });

  test('[F21-FT-006] 報告は委譲範囲・限界・未確認表示を省略しない', async () => {
    const result = await runBaselineScenario();
    const content = result.report.content;
    assert.match(content, /送信前に拒否できない/);
    assert.match(content, /未確認/);
    assert.match(content, /Delegated/);
    assert.match(content, new RegExp(FIXTURE_ZAP_VERSION));
    assert.match(content, /fixture に基づく workflow 検証/);
  });

  test('[F21-FT-007] context に存在しない URL は URL Does not Exist として失敗し、完了扱いにしない', async () => {
    await assert.rejects(
      runBaselineScenario({ injectUnknownScanTarget: true }),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'EngineFailure');
        assert.match(error.message, /URL Does not Exist/);
        return true;
      },
    );
  });
});
