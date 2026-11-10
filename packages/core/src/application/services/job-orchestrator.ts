import { canonicalJson, DomainError, domainError, hashStable, type AuthorizationRecord, type CaseRecord, type ExecutionPlan, type Finding, type OperatorProfile, type PlanConfirmation, type RunRecord, type ScanCandidate, type ActiveScanRequest } from '@scopepilot2/contracts';
import { ScopePolicy } from '../../domain/scope-policy.ts';
import { ScanMonitor } from '../../domain/scan-monitor.ts';
import { planHashOf } from '../../domain/plan-service.ts';
import { type ThemeCheckSummary } from '../../domain/zap-unsupported.ts';
import { applicableSessionCookies } from '../../domain/repeater.ts';
import { buildDomCandidate, domEvidenceProjection } from '../../domain/dom-investigation.ts';
import { resolveWorkflowScanCheckIds, runWorkflowScan, WORKFLOW_SCAN_PAYLOAD_SET, type WorkflowScanTransport } from '../../domain/workflow-scan.ts';
import { resolveGuidelineThemeRoutes } from '../../domain/guideline-execution.ts';
import type { BrowserSessionState, LoginSessionCookie } from '../../ports/engines.ts';
import type { ActiveScanExecutionEvent, BaselineFlowDeps, ActiveScanRunResult, ActiveScanPayloadVerification, ActiveScanExecutionControl, GuidelineRouteResult, ImportNucleiResultsInput, ImportNucleiResultsResult } from '../baseline-contracts.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import type { EvidenceServicePort } from './evidence-service.ts';
import type { RunLifecyclePort } from './run-lifecycle-service.ts';
import type { ExecutionContext } from './execution-context.ts';
import type { SessionVault } from './session-vault.ts';
import { requirePermission } from './authorization-policy.ts';
import { DiagnosticRouter, candidateAllowsAutomatedZap, updateDiagnosticRoute } from './diagnostic-router.ts';
import { isSessionControlUrl, automaticGuidelineRequestCount, SharedBudgetWorkflowTransport, workflowHttpEvidenceRecords } from './execution-helpers.ts';
const PAYLOAD_EXECUTION_FINDING_PATTERN = /xss|cross[\s-]?site[\s-]?scripting/i;
const PAYLOAD_URL_MARKER_PATTERN = /(?:%3C|<script|javascript:|onerror\s*=|onload\s*=|alert\s*\(|<img|<svg|<iframe)/i;
const PAYLOAD_VERIFICATION_MAX = 5;
const MAX_POLL_ITERATIONS = 1000;
export interface JobOrchestratorPorts {
    requireMatchingConfirmation(plan: ExecutionPlan, confirmation: PlanConfirmation): void;
    currentCase(): CaseRecord;
    currentAuthorization(): AuthorizationRecord;
    persistFindings(findings: readonly Finding[]): void;
    verifyFindingExecution(operator: OperatorProfile, input: {
        readonly url: string;
        readonly role?: string;
        readonly findingId?: string;
    }): Promise<{
        executed: boolean;
        signals: readonly string[];
        evidenceRef: string;
    }>;
    runZapUnsupportedCheck(operator: OperatorProfile, input: {
        readonly themeNo: string;
        readonly role?: string;
        readonly targetUrls?: readonly string[];
        readonly params?: Readonly<Record<string, string>>;
        readonly secretValues?: Readonly<Record<string, string>>;
    }): Promise<ThemeCheckSummary>;
    importNucleiResults(operator: OperatorProfile, input: ImportNucleiResultsInput): Promise<ImportNucleiResultsResult>;
}
export class JobOrchestrator {
    private readonly deps: Pick<BaselineFlowDeps, 'capabilities' | 'scanEngine' | 'clock' | 'interactiveBrowser' | 'workflowScanTransportFactory' | 'ids' | 'domObserver' | 'scanAlertSettleMs' | 'explorer' | 'nucleiRunner'>;
    private readonly ports: JobOrchestratorPorts;
    private readonly events: EventPublisherPort;
    private readonly router = new DiagnosticRouter();
    private readonly context: ExecutionContext;
    private readonly vault: SessionVault;
    private readonly evidence: EvidenceServicePort;
    private readonly runs: RunLifecyclePort;
    constructor(deps: JobOrchestrator['deps'], ports: JobOrchestratorPorts, events: EventPublisherPort, context: ExecutionContext, vault: SessionVault, evidence: EvidenceServicePort, runs: RunLifecyclePort) {
        this.deps = deps;
        this.ports = ports;
        this.events = events;
        this.context = context;
        this.vault = vault;
        this.evidence = evidence;
        this.runs = runs;
    }
    async runActiveScan(operator: OperatorProfile, plan: ExecutionPlan, confirmation: PlanConfirmation, adopted: readonly ScanCandidate[], role?: string, control: ActiveScanExecutionControl = {}): Promise<ActiveScanRunResult> {
        requirePermission(operator, 'run.manage');
        this.ports.requireMatchingConfirmation(plan, confirmation);
        const caseRecord = this.ports.currentCase();
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
        const targets = step.targetSnapshot.filter((url) => ScopePolicy.decide(caseRecord.scope, url).allowed && !isSessionControlUrl(url));
        this.context.assessmentStartedAt ??= this.deps.clock.now().toISOString();
        this.context.authenticationRole = role ?? null;
        const adoptedUrls = new Set(adopted.map((candidate) => ScopePolicy.canonicalUrl(candidate.url)));
        const uncovered = [...adoptedUrls].filter((url) => !targets.includes(url));
        if (uncovered.length > 0) {
            throw domainError('ValidationFailed', `plan target snapshot does not cover adopted candidates: ${uncovered.join(', ')}`);
        }
        // role session 適用 (design/08: F11)。対象 URL の host/path に一致する cookie 名を
        // scan request へ添える。実 ZAP は proxy 経由 login で jar を作るため値は渡さない。
        let sessionCookieNames: readonly string[] | undefined;
        let scanSessionCookies: readonly LoginSessionCookie[] | undefined;
        let scanSessionHeaders: BrowserSessionState['headers'];
        let scanBrowserSession: BrowserSessionState | undefined;
        let expectedAuthenticatedUrlPrefix: string | undefined;
        let authenticationProbe: {
            readonly url: string;
            readonly markers: readonly string[];
        } | undefined;
        if (role !== undefined) {
            const session = this.vault.roleSessionCookies.get(role);
            if (session === undefined) {
                throw domainError('ValidationFailed', `no session for role '${role}'; run login first`);
            }
            const names: string[] = [];
            for (const target of targets) {
                for (const cookie of applicableSessionCookies([...session.cookies], target)) {
                    if (!names.includes(cookie.name)) {
                        names.push(cookie.name);
                    }
                }
            }
            sessionCookieNames = names;
            scanSessionCookies = session.cookies;
            scanBrowserSession = session.browserState;
            const targetOrigins = new Set(targets.map((target) => new URL(target).origin));
            scanSessionHeaders = (session.browserState.headers ?? []).filter((header) => header.name === 'Authorization'
                && targetOrigins.has(header.origin)
                && header.value.trim() !== ''
                && !/[\r\n]/u.test(header.value));
            expectedAuthenticatedUrlPrefix = session.expectedUrlPrefix;
            if (session.verificationUrl !== undefined) {
                if (!ScopePolicy.decide(caseRecord.scope, session.verificationUrl).allowed) {
                    throw domainError('OutOfScope', `authentication verification URL is out of scope: ${session.verificationUrl}`);
                }
                const markers = (session.verificationMarkers ?? []).filter((marker) => marker !== '');
                // Login assertions are browser-DOM assertions. Searching the same marker in
                // ZAP's raw HTTP response rejects valid SPAs because their authenticated UI
                // is rendered only after JavaScript executes. Re-check the live browser state
                // immediately before scanning, including local/session storage. ZAP retains
                // responsibility for detecting redirects and replaced cookies.
                if (this.deps.interactiveBrowser !== undefined) {
                    const verification = await this.deps.interactiveBrowser.execute({
                        targetUrl: session.verificationUrl,
                        scope: caseRecord.scope,
                        browserSession: session.browserState,
                        steps: [
                            { kind: 'navigate', target: session.verificationUrl },
                            ...markers.map((marker) => ({ kind: 'assert' as const, target: marker })),
                        ],
                    });
                    if (session.expectedUrlPrefix !== undefined && !verification.finalUrl.startsWith(session.expectedUrlPrefix)) {
                        throw domainError('ValidationFailed', `authenticated scan preflight left the expected URL prefix: ${verification.finalUrl}`);
                    }
                    if (verification.assertions.some((assertion) => !assertion.passed)) {
                        throw domainError('ValidationFailed', `authenticated scan preflight failed for ${session.verificationUrl}: browser success marker was not present`);
                    }
                }
                authenticationProbe = { url: session.verificationUrl, markers: [] };
            }
        }
        const workflowStep = plan.steps.find((candidate) => candidate.kind === 'workflow-scan');
        if (workflowStep !== undefined && this.deps.workflowScanTransportFactory === undefined) {
            throw domainError('CapabilityUnavailable', 'workflow scan transport is not configured');
        }
        const runId = this.deps.ids.next('run');
        const planHash = planHashOf(plan);
        this.events.publish({ type: 'RunStarted', at: this.deps.clock.now().toISOString(), runId, planHash });
        const machine = this.runs.createMachine();
        machine.transition('Running');
        this.runs.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Running', attempt: 1 });
        // Delegated 経路は最大 overshoot 分を共有上限の内側に予約する。ガイドラインから
        // 自動接続するScopePilot HTTP検査も同じ案件上限の内側へ先に予約し、ZAP leaseと
        // 二重計上しない。
        const reservedRequests = Math.ceil(step.limits.maxRequests * snapshot.maxOvershootRatio);
        const guidelineThemePlans = resolveGuidelineThemeRoutes(plan.guidelineIds);
        const guidelineTargetUrls = [...new Set(targets.map((target) => ScopePolicy.canonicalUrl(target)))].slice(0, 5);
        const desiredAutomaticThemeNos = guidelineThemePlans.filter((route) => route.mode === 'automatic').map((route) => route.themeNo);
        const desiredGuidelineRequestCount = desiredAutomaticThemeNos.reduce((total, themeNo) => total + automaticGuidelineRequestCount(themeNo, guidelineTargetUrls.length), 0);
        const automaticGuidelineChecksEnabled = desiredGuidelineRequestCount > 0
            && step.limits.maxRequests - reservedRequests - desiredGuidelineRequestCount >= 1;
        const guidelineRequestReservation = automaticGuidelineChecksEnabled ? desiredGuidelineRequestCount : 0;
        const engineLease = step.limits.maxRequests - reservedRequests - guidelineRequestReservation;
        const zapCandidates = adopted.filter(candidateAllowsAutomatedZap);
        const scanRequest: ActiveScanRequest = {
            runId,
            targets,
            attackStrength: 'Medium',
            leasedLimits: { ...step.limits, maxRequests: engineLease },
            authorizationRef: `authorization:${this.ports.currentAuthorization().authorizationId}`,
            ...(sessionCookieNames === undefined ? {} : { sessionCookieNames }),
            requestSeedCount: zapCandidates.length,
        };
        let diagnosticRoutes = this.router.resolve(adopted, this.deps.domObserver !== undefined);
        let guidelineRoutes: readonly GuidelineRouteResult[] = guidelineThemePlans.map((route) => ({
            routeId: `zap-unsupported:${route.themeNo}`,
            themeNo: route.themeNo,
            guidelineIds: route.guidelineIds,
            status: route.mode === 'needs-input'
                ? 'needs-input'
                : automaticGuidelineChecksEnabled
                    ? 'delegated'
                    : 'unavailable',
            detail: route.mode === 'needs-input'
                ? '対象固有のURL・資格情報・比較条件またはレビュー済みpayloadをA03で指定して実行します'
                : automaticGuidelineChecksEnabled
                    ? `確認済みHTTP対象 ${String(guidelineTargetUrls.length)} 件へ自動実行します`
                    : '案件の最大リクエスト数にZAP用の最低1件と自動検査分を確保できないため実行しません',
        }));
        let requestCorpusEvidence;
        try {
            requestCorpusEvidence = await this.evidence.saveText(`http-request-corpus:${runId}`, canonicalJson({
                runId,
                requests: adopted.map((candidate) => ({
                    requestId: candidate.requestId ?? candidate.candidateId,
                    url: ScopePolicy.canonicalUrl(candidate.url),
                    method: candidate.method.toUpperCase(),
                    ...(candidate.contentType === undefined ? {} : { contentType: candidate.contentType }),
                    inputPoints: candidate.inputPoints ?? [],
                    diagnosticTracks: candidate.diagnosticTracks ?? ['zap-active'],
                })),
            }));
        }
        catch (cause) {
            this.events.publish({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'engine-failure' });
            machine.transition('Failed');
            this.runs.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Failed', attempt: 1, stopReason: 'engine-failure' });
            throw domainError('EngineFailure', `request corpus storage failed before scan: ${String(cause)}`, { retryable: true });
        }
        const emit = (event: Omit<ActiveScanExecutionEvent, 'at'>): void => control.onEvent?.({
            at: this.deps.clock.now().toISOString(),
            ...event,
        });
        const throwIfCancelled = (): void => {
            if (control.signal?.aborted === true) {
                throw domainError('Cancelled', 'scan stopped by user');
            }
        };
        throwIfCancelled();
        const deferredRouteCount = diagnosticRoutes.filter((route) => route.status === 'needs-input').length;
        if (deferredRouteCount > 0) {
            emit({
                phase: 'starting',
                engine: 'scopepilot',
                message: `専用診断経路 ${deferredRouteCount} 件は、必要な追加入力を受け取るまで保留します`,
                command: 'ScopePilot diagnostic router: preserve needs-input routes',
                progress: 0,
            });
        }
        emit({
            phase: 'starting',
            engine: 'zap',
            message: `ZAP認証コンテキストを構成し、${zapCandidates.length}件のHTTPリクエスト候補を診断します`,
            command: `ZAP API: context + active HTTP session -> core/sendRequest x ${zapCandidates.length} -> spider/scan + ajaxSpider/scan -> ascan/scan(recurse=false, inScopeOnly=true) -> per-run alert delta`,
            progress: 0,
        });
        const engineRunId = await this.deps.scanEngine.start(scanRequest, {
            ...(scanSessionCookies === undefined ? {} : { sessionCookies: scanSessionCookies }),
            ...(scanSessionHeaders === undefined ? {} : { sessionHeaders: scanSessionHeaders }),
            requestSeeds: zapCandidates.map((candidate) => ({
                url: ScopePolicy.canonicalUrl(candidate.url),
                method: candidate.method.toUpperCase(),
                ...(candidate.contentType === undefined ? {} : { contentType: candidate.contentType }),
                inputPoints: candidate.inputPoints ?? [],
            })),
            ...(expectedAuthenticatedUrlPrefix === undefined ? {} : { expectedAuthenticatedUrlPrefix }),
            ...(authenticationProbe === undefined ? {} : { authenticationProbe }),
        });
        emit({ phase: 'running', engine: 'zap', message: `ZAP scan id ${engineRunId} を監視しています`, progress: 0 });
        const monitor = new ScanMonitor(this.deps.scanEngine, engineRunId, MAX_POLL_ITERATIONS, 2000, this.deps.scanAlertSettleMs ?? 0, control.signal, (progress) => emit({
            phase: 'running',
            engine: 'zap',
            message: `ZAP active scan ${progress.progress}% (${progress.messageCount} messages)`,
            progress: progress.progress,
        }));
        const monitored = await monitor.collectUntilDone();
        const collectedAlerts = monitored.alerts;
        if (monitored.status === 'stopped') {
            machine.requestStop();
            const stoppedRecord: RunRecord = {
                runId,
                planId: plan.planId,
                caseId: caseRecord.caseId,
                state: machine.transition('Stopped'),
                attempt: 1,
                stopReason: 'user-request',
            };
            this.runs.save(stoppedRecord);
            this.events.publish({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'user-request' });
            emit({ phase: 'stopped', engine: 'zap', message: 'ZAP active scan を停止しました', progress: monitored.progress });
            throw domainError('Cancelled', 'scan stopped by user');
        }
        // engine 異常は「URL Does not Exist」等の観測理由とともに失敗として扱い、無制限に再試行しない。
        if (monitored.status === 'failed') {
            this.events.publish({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'engine-failure' });
            machine.transition('Failed');
            this.runs.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Failed', attempt: 1, stopReason: 'engine-failure' });
            throw domainError('EngineFailure', monitored.failureReason ?? 'scan engine failed', {
                details: { engineRunId, engineVersion: this.deps.scanEngine.engineVersion },
            });
        }
        diagnosticRoutes = diagnosticRoutes.map((route) => route.track === 'zap-active'
            ? { ...route, status: 'executed' as const, detail: 'ZAP active scanを完了し、run開始前後のalert差分を収集しました' }
            : route);
        // 観測した出力を原本として保存してから取込む (保存成功後だけ event を出す = SYS-UT-005)。
        let rawEvidence;
        try {
            rawEvidence = await this.evidence.saveText(`zap-alerts-raw:${engineRunId}`, canonicalJson({ engineRunId, alerts: collectedAlerts }));
        }
        catch (cause) {
            this.events.publish({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'engine-failure' });
            machine.transition('Failed');
            this.runs.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Failed', attempt: 1, stopReason: 'engine-failure' });
            throw domainError('EngineFailure', `evidence storage failed before findings import: ${String(cause)}`, {
                retryable: true,
                details: { engineRunId },
            });
        }
        const now = this.deps.clock.now().toISOString();
        const importResult = this.context.importer.importAlerts(collectedAlerts, {
            now,
            engineVersion: this.deps.scanEngine.engineVersion,
            makeFindingId: () => this.deps.ids.next('finding'),
            evidenceRef: rawEvidence.evidenceId,
        });
        this.ports.persistFindings([...importResult.created, ...importResult.reobserved]);
        // payload 実行検証 (design/30 30.1): 反射系 XSS 所見のうち URL に payload が乗っている
        // ものは、browser で実際に開いて dialog 発火を確認する。検証失敗は診断全体を失敗させず
        // 結果に記録する (上限 5 件・browser 検証に非対応の構成では実行しない)。
        const payloadVerifications: ActiveScanPayloadVerification[] = [];
        if (typeof this.deps.explorer.verifyPayloadExecution === 'function') {
            const verifiableFindings = [...importResult.created, ...importResult.reobserved]
                .filter((finding) => PAYLOAD_EXECUTION_FINDING_PATTERN.test(finding.title) && PAYLOAD_URL_MARKER_PATTERN.test(finding.url))
                .slice(0, PAYLOAD_VERIFICATION_MAX);
            for (const finding of verifiableFindings) {
                throwIfCancelled();
                emit({
                    phase: 'running',
                    engine: 'scopepilot',
                    message: `所見「${finding.title}」の payload 実行を browser で検証します`,
                    progress: 95,
                });
                try {
                    const verification = await this.ports.verifyFindingExecution(operator, {
                        url: finding.url,
                        findingId: finding.findingId,
                        ...(role === undefined ? {} : { role }),
                    });
                    payloadVerifications.push({
                        findingId: finding.findingId,
                        title: finding.title,
                        url: finding.url,
                        executed: verification.executed,
                        signals: verification.signals,
                        evidenceRef: verification.evidenceRef,
                    });
                }
                catch (cause) {
                    if (control.signal?.aborted === true || (cause instanceof DomainError && cause.code === 'Cancelled')) {
                        throw domainError('Cancelled', 'scan stopped by user');
                    }
                    payloadVerifications.push({
                        findingId: finding.findingId,
                        title: finding.title,
                        url: finding.url,
                        executed: false,
                        signals: [],
                        error: cause instanceof Error ? cause.message : String(cause),
                    });
                }
            }
        }
        for (const themeNo of automaticGuidelineChecksEnabled ? desiredAutomaticThemeNos : []) {
            throwIfCancelled();
            emit({
                phase: 'running',
                engine: 'scopepilot',
                message: `ガイドライン実行経路 zap-unsupported:${themeNo} を開始します`,
                command: `ScopePilot guideline route: zap-unsupported:${themeNo}`,
            });
            try {
                const summary = await this.ports.runZapUnsupportedCheck(operator, {
                    themeNo,
                    targetUrls: guidelineTargetUrls,
                    ...(role === undefined ? {} : { role }),
                });
                guidelineRoutes = guidelineRoutes.map((route) => route.themeNo === themeNo
                    ? {
                        ...route,
                        status: 'executed' as const,
                        detail: `自動HTTP検査を完了しました: ${summary.status}; ${String(summary.totalRequests)} probes`,
                        checkId: summary.checkId,
                        checkStatus: summary.status,
                    }
                    : route);
            }
            catch (cause) {
                if (control.signal?.aborted === true || (cause instanceof DomainError && cause.code === 'Cancelled')) {
                    throw domainError('Cancelled', 'scan stopped by user');
                }
                const error = cause instanceof Error ? cause.message : String(cause);
                guidelineRoutes = guidelineRoutes.map((route) => route.themeNo === themeNo
                    ? { ...route, status: 'unavailable' as const, detail: `自動HTTP検査を完了できませんでした: ${error}` }
                    : route);
                emit({ phase: 'running', engine: 'scopepilot', message: `ガイドライン実行経路 zap-unsupported:${themeNo} は独立して失敗しました: ${error}` });
            }
        }
        const domTargets = diagnosticRoutes
            .filter((route) => route.track === 'browser-dom' && route.status === 'delegated')
            .map((route) => route.targetUrl);
        for (const targetUrl of domTargets) {
            throwIfCancelled();
            emit({
                phase: 'running',
                engine: 'scopepilot',
                message: `Playwright DOM value-flow 観測: ${targetUrl}`,
                command: `Playwright DOM observer: ${targetUrl}`,
            });
            try {
                const observer = this.deps.domObserver;
                if (observer === undefined) {
                    throw new Error('DOM observer is not configured');
                }
                const appliedCookies = scanSessionCookies === undefined
                    ? undefined
                    : applicableSessionCookies([...scanSessionCookies], targetUrl);
                const observed = await observer.observe({
                    targetUrl,
                    scope: caseRecord.scope,
                    ...(scanBrowserSession === undefined
                        ? appliedCookies === undefined ? {} : { sessionCookies: appliedCookies }
                        : { browserSession: scanBrowserSession }),
                });
                const valueFlows = buildDomCandidate(observed.observations);
                const projectedFlows = valueFlows.map((candidate) => ({
                    sourceApi: candidate.sourceApi,
                    sinkApi: candidate.sinkApi,
                    confidence: candidate.confidence,
                    marker: `sha256:${hashStable('scopepilot2.dom.marker', candidate.marker)}`,
                }));
                const domEvidence = await this.evidence.saveText(`dom-observation:${runId}:${hashStable('scopepilot2.dom.target', targetUrl).slice(0, 12)}`, canonicalJson({ targetUrl, valueFlows: projectedFlows, nodes: domEvidenceProjection(observed.nodes) }));
                const domImport = this.context.importer.importObservationCandidates(projectedFlows.map((candidate) => ({
                    key: `scopepilot-dom-flow:${candidate.sourceApi}:${candidate.sinkApi}`,
                    title: `Potential DOM value flow: ${candidate.sourceApi} -> ${candidate.sinkApi}`,
                    url: targetUrl,
                    method: 'GET',
                    param: `${candidate.sourceApi} -> ${candidate.sinkApi}`,
                    severity: candidate.confidence >= 0.8 ? 'low' as const : 'info' as const,
                })), {
                    now: this.deps.clock.now().toISOString(),
                    engineVersion: 'scopepilot-playwright-dom-v1',
                    makeFindingId: () => this.deps.ids.next('finding'),
                    evidenceRef: domEvidence.evidenceId,
                });
                this.ports.persistFindings([...domImport.created, ...domImport.reobserved]);
                diagnosticRoutes = updateDiagnosticRoute(diagnosticRoutes, 'browser-dom', targetUrl, {
                    status: 'executed',
                    detail: `Playwrightでsource→sinkを観測し、候補 ${valueFlows.length} 件を証跡化しました`,
                    findingCount: valueFlows.length,
                });
                this.events.publish({
                    type: 'FindingsImported',
                    at: this.deps.clock.now().toISOString(),
                    source: 'observation',
                    engineVersion: 'scopepilot-playwright-dom-v1',
                    importedCount: domImport.created.length,
                    duplicateCount: domImport.duplicateCount,
                });
            }
            catch (cause) {
                diagnosticRoutes = updateDiagnosticRoute(diagnosticRoutes, 'browser-dom', targetUrl, {
                    status: 'unavailable',
                    detail: `DOM観測を完了できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
                });
                emit({
                    phase: 'running',
                    engine: 'scopepilot',
                    message: `DOM観測を保留しました: ${targetUrl}`,
                });
            }
        }
        let workflowSummary: ActiveScanRunResult['workflow'];
        if (workflowStep !== undefined && this.deps.workflowScanTransportFactory !== undefined) {
            const baseUrls = [...new Set(workflowStep.targetSnapshot.map((target) => new URL(target).origin))];
            const plannedTargets = new Set(workflowStep.targetSnapshot.map((target) => ScopePolicy.canonicalUrl(target)));
            const selectedWorkflowCheckIds = resolveWorkflowScanCheckIds(plan.guidelineIds);
            const budget = { limit: workflowStep.limits.maxRequests, used: 0 };
            const evidenceRefs: string[] = [];
            const allChecks: import('../../domain/workflow-scan.ts').WorkflowScanCheckResult[] = [];
            let skipCount = 0;
            let importedCount = 0;
            let duplicateCount = 0;
            const transports: WorkflowScanTransport[] = [];
            try {
                for (const baseUrl of baseUrls) {
                    throwIfCancelled();
                    const targetsForOrigin = adopted
                        .filter((candidate) => new URL(candidate.url).origin === baseUrl && plannedTargets.has(ScopePolicy.canonicalUrl(candidate.url)))
                        .map((candidate) => ({
                        url: ScopePolicy.canonicalUrl(candidate.url),
                        method: candidate.method,
                        inputPoints: candidate.inputPoints ?? [],
                        ...(candidate.contentType === undefined ? {} : { contentType: candidate.contentType }),
                    }));
                    const sessionCookies = scanSessionCookies === undefined
                        ? []
                        : applicableSessionCookies([...scanSessionCookies], baseUrl);
                    const sessionHeaders = (scanSessionHeaders ?? [])
                        .filter((header) => header.origin === baseUrl)
                        .map((header) => ({ name: header.name, value: header.value }));
                    const createTransport = (): WorkflowScanTransport => {
                        const transport = new SharedBudgetWorkflowTransport(this.deps.workflowScanTransportFactory!({
                            baseUrl,
                            maxRequests: workflowStep.limits.maxRequests,
                            redactionValues: [
                                ...sessionCookies.map((cookie) => cookie.value),
                                ...sessionHeaders.map((header) => header.value),
                            ],
                            sessionCookies: sessionCookies.map((cookie) => ({ name: cookie.name, value: cookie.value })),
                            ...(sessionHeaders.length === 0 ? {} : { sessionHeaders }),
                            ...(control.signal === undefined ? {} : { signal: control.signal }),
                        }), budget);
                        transports.push(transport);
                        return transport;
                    };
                    const primary = createTransport();
                    emit({
                        phase: 'starting',
                        engine: 'scopepilot',
                        message: `汎用HTTP診断 (${String(selectedWorkflowCheckIds.length)}観点・${String(targetsForOrigin.length)}候補) を開始します: ${baseUrl}`,
                        command: `ScopePilot generic HTTP diagnostics: ${WORKFLOW_SCAN_PAYLOAD_SET}; maxRequests=${String(workflowStep.limits.maxRequests)}`,
                        progress: 0,
                    });
                    const result = await runWorkflowScan({
                        baseUrl,
                        targets: targetsForOrigin,
                        authenticated: sessionCookies.length > 0 || sessionHeaders.length > 0,
                        maxRequests: workflowStep.limits.maxRequests,
                        checkIds: selectedWorkflowCheckIds,
                        ...(control.signal === undefined ? {} : { signal: control.signal }),
                    }, primary, {
                        progress: (message) => emit({ phase: 'running', engine: 'scopepilot', message }),
                    });
                    const evidence = await this.evidence.saveText(`workflow-scan:${runId}:${hashStable('scopepilot2.workflow.origin', baseUrl).slice(0, 12)}`, canonicalJson({
                        runId,
                        result,
                        alerts: workflowHttpEvidenceRecords(result.checks, result.requestLog, baseUrl),
                        totalRequestCount: budget.used,
                    }));
                    evidenceRefs.push(evidence.evidenceId);
                    allChecks.push(...result.checks);
                    skipCount += result.skips.length;
                    const imported = this.context.importer.importObservationCandidates(result.checks.map((check) => ({
                        key: `workflow-scan:${check.checkId}:${hashStable('scopepilot2.workflow.target', check.url).slice(0, 12)}`,
                        title: check.title,
                        url: new URL(check.url, `${baseUrl}/`).toString(),
                        method: check.method,
                        param: check.param,
                        severity: check.severity,
                    })), {
                        now: this.deps.clock.now().toISOString(),
                        engineVersion: result.payloadSet,
                        makeFindingId: () => this.deps.ids.next('finding'),
                        evidenceRef: evidence.evidenceId,
                    });
                    importedCount += imported.created.length;
                    duplicateCount += imported.duplicateCount;
                    this.ports.persistFindings([...imported.created, ...imported.reobserved]);
                    this.events.publish({
                        type: 'FindingsImported',
                        at: this.deps.clock.now().toISOString(),
                        source: 'observation',
                        engineVersion: result.payloadSet,
                        importedCount: imported.created.length,
                        duplicateCount: imported.duplicateCount,
                    });
                }
                workflowSummary = {
                    status: 'completed',
                    payloadSet: WORKFLOW_SCAN_PAYLOAD_SET,
                    baseUrls,
                    requestCount: budget.used,
                    checkKindCount: new Set(allChecks.map((check) => check.checkId)).size,
                    checkCount: allChecks.length,
                    skipCount,
                    importedCount,
                    duplicateCount,
                    evidenceRefs,
                };
                emit({
                    phase: 'completed',
                    engine: 'scopepilot',
                    message: `汎用HTTP診断完了: ${String(workflowSummary.checkKindCount)}/${String(selectedWorkflowCheckIds.length)}観点で所見 ${String(workflowSummary.checkCount)} 件`,
                    progress: 100,
                });
            }
            catch (cause) {
                if (control.signal?.aborted === true || (cause instanceof DomainError && cause.code === 'Cancelled')) {
                    throw domainError('Cancelled', 'workflow scan stopped by user');
                }
                const error = cause instanceof Error ? cause.message : String(cause);
                const partialLogs = transports.flatMap((transport) => transport.takeRequestLog());
                if (partialLogs.length > 0) {
                    const partial = await this.evidence.saveText(`workflow-scan-partial:${runId}`, canonicalJson({ runId, payloadSet: WORKFLOW_SCAN_PAYLOAD_SET, baseUrls, requestCount: budget.used, requestLog: partialLogs, error }));
                    evidenceRefs.push(partial.evidenceId);
                }
                workflowSummary = {
                    status: 'failed',
                    payloadSet: WORKFLOW_SCAN_PAYLOAD_SET,
                    baseUrls,
                    requestCount: budget.used,
                    checkKindCount: new Set(allChecks.map((check) => check.checkId)).size,
                    checkCount: allChecks.length,
                    skipCount,
                    importedCount,
                    duplicateCount,
                    evidenceRefs,
                    error,
                };
                emit({ phase: 'completed', engine: 'scopepilot', message: `Workflow scan failed independently: ${error}`, progress: 100 });
            }
        }
        await this.evidence.saveText(`diagnostic-routes:${runId}`, canonicalJson({ runId, routes: diagnosticRoutes }));
        this.context.latestDiagnosticRoutes = diagnosticRoutes;
        await this.evidence.saveText(`guideline-routes:${runId}`, canonicalJson({ runId, guidelineIds: plan.guidelineIds, routes: guidelineRoutes }));
        this.context.latestGuidelineRoutes = guidelineRoutes;
        const nucleiStep = plan.steps.find((candidate) => candidate.kind === 'nuclei-scan');
        let nucleiSummary: ActiveScanRunResult['nuclei'];
        if (nucleiStep !== undefined) {
            try {
                throwIfCancelled();
                const nucleiRunner = this.deps.nucleiRunner;
                if (nucleiRunner === undefined) {
                    throw domainError('CapabilityUnavailable', 'confirmed plan requires nuclei but no nuclei runtime is configured');
                }
                const nucleiCapability = this.deps.capabilities.find((capability) => capability.engineKind === 'nuclei');
                if (nucleiCapability === undefined || nucleiCapability.engineVersion !== nucleiRunner.engineVersion) {
                    throw domainError('CapabilityUnavailable', 'no capability snapshot for the nuclei engine version');
                }
                const nucleiTargets = nucleiStep.targetSnapshot.filter((url) => ScopePolicy.decide(caseRecord.scope, url).allowed);
                const nucleiCommand = `nuclei -type http -t <reviewed-hash-pinned-template-bundle> -exclude-tags dos,fuzz,intrusive,bruteforce,headless,code,network,file,dns,oast -severity medium,high,critical -l <confirmed-targets:${nucleiTargets.length}> -rate-limit ${nucleiStep.limits.requestsPerSecond} -concurrency ${nucleiStep.limits.maxConcurrency} -max-time ${nucleiStep.limits.maxDurationMinutes}m (shared ScopePilot request guard: ${nucleiStep.limits.maxRequests})`;
                emit({
                    phase: 'starting',
                    engine: 'nuclei',
                    message: `Nuclei reviewed HTTP template scan を開始します (${nucleiTargets.length} confirmed target)`,
                    command: nucleiCommand,
                    progress: 0,
                });
                const nucleiOutput = await nucleiRunner.run({
                    targets: nucleiTargets,
                    limits: nucleiStep.limits,
                    ...(control.signal === undefined ? {} : { signal: control.signal }),
                    onLog: (line) => emit({ phase: 'running', engine: 'nuclei', message: line }),
                });
                throwIfCancelled();
                await this.evidence.saveText(`nuclei-execution:${runId}`, canonicalJson({
                    runId,
                    engineVersion: nucleiRunner.engineVersion,
                    templateBundleHash: nucleiRunner.templateBundleHash ?? 'unavailable',
                    targets: nucleiTargets,
                }));
                emit({ phase: 'collecting', engine: 'nuclei', message: `Nuclei JSONL ${nucleiOutput.lines.length} 行を取り込みます`, progress: 100 });
                const imported = await this.ports.importNucleiResults(operator, {
                    engineVersion: nucleiRunner.engineVersion,
                    lines: nucleiOutput.lines,
                });
                nucleiSummary = {
                    status: 'completed',
                    engineVersion: nucleiRunner.engineVersion,
                    ...(nucleiRunner.templateBundleHash === undefined ? {} : { templateBundleHash: nucleiRunner.templateBundleHash }),
                    importedCount: imported.importedCount,
                    duplicateCount: imported.duplicateCount,
                    quarantinedCount: imported.quarantinedCount,
                    excludedOutOfScope: imported.excludedOutOfScope,
                };
                emit({ phase: 'completed', engine: 'nuclei', message: `Nuclei scan 完了: 新規所見 ${imported.importedCount} 件`, progress: 100 });
            }
            catch (cause) {
                if (control.signal?.aborted === true || (cause instanceof DomainError && cause.code === 'Cancelled')) {
                    machine.requestStop();
                    const stoppedRecord: RunRecord = {
                        runId,
                        planId: plan.planId,
                        caseId: caseRecord.caseId,
                        state: machine.transition('Stopped'),
                        attempt: 1,
                        stopReason: 'user-request',
                    };
                    this.runs.save(stoppedRecord);
                    this.events.publish({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'user-request' });
                    emit({ phase: 'stopped', engine: 'nuclei', message: 'Nuclei scan を停止しました' });
                    throw domainError('Cancelled', 'scan stopped by user');
                }
                const error = cause instanceof Error ? cause.message : String(cause);
                nucleiSummary = {
                    status: 'failed',
                    engineVersion: this.deps.nucleiRunner?.engineVersion ?? 'unavailable',
                    ...(this.deps.nucleiRunner?.templateBundleHash === undefined ? {} : { templateBundleHash: this.deps.nucleiRunner.templateBundleHash }),
                    importedCount: 0,
                    duplicateCount: 0,
                    quarantinedCount: 0,
                    excludedOutOfScope: 0,
                    error,
                };
                emit({ phase: 'completed', engine: 'nuclei', message: `Nuclei step failed independently: ${error}`, progress: 100 });
            }
        }
        this.context.scannedUrlCount = targets.length;
        this.context.scannedUrls = new Set(targets.map((url) => ScopePolicy.canonicalUrl(url)));
        this.context.assessmentEndedAt = this.deps.clock.now().toISOString();
        this.context.delegatedSteps = [
            { stepId: step.stepId, engineKind: 'zap', engineVersion: this.deps.scanEngine.engineVersion },
            ...(workflowStep === undefined ? [] : [{
                    stepId: workflowStep.stepId,
                    engineKind: 'node-http' as const,
                    engineVersion: WORKFLOW_SCAN_PAYLOAD_SET,
                }]),
            ...(nucleiStep === undefined || this.deps.nucleiRunner === undefined ? [] : [{
                    stepId: nucleiStep.stepId,
                    engineKind: 'nuclei' as const,
                    engineVersion: this.deps.nucleiRunner.engineVersion,
                }]),
        ];
        const runRecord: RunRecord = {
            runId,
            planId: plan.planId,
            caseId: caseRecord.caseId,
            state: machine.transition('Completed'),
            attempt: 1,
            stopReason: 'completed',
        };
        this.runs.save(runRecord);
        this.events.publish({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'completed' });
        emit({ phase: 'completed', engine: 'scopepilot', message: `診断完了: 所見 ${this.context.importer.list().length} 件`, progress: 100 });
        this.events.publish({
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
            findings: this.context.importer.list(),
            overshootReservation: reservedRequests,
            engineVersion: this.deps.scanEngine.engineVersion,
            requestCorpusEvidenceRef: requestCorpusEvidence.evidenceId,
            diagnosticRoutes,
            guidelineRoutes,
            ...(workflowSummary === undefined ? {} : { workflow: workflowSummary }),
            ...(nucleiSummary === undefined ? {} : { nuclei: nucleiSummary }),
            ...(payloadVerifications.length === 0 ? {} : { payloadVerifications }),
        };
    }
}
