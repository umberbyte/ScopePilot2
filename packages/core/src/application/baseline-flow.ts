/**
 * 基準シナリオ「案件作成→認可→探索→候補採用→能動診断→取込→所見→報告」の
 * application service seed。`docs/design/19-cli-automation.md` 5章、`docs/design/22-execution-control.md`。
 *
 * 本体実装より先に simulation fixture で自動完走させる回帰基準となる層で、
 * command pipeline の順序 (権限判定 → 認可 → 確認 → domain 処理 → 証跡 → event) を
 * 最初から踏襲する (SYS-UT-001/005 の土台)。
 */
import {
  canonicalJson,
  DomainError,
  domainError,
  hashStable,
  type AuthorizationRecord,
  type BaselineFlowEvent,
  type CaseRecord,
  type CaseScope,
  type EngineCapabilitySnapshot,
  type ExecutionPlan,
  type Finding,
  type OperatorProfile,
  type OperatorPermission,
  type PageObservation,
  type PlanConfirmation,
  type PlanLimits,
  type ReportArtifact,
  type RunRecord,
  type RunState,
  type ScanCandidate,
  type ScopeLimits,
  type StopReason,
  type ActiveScanRequest,
} from '@scopepilot2/contracts';
import { ScopePolicy } from '../domain/scope-policy.ts';
import { CaseAggregate } from '../domain/case-aggregate.ts';
import { RunStateMachine } from '../domain/run-state-machine.ts';
import { ScanMonitor } from '../domain/scan-monitor.ts';
import { filterAuthorizationEvidenceMetadata } from '../domain/authorization-evidence.ts';
import {
  buildPlan,
  confirmationMatches,
  DEFAULT_ACTIVE_SCAN_LIMITS,
  DEFAULT_EXPLORE_LIMITS,
  firstPlanIssueAsError,
  planHashOf,
  validatePlan,
} from '../domain/plan-service.ts';
import { FindingImporter } from '../domain/finding-importer.ts';
import { importMatches, parseNucleiJsonl } from '../domain/known-vulnerabilities.ts';
import { buildReportModel, renderMarkdown } from '../domain/report-builder.ts';
import type { Clock, EvidenceStorePort, IdGenerator } from '../ports/infra.ts';
import type { ActiveScanEnginePort, ExplorationPort } from '../ports/engines.ts';

export interface BaselineFlowDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly evidence: EvidenceStorePort;
  readonly explorer: ExplorationPort;
  readonly scanEngine: ActiveScanEnginePort;
  readonly capabilities: readonly EngineCapabilitySnapshot[];
  readonly runtimeBundleHash: string;
}

export interface CreateCaseInput {
  readonly name: string;
  readonly allowedOrigins: readonly string[];
  readonly deniedOrigins: readonly string[];
  readonly limits: ScopeLimits;
}

export interface GrantAuthorizationInput {
  readonly allowedOperationClasses: AuthorizationRecord['allowedOperationClasses'];
  readonly targetRoles: readonly string[];
  readonly validFrom: string;
  readonly validUntil: string;
  readonly evidence: { readonly label: string; readonly content: string; readonly metadata?: Readonly<Record<string, string>> };
}

export interface ExploreRunInput {
  readonly maxDepth: number;
}

export interface ExploreRunResult {
  readonly runRecord: RunRecord;
  readonly planHash: string;
  readonly observations: readonly PageObservation[];
  readonly deniedUrls: readonly { readonly url: string; readonly reason: string }[];
  readonly candidates: readonly ScanCandidate[];
  readonly engineVersion: string;
}

export interface ActiveScanRunResult {
  readonly runRecord: RunRecord;
  readonly planHash: string;
  readonly scanRequest: ActiveScanRequest;
  readonly findings: readonly Finding[];
  readonly overshootReservation: number;
  readonly engineVersion: string;
}

export interface ImportNucleiResultsInput {
  /** 観測された Nuclei JSONL 出力 (原本)。engine 実行はこの経路では行わない。 */
  readonly lines: readonly string[];
  readonly engineVersion: string;
}

export interface ImportNucleiResultsResult {
  /** 取込後の全所見 (ZAP 由来を含む)。 */
  readonly findings: readonly Finding[];
  readonly importedCount: number;
  readonly duplicateCount: number;
  /** malformed 行数。quarantine しても処理は継続する (f18 §6)。 */
  readonly quarantinedCount: number;
  /** 案件 scope 外の matched-at は案件の所見に含めない。 */
  readonly excludedOutOfScope: number;
  readonly evidenceRef: string;
}

const MAX_POLL_ITERATIONS = 1000;

export class BaselineFlowService {
  private aggregate: CaseAggregate | null = null;
  private authorization: AuthorizationRecord | null = null;
  private readonly eventsLog: BaselineFlowEvent[] = [];
  private readonly importer = new FindingImporter();
  private exploredUrlCount = 0;
  private scannedUrlCount = 0;
  private delegatedSteps: {
    readonly stepId: string;
    readonly engineKind: 'zap';
    readonly engineVersion: string;
  }[] = [];

  private readonly deps: BaselineFlowDeps;

  constructor(deps: BaselineFlowDeps) {
    this.deps = deps;
  }

  events(): readonly BaselineFlowEvent[] {
    return [...this.eventsLog];
  }

  /** 能力表 (fixture または実測)。API 経由で UI/CLI が版と fixture hash を確認するのに使う。 */
  capabilities(): readonly EngineCapabilitySnapshot[] {
    return [...this.deps.capabilities];
  }

  currentCase(): CaseRecord {
    if (this.aggregate === null) {
      throw domainError('ValidationFailed', 'case has not been created yet');
    }
    return this.aggregate.record;
  }

  currentAuthorization(): AuthorizationRecord {
    if (this.authorization === null) {
      throw domainError('ValidationFailed', 'authorization has not been granted yet');
    }
    return this.authorization;
  }

  /** 案件作成。origin は canonicalize 後に保存し、正規化できない URL は拒否する。 */
  createCase(operator: OperatorProfile, input: CreateCaseInput): CaseRecord {
    this.requirePermission(operator, 'case.manage');
    if (input.name.trim() === '') {
      throw domainError('ValidationFailed', 'case name must not be empty');
    }
    this.requirePositiveLimits(input.limits, 'case');
    const allowed = input.allowedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
    const denied = input.deniedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
    if (allowed.length === 0) {
      throw domainError('ValidationFailed', 'case must have at least one allowed origin');
    }
    this.aggregate = CaseAggregate.open({
      caseId: this.deps.ids.next('case'),
      name: input.name,
      revision: 1,
      scope: { allowedOrigins: [...new Set(allowed)], deniedOrigins: [...new Set(denied)], limits: input.limits },
      createdAt: this.deps.clock.now().toISOString(),
    });
    this.record({ type: 'CaseCreated', at: this.deps.clock.now().toISOString(), caseId: this.aggregate.record.caseId, revision: 1 });
    return this.aggregate.record;
  }

  /**
   * scope 更新。expectedRevision 必須 (f01 §4)。狭くなる更新は既存 confirmation を無効化し、
   * 無効化 event を監査記録へ残す。進行中 job への停止要求は run 管理の実装時に接続する。
   */
  updateCaseScope(
    operator: OperatorProfile,
    input: {
      expectedRevision: number;
      allowedOrigins: readonly string[];
      deniedOrigins: readonly string[];
      limits: ScopeLimits;
    },
  ): { revision: number; narrowed: boolean; invalidatedConfirmationIds: readonly string[] } {
    this.requirePermission(operator, 'case.manage');
    const aggregate = this.aggregate;
    if (aggregate === null) {
      throw domainError('ValidationFailed', 'case has not been created yet');
    }
    const allowed = input.allowedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
    const denied = input.deniedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
    if (allowed.length === 0) {
      throw domainError('ValidationFailed', 'case must have at least one allowed origin');
    }
    this.requirePositiveLimits(input.limits, 'case');
    const outcome = aggregate.updateScope({
      expectedRevision: input.expectedRevision,
      scope: { allowedOrigins: [...new Set(allowed)], deniedOrigins: [...new Set(denied)], limits: input.limits },
    });
    const at = this.deps.clock.now().toISOString();
    this.record({ type: 'CaseScopeUpdated', at, caseId: outcome.record.caseId, revision: outcome.revision, narrowed: outcome.narrowed });
    if (outcome.invalidatedConfirmationIds.length > 0) {
      this.record({
        type: 'ConfirmationsInvalidated',
        at,
        caseId: outcome.record.caseId,
        confirmationIds: [...outcome.invalidatedConfirmationIds],
        reason: 'case scope narrowed',
      });
    }
    return outcome;
  }

  /** 認可の付与。証跡原本は hash 参照のみ持ち、秘密値は保持しない。 */
  async grantAuthorization(operator: OperatorProfile, input: GrantAuthorizationInput): Promise<AuthorizationRecord> {
    this.requirePermission(operator, 'case.manage');
    const caseRecord = this.currentCase();
    if (input.validFrom >= input.validUntil) {
      throw domainError('ValidationFailed', 'authorization validFrom must be before validUntil');
    }
    if (input.allowedOperationClasses.length === 0) {
      throw domainError('ValidationFailed', 'authorization must allow at least one operation class');
    }
    const stored = await this.deps.evidence.saveText(
      input.evidence.label,
      input.evidence.content,
      // 許可欄以外の metadata は保存しない (F01-UT-008)。
      filterAuthorizationEvidenceMetadata(input.evidence.metadata ?? {}),
    );
    this.authorization = {
      authorizationId: this.deps.ids.next('authz'),
      caseId: caseRecord.caseId,
      allowedOperationClasses: input.allowedOperationClasses,
      targetRoles: input.targetRoles,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      evidenceRef: { evidenceId: stored.evidenceId, sha256: stored.sha256, label: stored.label },
    };
    this.record({
      type: 'AuthorizationGranted',
      at: this.deps.clock.now().toISOString(),
      authorizationId: this.authorization.authorizationId,
      caseId: caseRecord.caseId,
    });
    return this.authorization;
  }

  /** 探索計画。既定上限と案件上限の狭い方を使う。 */
  buildExplorationPlan(operator: OperatorProfile, seeds: readonly string[]): { plan: ExecutionPlan; planHash: string } {
    this.requirePermission(operator, 'run.manage');
    const caseRecord = this.currentCase();
    const authorization = this.currentAuthorization();
    if (seeds.length === 0) {
      throw domainError('ValidationFailed', 'exploration needs at least one seed URL');
    }
    const limits = this.planLimits(DEFAULT_EXPLORE_LIMITS, caseRecord.scope.limits);
    const inputEvidenceHash = hashStable('scopepilot2.plan.input', seeds.map((url) => ScopePolicy.canonicalUrl(url)).sort());
    const plan = buildPlan({
      planId: this.deps.ids.next('plan'),
      caseId: caseRecord.caseId,
      authorizationId: authorization.authorizationId,
      operatorId: operator.operatorId,
      targetRole: authorization.targetRoles[0] ?? 'unauthenticated',
      steps: [
        {
          kind: 'explore',
          operationClass: 'Browse',
          targets: seeds,
          engineKind: 'playwright',
          guarantee: 'Enforced',
          limits,
        },
      ],
      limits,
      runtimeBundleHash: this.deps.runtimeBundleHash,
      inputEvidenceHash,
      createdAt: this.deps.clock.now().toISOString(),
    });
    return { plan, planHash: planHashOf(plan) };
  }

  /** 能動診断計画。対象は採用済み候補の canonical URL の固定 snapshot。 */
  buildActiveScanPlan(operator: OperatorProfile, targets: readonly string[]): { plan: ExecutionPlan; planHash: string } {
    this.requirePermission(operator, 'run.manage');
    const caseRecord = this.currentCase();
    const authorization = this.currentAuthorization();
    if (targets.length === 0) {
      throw domainError('ValidationFailed', 'active scan needs at least one adopted target');
    }
    const limits = this.planLimits(DEFAULT_ACTIVE_SCAN_LIMITS, caseRecord.scope.limits);
    const inputEvidenceHash = hashStable('scopepilot2.plan.input', targets.map((url) => ScopePolicy.canonicalUrl(url)).sort());
    const plan = buildPlan({
      planId: this.deps.ids.next('plan'),
      caseId: caseRecord.caseId,
      authorizationId: authorization.authorizationId,
      operatorId: operator.operatorId,
      targetRole: authorization.targetRoles[0] ?? 'unauthenticated',
      steps: [
        {
          kind: 'active-scan',
          operationClass: 'ActiveScan',
          targets,
          engineKind: 'zap',
          guarantee: 'Delegated',
          engineVersion: this.deps.scanEngine.engineVersion,
          limits,
        },
      ],
      limits,
      runtimeBundleHash: this.deps.runtimeBundleHash,
      inputEvidenceHash,
      createdAt: this.deps.clock.now().toISOString(),
    });
    return { plan, planHash: planHashOf(plan) };
  }

  /** 計画の検証と認可結び付け。問題があれば最初の問題を domain error へ変換する。 */
  authorizePlan(plan: ExecutionPlan): { planHash: string } {
    const caseRecord = this.currentCase();
    const authorization = this.currentAuthorization();
    const issues = validatePlan(plan, {
      scope: caseRecord.scope,
      authorization,
      now: this.deps.clock.now(),
      capabilities: this.deps.capabilities,
    });
    const error = firstPlanIssueAsError(issues);
    if (error !== null) {
      throw error;
    }
    const planHash = planHashOf(plan);
    this.record({ type: 'PlanValidated', at: this.deps.clock.now().toISOString(), planHash });
    this.record({
      type: 'PlanAuthorized',
      at: this.deps.clock.now().toISOString(),
      planHash,
      authorizationId: authorization.authorizationId,
    });
    return { planHash };
  }

  /** 計画確認。確認内容の写しと hash の両方を残し、案件 aggregate へ登録する。 */
  confirmPlan(plan: ExecutionPlan, operator: OperatorProfile): PlanConfirmation {
    this.requirePermission(operator, 'run.manage');
    const aggregate = this.currentAggregate();
    const confirmation: PlanConfirmation = {
      confirmationId: this.deps.ids.next('confirm'),
      planHash: planHashOf(plan),
      confirmedBy: operator.operatorId,
      confirmedAt: this.deps.clock.now().toISOString(),
      confirmedView: plan.steps.map((step) => ({ kind: step.kind, targets: step.targetSnapshot, limits: step.limits })),
    };
    aggregate.registerConfirmation({ confirmationId: confirmation.confirmationId, planHash: confirmation.planHash });
    this.record({
      type: 'PlanConfirmed',
      at: this.deps.clock.now().toISOString(),
      planHash: confirmation.planHash,
      confirmedBy: operator.operatorId,
    });
    return confirmation;
  }

  /**
   * 探索の実行 (Enforced 経路)。各 navigation 前に scope・上限・停止を評価し、
   * scope 外 URL は adapter を呼ばずに拒否記録を残す。
   */
  async runExploration(
    operator: OperatorProfile,
    plan: ExecutionPlan,
    confirmation: PlanConfirmation,
    input: ExploreRunInput,
  ): Promise<ExploreRunResult> {
    this.requirePermission(operator, 'run.manage');
    this.requireMatchingConfirmation(plan, confirmation);
    const caseRecord = this.currentCase();
    const step = plan.steps[0];
    if (step === undefined || step.kind !== 'explore') {
      throw domainError('ValidationFailed', 'plan does not contain an exploration step');
    }
    if (input.maxDepth < 1) {
      throw domainError('ValidationFailed', 'maxDepth must be at least 1');
    }

    const runId = this.deps.ids.next('run');
    const planHash = planHashOf(plan);
    this.record({ type: 'RunStarted', at: this.deps.clock.now().toISOString(), runId, planHash });
    const machine = new RunStateMachine('Confirmed');
    machine.transition('Running');

    const observations: PageObservation[] = [];
    const deniedUrls: { url: string; reason: string }[] = [];
    const visited = new Set<string>();
    const frontier: { url: string; depth: number; discoveredFrom: string | null }[] = step.targetSnapshot.map((url) => ({
      url,
      depth: 0,
      discoveredFrom: null,
    }));

    let stopReason: StopReason = 'completed';
    let requests = 0;

    while (frontier.length > 0) {
      const entry = frontier.shift();
      if (entry === undefined) {
        break;
      }
      const canonical = ScopePolicy.canonicalUrl(entry.url);
      if (visited.has(canonical)) {
        continue;
      }
      visited.add(canonical);

      const decision = ScopePolicy.decide(caseRecord.scope, canonical);
      if (!decision.allowed) {
        deniedUrls.push({ url: canonical, reason: decision.reason });
        this.record({ type: 'EgressDenied', at: this.deps.clock.now().toISOString(), url: canonical, reason: decision.reason });
        continue;
      }
      if (requests >= step.limits.maxRequests || observations.length >= step.limits.maxPages) {
        stopReason = 'budget-exhausted';
        break;
      }

      requests += 1;
      const observed = await this.deps.explorer.observe(canonical);
      if (observed === null) {
        continue;
      }
      // 探索の追跡情報 (depth・発見元) は core 側の値で上書きして記録する。
      const observation: PageObservation = { ...observed, url: canonical, depth: entry.depth, discoveredFrom: entry.discoveredFrom };
      observations.push(observation);

      if (entry.depth + 1 <= input.maxDepth) {
        for (const link of observation.links) {
          const linkCanonical = ScopePolicy.canonicalUrl(link);
          if (!visited.has(linkCanonical)) {
            frontier.push({ url: linkCanonical, depth: entry.depth + 1, discoveredFrom: canonical });
          }
        }
      }
    }

    this.exploredUrlCount = observations.length;
    // 上限停止は Completed ではなく Stopped として区別する (design/22 §2)。
    let runState: RunState;
    if (stopReason === 'completed') {
      runState = machine.transition('Completed');
    } else {
      machine.transition('Stopping');
      runState = machine.transition('Stopped');
    }
    const runRecord: RunRecord = {
      runId,
      planId: plan.planId,
      caseId: caseRecord.caseId,
      state: runState,
      attempt: 1,
      stopReason,
    };
    this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason });
    const candidates = observations.flatMap((observation) => candidatesFromObservation(observation, this.deps.ids));
    return { runRecord, planHash, observations, deniedUrls, candidates, engineVersion: this.deps.explorer.engineVersion };
  }

  /** 候補の採用。基準シナリオでは提示された候補を全採用する。 */
  adoptCandidates(operator: OperatorProfile, candidates: readonly ScanCandidate[]): readonly ScanCandidate[] {
    this.requirePermission(operator, 'run.manage');
    if (candidates.length === 0) {
      throw domainError('ValidationFailed', 'no candidates to adopt');
    }
    this.record({
      type: 'CandidatesAdopted',
      at: this.deps.clock.now().toISOString(),
      adoptedCount: candidates.length,
    });
    return candidates;
  }

  /**
   * 能動診断の実行 (Delegated 経路)。確認 hash と能力表を検証してから engine へ入力を渡し、
   * 出力から挙動を推測して記録する。個々の送信は傍受・拒否しない。
   */
  async runActiveScan(
    operator: OperatorProfile,
    plan: ExecutionPlan,
    confirmation: PlanConfirmation,
    adopted: readonly ScanCandidate[],
  ): Promise<ActiveScanRunResult> {
    this.requirePermission(operator, 'run.manage');
    this.requireMatchingConfirmation(plan, confirmation);
    const caseRecord = this.currentCase();
    const step = plan.steps[0];
    if (step === undefined || step.kind !== 'active-scan') {
      throw domainError('ValidationFailed', 'plan does not contain an active-scan step');
    }

    const snapshot = this.deps.capabilities.find((capability) => capability.engineKind === 'zap');
    if (snapshot === undefined || snapshot.engineVersion !== this.deps.scanEngine.engineVersion) {
      throw domainError('CapabilityUnavailable', 'no capability snapshot for the scan engine version');
    }
    if (snapshot.guaranteeLevels.preSendScopeEnforcement === 'Unsupported') {
      throw domainError('CapabilityUnavailable', 'scan engine cannot enforce or delegate scope');
    }

    // 実行対象は計画の target snapshot を正本とする。scope 外候補は snapshot から除外する (F11-UT-003)。
    const targets = step.targetSnapshot.filter((url) => ScopePolicy.decide(caseRecord.scope, url).allowed);
    const adoptedUrls = new Set(adopted.map((candidate) => ScopePolicy.canonicalUrl(candidate.url)));
    const uncovered = [...adoptedUrls].filter((url) => !targets.includes(url));
    if (uncovered.length > 0) {
      throw domainError('ValidationFailed', `plan target snapshot does not cover adopted candidates: ${uncovered.join(', ')}`);
    }

    const runId = this.deps.ids.next('run');
    const planHash = planHashOf(plan);
    this.record({ type: 'RunStarted', at: this.deps.clock.now().toISOString(), runId, planHash });
    const machine = new RunStateMachine('Confirmed');
    machine.transition('Running');

    // Delegated 経路は最大 overshoot 分を共有上限の内側に予約する。
    const reservedRequests = Math.ceil(step.limits.maxRequests * snapshot.maxOvershootRatio);
    const engineLease = step.limits.maxRequests - reservedRequests;
    const scanRequest: ActiveScanRequest = {
      runId,
      targets,
      attackStrength: 'Low',
      leasedLimits: { ...step.limits, maxRequests: engineLease },
      authorizationRef: `authorization:${this.currentAuthorization().authorizationId}`,
    };

    const engineRunId = await this.deps.scanEngine.start(scanRequest);
    const monitor = new ScanMonitor(this.deps.scanEngine, engineRunId, MAX_POLL_ITERATIONS);
    const monitored = await monitor.collectUntilDone();
    const collectedAlerts = monitored.alerts;

    // engine 異常は「URL Does not Exist」等の観測理由とともに失敗として扱い、無制限に再試行しない。
    if (monitored.status === 'failed') {
      this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'engine-failure' });
      machine.transition('Failed');
      throw domainError('EngineFailure', monitored.failureReason ?? 'scan engine failed', {
        details: { engineRunId, engineVersion: this.deps.scanEngine.engineVersion },
      });
    }

    // 観測した出力を原本として保存してから取込む (保存成功後だけ event を出す = SYS-UT-005)。
    let rawEvidence;
    try {
      rawEvidence = await this.deps.evidence.saveText(
        `zap-alerts-raw:${engineRunId}`,
        canonicalJson({ engineRunId, alerts: collectedAlerts }),
      );
    } catch (cause) {
      this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'engine-failure' });
      machine.transition('Failed');
      throw domainError('EngineFailure', `evidence storage failed before findings import: ${String(cause)}`, {
        retryable: true,
        details: { engineRunId },
      });
    }
    const now = this.deps.clock.now().toISOString();
    const importResult = this.importer.importAlerts(collectedAlerts, {
      now,
      engineVersion: this.deps.scanEngine.engineVersion,
      makeFindingId: () => this.deps.ids.next('finding'),
      evidenceRef: rawEvidence.evidenceId,
    });

    this.scannedUrlCount = targets.length;
    this.delegatedSteps = [
      { stepId: step.stepId, engineKind: 'zap', engineVersion: this.deps.scanEngine.engineVersion },
    ];
    const runRecord: RunRecord = {
      runId,
      planId: plan.planId,
      caseId: caseRecord.caseId,
      state: machine.transition('Completed'),
      attempt: 1,
      stopReason: 'completed',
    };
    this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'completed' });
    this.record({
      type: 'FindingsImported',
      at: this.deps.clock.now().toISOString(),
      source: 'zap-alert',
      engineVersion: this.deps.scanEngine.engineVersion,
      importedCount: importResult.created.length,
      duplicateCount: importResult.duplicateCount,
    });
    return {
      runRecord,
      planHash,
      scanRequest,
      findings: this.importer.list(),
      overshootReservation: reservedRequests,
      engineVersion: this.deps.scanEngine.engineVersion,
    };
  }

  /**
   * Nuclei 結果 (JSONL) の取込。engine の起動・送信は行わない観測出力の取込経路であり、
   * 実行 (nuclei-scan step) は能力表が実測を満たすまで公開しない (design/22)。
   * 原本を証拠保存してから所見化し、壊れた行は quarantine して継続する。
   */
  async importNucleiResults(operator: OperatorProfile, input: ImportNucleiResultsInput): Promise<ImportNucleiResultsResult> {
    this.requirePermission(operator, 'run.manage');
    const caseRecord = this.currentCase();
    if (input.engineVersion.trim() === '') {
      throw domainError('ValidationFailed', 'engineVersion must not be empty');
    }

    const parsed = parseNucleiJsonl(input.lines);
    const inScope = parsed.matches.filter((match) => ScopePolicy.decide(caseRecord.scope, match.matchedAt).allowed);
    const excludedOutOfScope = parsed.matches.length - inScope.length;
    const batch = importMatches(inScope);

    const importId = this.deps.ids.next('nuclei-import');
    let rawEvidence;
    try {
      rawEvidence = await this.deps.evidence.saveText(
        `nuclei-jsonl-raw:${importId}`,
        canonicalJson({ importId, engineVersion: input.engineVersion, lines: input.lines }),
      );
    } catch (cause) {
      throw domainError('EngineFailure', `evidence storage failed before nuclei import: ${String(cause)}`, {
        retryable: true,
        details: { importId },
      });
    }
    const result = this.importer.importNucleiMatches(batch.imported, {
      now: this.deps.clock.now().toISOString(),
      engineVersion: input.engineVersion,
      makeFindingId: () => this.deps.ids.next('finding'),
      evidenceRef: rawEvidence.evidenceId,
    });
    this.record({
      type: 'FindingsImported',
      at: this.deps.clock.now().toISOString(),
      source: 'nuclei-match',
      engineVersion: input.engineVersion,
      importedCount: result.created.length,
      duplicateCount: batch.duplicates + result.duplicateCount,
    });
    return {
      findings: this.importer.list(),
      importedCount: result.created.length,
      duplicateCount: batch.duplicates + result.duplicateCount,
      quarantinedCount: parsed.quarantined,
      excludedOutOfScope,
      evidenceRef: rawEvidence.evidenceId,
    };
  }

  /** 報告の生成。delegated step の限界開示を必ず含む。 */
  generateReport(
    operator: OperatorProfile,
    input: { readonly guidelines: readonly string[] },
  ): ReportArtifact {
    this.requirePermission(operator, 'report.export');
    const caseRecord = this.currentCase();
    const model = buildReportModel({
      caseId: caseRecord.caseId,
      generatedAt: this.deps.clock.now().toISOString(),
      guidelines: input.guidelines,
      findings: this.importer.list(),
      coverage: {
        exploredUrlCount: this.exploredUrlCount,
        scannedUrlCount: this.scannedUrlCount,
        delegatedSteps: this.delegatedSteps,
        limitations: [
          '外部 engine (Delegated 経路) の個々の送信は送信前に拒否できない。入力 scope・停止・版ごとの実測で管理する。',
          'engine 由来の所見は実影響未確認であり、人の確認なしに確定扱いにしない。',
          '本報告は固定 fixture に基づく workflow 検証であり、実対象の診断結果ではない。',
        ],
      },
    });
    const reportId = this.deps.ids.next('report');
    const artifact = renderMarkdown(model, reportId);
    this.record({ type: 'ReportGenerated', at: this.deps.clock.now().toISOString(), reportId, modelHash: artifact.modelHash });
    return artifact;
  }

  private requirePermission(operator: OperatorProfile, permission: OperatorPermission): void {
    if (!operator.permissions.includes(permission)) {
      throw domainError('PermissionDenied', `operator ${operator.operatorId} lacks permission ${permission}`);
    }
  }

  private requireMatchingConfirmation(plan: ExecutionPlan, confirmation: PlanConfirmation): void {
    const aggregate = this.currentAggregate();
    if (aggregate.isConfirmationInvalidated(confirmation.confirmationId)) {
      throw domainError('ConfirmationRequired', `plan confirmation was invalidated: ${aggregate.invalidationReason(confirmation.confirmationId) ?? 'unknown reason'}`);
    }
    if (!confirmationMatches(plan, confirmation)) {
      throw domainError('ConfirmationRequired', 'plan confirmation does not match the current plan');
    }
  }

  private currentAggregate(): CaseAggregate {
    if (this.aggregate === null) {
      throw domainError('ValidationFailed', 'case has not been created yet');
    }
    return this.aggregate;
  }

  private canonicalOriginOrThrow(origin: string): string {
    try {
      return ScopePolicy.canonicalOrigin(origin);
    } catch (cause) {
      throw domainError('ValidationFailed', `invalid origin: ${origin}`, { details: { cause: String(cause) } });
    }
  }

  private requirePositiveLimits(limits: ScopeLimits, label: string): void {
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isInteger(value) || value <= 0) {
        throw domainError('ValidationFailed', `${label} limit ${key} must be a positive integer`);
      }
    }
  }

  private planLimits(defaults: PlanLimits, caseLimits: ScopeLimits): PlanLimits {
    return {
      maxRequests: Math.min(defaults.maxRequests, caseLimits.maxRequests),
      maxPages: Math.min(defaults.maxPages, caseLimits.maxPages),
      maxDurationMinutes: Math.min(defaults.maxDurationMinutes, caseLimits.maxDurationMinutes),
      maxConcurrency: defaults.maxConcurrency,
      requestsPerSecond: defaults.requestsPerSecond,
    };
  }

  private record(event: BaselineFlowEvent): void {
    this.eventsLog.push(event);
  }
}

/**
 * 観測から診断候補を生成する seed。分類根拠の guideline 参照は
 * catalog (design/27) の実装まで仮ラベル (`provisional:*`) を使う。
 */
function candidatesFromObservation(observation: PageObservation, ids: IdGenerator): ScanCandidate[] {
  const candidates: ScanCandidate[] = [
    {
      candidateId: ids.next('cand'),
      url: observation.url,
      method: 'GET',
      category: 'page',
      guidelineBasis: ['provisional:page'],
      confidence: 0.7,
      observationUrl: observation.url,
    },
  ];
  for (const form of observation.forms) {
    candidates.push({
      candidateId: ids.next('cand'),
      url: ScopePolicy.canonicalUrl(form.actionUrl),
      method: form.method,
      category: 'form',
      guidelineBasis: [`provisional:form:${form.classification}`],
      confidence: 0.9,
      observationUrl: observation.url,
    });
  }
  return candidates;
}
