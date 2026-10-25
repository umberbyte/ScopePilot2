/**
 * A0 基準シナリオ「案件作成→認可→探索→候補採用→能動診断→取込→所見→報告」。
 * `docs/design/19-cli-automation.md` 5章。UI なしで自動完走することと、
 * 同じ入力から安定した計画 hash を作ることが回帰テストの基準になる。
 */
import type {
  AuthorizationRecord,
  BaselineFlowEvent,
  CaseRecord,
  EngineCapabilitySnapshot,
  ExecutionPlan,
  Finding,
  PlanConfirmation,
  ReportArtifact,
  ScanCandidate,
} from '@scopepilot2/contracts';
import type { ActiveScanRunResult, ExploreRunResult, ImportNucleiResultsResult } from '@scopepilot2/core';
import { createHarness, FIXTURE_AUTHORIZATION_PERIOD, FIXTURE_OPERATOR, type SimulationHarness } from '../harness.ts';
import { SITE_ORIGIN } from '../fixtures/target-site.ts';
import { FIXTURE_NUCLEI_JSONL, FIXTURE_NUCLEI_VERSION } from '../fixtures/nuclei-jsonl.ts';

export interface BaselineScenarioResult {
  readonly harness: SimulationHarness;
  readonly caseRecord: CaseRecord;
  readonly authorization: AuthorizationRecord;
  readonly explorePlan: ExecutionPlan;
  readonly explorePlanHash: string;
  readonly exploreConfirmation: PlanConfirmation;
  readonly exploration: ExploreRunResult;
  readonly adoptedCandidates: readonly ScanCandidate[];
  readonly scanPlan: ExecutionPlan;
  readonly scanPlanHash: string;
  readonly scanConfirmation: PlanConfirmation;
  readonly activeScan: ActiveScanRunResult;
  readonly nucleiImport: ImportNucleiResultsResult;
  /** 報告時点の全所見 (ZAP・Nuclei 両方)。 */
  readonly findings: readonly Finding[];
  readonly report: ReportArtifact;
  readonly events: readonly BaselineFlowEvent[];
  readonly capabilities: readonly EngineCapabilitySnapshot[];
}

export interface BaselineScenarioOptions {
  /**
   * 探索で観測していない (context に存在しない) URL を診断対象へ混ぜ、
   * 旧版で既知だった ZAP `URL Does not Exist` 失敗を再現する。
   */
  readonly injectUnknownScanTarget?: boolean;
}

export async function runBaselineScenario(options: BaselineScenarioOptions = {}): Promise<BaselineScenarioResult> {
  const harness = createHarness();
  const { service } = harness;
  const operator = FIXTURE_OPERATOR;

  // 1. 案件作成
  const caseRecord = service.createCase(operator, {
    name: 'Fixture 基準シナリオ案件',
    allowedOrigins: [SITE_ORIGIN],
    deniedOrigins: [],
    limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
  });

  // 2. 認可
  const authorization = await service.grantAuthorization(operator, {
    allowedOperationClasses: ['Browse', 'ActiveScan'],
    targetRoles: ['unauthenticated'],
    ...FIXTURE_AUTHORIZATION_PERIOD,
    evidence: { label: '認可証跡(fixture)', content: 'fixture authorization evidence; no secrets' },
  });

  // 3. 探索計画 → 検証・認可結び付け → 確認 → 実行
  const { plan: explorePlan, planHash: explorePlanHash } = service.buildExplorationPlan(operator, [`${SITE_ORIGIN}/`]);
  service.authorizePlan(explorePlan);
  const exploreConfirmation = service.confirmPlan(explorePlan, operator);
  const exploration = await service.runExploration(operator, explorePlan, exploreConfirmation, { maxDepth: 2 });

  // 4. 候補の採用 (基準シナリオでは全採用)
  const adoptedCandidates = service.adoptCandidates(operator, exploration.candidates);

  // 5. 能動診断計画 → 検証・認可結び付け → 確認 → 実行 → 取込
  const scanTargets = adoptedCandidates.map((candidate) => candidate.url);
  if (options.injectUnknownScanTarget === true) {
    scanTargets.push(`${SITE_ORIGIN}/not-in-context.php`);
  }
  const { plan: scanPlan, planHash: scanPlanHash } = service.buildActiveScanPlan(operator, scanTargets);
  service.authorizePlan(scanPlan);
  const scanConfirmation = service.confirmPlan(scanPlan, operator);
  const activeScan = await service.runActiveScan(operator, scanPlan, scanConfirmation, adoptedCandidates);

  // 6. Nuclei 結果 (供給済み JSONL) の取込。engine 実行は能力表が実測を満たすまで
  //    公開しないため、観測出力の取込経路のみを基準シナリオへ含める (f18)。
  const nucleiImport = await service.importNucleiResults(operator, {
    lines: FIXTURE_NUCLEI_JSONL,
    engineVersion: FIXTURE_NUCLEI_VERSION,
  });

  // 7. 報告
  const report = service.generateReport(operator, { guidelines: ['fixture-guideline'] });

  return {
    harness,
    caseRecord,
    authorization,
    explorePlan,
    explorePlanHash,
    exploreConfirmation,
    exploration,
    adoptedCandidates,
    scanPlan,
    scanPlanHash,
    scanConfirmation,
    activeScan,
    nucleiImport,
    findings: nucleiImport.findings,
    report,
    events: service.events(),
    capabilities: harness.capabilities,
  };
}
