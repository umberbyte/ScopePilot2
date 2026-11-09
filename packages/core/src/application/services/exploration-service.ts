import { diagnosticTracksFor } from './diagnostic-router.ts';
import { canonicalJson, domainError, type CaseRecord, type ExecutionPlan, type OperatorProfile, type PageObservation, type PlanConfirmation, type RunRecord, type RunState, type ScanCandidate, type StopReason } from '@scopepilot2/contracts';
import { ScopePolicy } from '../../domain/scope-policy.ts';
import { planHashOf } from '../../domain/plan-service.ts';
import type { BrowserSessionState } from '../../ports/engines.ts';
import type { BaselineFlowDeps, ExploreRunInput, ExploreRunResult } from '../baseline-contracts.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import type { EvidenceServicePort } from './evidence-service.ts';
import type { RunLifecyclePort } from './run-lifecycle-service.ts';
import type { ExecutionContext } from './execution-context.ts';
import type { SessionVault } from './session-vault.ts';
import type { CaseSessionContext } from './case-session-context.ts';
import { requirePermission } from './authorization-policy.ts';
import { candidatesFromObservation, isSessionControlUrl, loginMergeKeyOf } from './execution-helpers.ts';
const ROUTE_INSTANTIATION_LIMITS = {
    maxTemplates: 64,
    maxResourceIds: 128,
    maxPerTemplate: 8,
    maxTotalInstantiations: 64,
} as const;
export interface ExplorationServicePorts {
    requireMatchingConfirmation(plan: ExecutionPlan, confirmation: PlanConfirmation): void;
    currentCase(): CaseRecord;
    isPrioritizedUrl(canonical: string): boolean;
    recordObservedExchange(summary: {
        url: string;
        method: string;
        status: number;
        contentType: string;
    }, at: string, source: 'explore' | 'repeater' | 'fuzzer' | 'sequencer'): void;
}
export class ExplorationService {
    private readonly deps: Pick<BaselineFlowDeps, 'clock' | 'explorer' | 'ids'>;
    private readonly ports: ExplorationServicePorts;
    private readonly events: EventPublisherPort;
    private readonly context: ExecutionContext;
    private readonly vault: SessionVault;
    private readonly caseContext: CaseSessionContext;
    private readonly evidence: EvidenceServicePort;
    private readonly runs: RunLifecyclePort;
    constructor(deps: ExplorationService['deps'], ports: ExplorationServicePorts, events: EventPublisherPort, context: ExecutionContext, vault: SessionVault, caseContext: CaseSessionContext, evidence: EvidenceServicePort, runs: RunLifecyclePort) {
        this.deps = deps;
        this.ports = ports;
        this.events = events;
        this.context = context;
        this.vault = vault;
        this.caseContext = caseContext;
        this.evidence = evidence;
        this.runs = runs;
    }
    async runExploration(operator: OperatorProfile, plan: ExecutionPlan, confirmation: PlanConfirmation, input: ExploreRunInput): Promise<ExploreRunResult> {
        requirePermission(operator, 'run.manage');
        this.ports.requireMatchingConfirmation(plan, confirmation);
        const caseRecord = this.ports.currentCase();
        this.context.assessmentStartedAt ??= this.deps.clock.now().toISOString();
        this.context.authenticationRole = input.role ?? null;
        const step = plan.steps[0];
        if (step === undefined || step.kind !== 'explore') {
            throw domainError('ValidationFailed', 'plan does not contain an exploration step');
        }
        if (input.maxDepth < 1) {
            throw domainError('ValidationFailed', 'maxDepth must be at least 1');
        }
        // role 指定探索 (design/f09): runLogin 済み session のみ。cookie は探索の間だけ
        // explorer へ渡し、記録・応答へは出さない。
        let browserSessionState: BrowserSessionState | undefined;
        if (input.role !== undefined) {
            const session = this.vault.roleSessionCookies.get(input.role);
            if (session === undefined) {
                throw domainError('ValidationFailed', `no session for role '${input.role}'; run login first`);
            }
            if (typeof this.deps.explorer.observeWithSession !== 'function') {
                throw domainError('ValidationFailed', 'configured explorer does not support session observation');
            }
            browserSessionState = session.browserState;
        }
        const runId = this.deps.ids.next('run');
        const planHash = planHashOf(plan);
        this.events.publish({ type: 'RunStarted', at: this.deps.clock.now().toISOString(), runId, planHash });
        const machine = this.runs.createMachine();
        machine.transition('Running');
        this.runs.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Running', attempt: 1 });
        const observations: PageObservation[] = [];
        const deniedUrls: {
            url: string;
            reason: string;
        }[] = [];
        const visited = new Set<string>();
        // hint 由来の開始点は観測の由来を document-hint として残す (F08・AGENTS.md: 未確認表示)。
        const hintSeeds = this.caseContext.explorationHintSeeds.get(plan.planId);
        const frontier: {
            url: string;
            depth: number;
            discoveredFrom: string | null;
            origin: 'crawl' | 'document-hint';
            priority: 'high' | 'normal';
        }[] = step.targetSnapshot.map((url) => ({
            url,
            depth: 0,
            discoveredFrom: null,
            origin: hintSeeds?.has(url) === true ? 'document-hint' : 'crawl',
            // 文書由来の優先付け規則 (pii・payment) に一致する URL は先に処理する。
            priority: this.ports.isPrioritizedUrl(url) ? 'high' : 'normal',
        }));
        // 動的ルートの具体化 (design/22 の安全制御の内側): スクリプト由来の :param 付き
        // テンプレートは観測済み識別子 (API 応答・URL セグメント) だけで具体化する。
        // テンプレート自体は巡回しない。値を推測して送信しない。
        const routeTemplates = new Map<string, number>();
        const observedResourceIdCounts = new Map<string, number>();
        const instantiatedUrls = new Set<string>();
        const instantiatedPerTemplate = new Map<string, number>();
        let instantiationCount = 0;
        let stopReason: StopReason = 'completed';
        let requests = 0;
        while (frontier.length > 0) {
            // 優先付け (AGENTS.md): 高優先 (pii・payment) の entry が残っていれば先に処理する。
            let nextIndex = frontier.findIndex((candidate) => candidate.priority === 'high');
            if (nextIndex === -1) {
                nextIndex = 0;
            }
            const entry = frontier.splice(nextIndex, 1)[0];
            if (entry === undefined) {
                break;
            }
            const canonical = ScopePolicy.canonicalBrowserUrl(entry.url);
            if (visited.has(canonical)) {
                continue;
            }
            visited.add(canonical);
            // Filtering these endpoints only when S04 candidates are built is too
            // late: navigating to /logout.php has already invalidated the server-side
            // session. Enforce the exclusion before the explorer adapter is called.
            if (isSessionControlUrl(canonical)) {
                const reason = 'session-control URL is excluded from automated exploration';
                deniedUrls.push({ url: canonical, reason });
                this.events.publish({ type: 'EgressDenied', at: this.deps.clock.now().toISOString(), url: canonical, reason });
                continue;
            }
            const decision = ScopePolicy.decide(caseRecord.scope, canonical);
            if (!decision.allowed) {
                deniedUrls.push({ url: canonical, reason: decision.reason });
                this.events.publish({ type: 'EgressDenied', at: this.deps.clock.now().toISOString(), url: canonical, reason: decision.reason });
                continue;
            }
            if (requests >= step.limits.maxRequests || observations.length >= step.limits.maxPages) {
                stopReason = 'budget-exhausted';
                break;
            }
            requests += 1;
            const observed = browserSessionState === undefined
                ? await this.deps.explorer.observe(canonical)
                : await this.deps.explorer.observeWithSession!(canonical, browserSessionState);
            if (observed === null) {
                continue;
            }
            const finalUrl = ScopePolicy.canonicalBrowserUrl(observed.finalUrl ?? observed.url);
            const finalDecision = ScopePolicy.decide(caseRecord.scope, finalUrl);
            if (!finalDecision.allowed) {
                deniedUrls.push({ url: finalUrl, reason: finalDecision.reason });
                this.events.publish({ type: 'EgressDenied', at: this.deps.clock.now().toISOString(), url: finalUrl, reason: finalDecision.reason });
                continue;
            }
            // 探索の追跡情報 (depth・発見元・由来) は core 側の値で上書きして記録する。
            const observation: PageObservation = { ...observed, url: canonical, finalUrl, depth: entry.depth, discoveredFrom: entry.discoveredFrom, originType: entry.origin };
            observations.push(observation);
            this.ports.recordObservedExchange({ url: finalUrl, method: 'GET', status: observation.status, contentType: observation.contentType }, this.deps.clock.now().toISOString(), 'explore');
            if (entry.depth + 1 <= input.maxDepth) {
                for (const link of observation.links) {
                    const linkCanonical = ScopePolicy.canonicalBrowserUrl(link);
                    if (!visited.has(linkCanonical)) {
                        frontier.push({ url: linkCanonical, depth: entry.depth + 1, discoveredFrom: finalUrl, origin: 'crawl', priority: this.ports.isPrioritizedUrl(linkCanonical) ? 'high' : 'normal' });
                    }
                }
            }
            // 観測で得たルートテンプレートと識別子を蓄積し、両者が揃った時点だけで
            // 具体化 URL を frontier へ追加する。追加先は通常の link と同じ (pop 時に
            // scope・session-control・上限を再評価する)。
            for (const template of observation.routeTemplates ?? []) {
                const canonicalTemplate = ScopePolicy.canonicalBrowserUrl(template);
                if (routeTemplates.size < ROUTE_INSTANTIATION_LIMITS.maxTemplates && !routeTemplates.has(canonicalTemplate)) {
                    routeTemplates.set(canonicalTemplate, entry.depth + 1);
                }
            }
            for (const id of observation.observedResourceIds ?? []) {
                if (observedResourceIdCounts.size >= ROUTE_INSTANTIATION_LIMITS.maxResourceIds
                    && !observedResourceIdCounts.has(id))
                    break;
                observedResourceIdCounts.set(id, (observedResourceIdCounts.get(id) ?? 0) + 1);
            }
            if (entry.depth + 1 <= input.maxDepth && instantiationCount < ROUTE_INSTANTIATION_LIMITS.maxTotalInstantiations) {
                // 具体化の優先付け: 複数ページで観測された識別子 (中心的なエンティティ) ほど先に使う。
                // 同頻度は観測順 (Map の挿入順・安定ソート) を維持する。
                const prioritizedResourceIds = [...observedResourceIdCounts.entries()]
                    .sort((left, right) => right[1] - left[1])
                    .map(([id]) => id);
                for (const template of routeTemplates.keys()) {
                    const used = instantiatedPerTemplate.get(template) ?? 0;
                    if (used >= ROUTE_INSTANTIATION_LIMITS.maxPerTemplate)
                        continue;
                    // 複数パラメータの直積は観測根拠を稀薄にするため対象外。1 パラメータだけ。
                    const paramMatch = template.match(/\/:[A-Za-z][\w-]*(?=\/|$)/);
                    if (paramMatch === null)
                        continue;
                    for (const id of prioritizedResourceIds) {
                        if ((instantiatedPerTemplate.get(template) ?? 0) >= ROUTE_INSTANTIATION_LIMITS.maxPerTemplate)
                            break;
                        const concrete = template.replace(paramMatch[0]!, `/${id}`);
                        const canonical = ScopePolicy.canonicalBrowserUrl(concrete);
                        // 具体化結果にパラメータ片が残っていれば使用しない (送信前の防御)。
                        if (/\/:[A-Za-z][\w-]*(?=\/|$)/.test(canonical))
                            continue;
                        if (visited.has(canonical) || instantiatedUrls.has(canonical))
                            continue;
                        instantiatedUrls.add(canonical);
                        instantiatedPerTemplate.set(template, (instantiatedPerTemplate.get(template) ?? 0) + 1);
                        instantiationCount += 1;
                        frontier.push({ url: canonical, depth: entry.depth + 1, discoveredFrom: finalUrl, origin: 'crawl', priority: this.ports.isPrioritizedUrl(canonical) ? 'high' : 'normal' });
                        if (instantiationCount >= ROUTE_INSTANTIATION_LIMITS.maxTotalInstantiations)
                            break;
                    }
                    if (instantiationCount >= ROUTE_INSTANTIATION_LIMITS.maxTotalInstantiations)
                        break;
                }
            }
        }
        this.context.exploredUrlCount = observations.length;
        for (const observation of observations) {
            this.context.observationsByUrl.set(observation.url, observation);
        }
        for (const denied of deniedUrls) {
            (this.context.deniedUrlLog as {
                url: string;
                reason: string;
            }[]).push(denied);
        }
        // 上限停止は Completed ではなく Stopped として区別する (design/22 §2)。
        let runState: RunState;
        if (stopReason === 'completed') {
            runState = machine.transition('Completed');
        }
        else {
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
        this.runs.save(runRecord);
        this.events.publish({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason });
        // 観測横断で同一リクエスト/定義の候補を重複させない (同一スクリプトが複数ページで
        // 読み込まれると API 呼び出し定義が毎ページ再抽出されるため、ここで一意化する)。
        const candidates: ScanCandidate[] = [];
        const candidateKeys = new Set<string>();
        for (const observation of observations) {
            for (const candidate of candidatesFromObservation(observation, this.deps.ids)) {
                const key = `${candidate.category}|${loginMergeKeyOf(candidate.method, candidate.url, candidate.inputPoints ?? [])}`;
                if (candidateKeys.has(key))
                    continue;
                candidateKeys.add(key);
                candidates.push(candidate);
            }
        }
        // login 実行時に観測したリクエスト (XHR 裏付けの認証 API 等) を候補へ合成する。
        // 同じ入力点を持つ候補が探索で既に観測されている場合は探索由来を優先する。
        const crawlCandidateKeys = new Set(candidates.map((candidate) => loginMergeKeyOf(candidate.method, candidate.url, candidate.inputPoints ?? [])));
        const loginCandidates: ScanCandidate[] = [];
        const loginSeen = new Set<string>();
        for (const observation of this.vault.loginObservations.values()) {
            for (const candidate of candidatesFromObservation({ ...observation, url: ScopePolicy.canonicalUrl(observation.url) }, this.deps.ids)) {
                if (candidate.category === 'page' || isSessionControlUrl(candidate.url))
                    continue;
                if (!ScopePolicy.decide(caseRecord.scope, candidate.url).allowed)
                    continue;
                const key = loginMergeKeyOf(candidate.method, candidate.url, candidate.inputPoints ?? []);
                if (crawlCandidateKeys.has(key) || loginSeen.has(key))
                    continue;
                loginSeen.add(key);
                loginCandidates.push({
                    ...candidate,
                    detectionReason: `${candidate.detectionReason ?? ''} (login 実行時に観測)`.trim(),
                });
            }
        }
        const mergedCandidates = [...candidates, ...loginCandidates];
        // API 仕様 (OpenAPI) 取込済み endpoint も診断候補へ合成する。閲覧クロールでは
        // 発火しない書き込み API (POST/PUT/DELETE) を仕様から拾うことが目的。
        // path template ({id}) は具体値がないため対象外とし、重複は既存候補を優先する。
        const apiSpecCandidates: ScanCandidate[] = [];
        const specSeen = new Set<string>();
        for (const apiSpec of this.context.apiSpecImports) {
            for (const endpoint of apiSpec.endpoints) {
                if (endpoint.path.includes('{'))
                    continue;
                if (!ScopePolicy.decide(caseRecord.scope, endpoint.url).allowed)
                    continue;
                const key = loginMergeKeyOf(endpoint.method, endpoint.url, endpoint.inputPoints);
                if (crawlCandidateKeys.has(key) || loginSeen.has(key) || specSeen.has(key))
                    continue;
                specSeen.add(key);
                if (isSessionControlUrl(endpoint.url))
                    continue;
                apiSpecCandidates.push({
                    candidateId: this.deps.ids.next('cand'),
                    url: ScopePolicy.canonicalUrl(endpoint.url),
                    method: endpoint.method,
                    category: 'api-endpoint',
                    guidelineBasis: [`api-spec:${apiSpec.documentLabel}`],
                    confidence: 0.8,
                    observationUrl: endpoint.url,
                    detectionReason: `API 仕様 (${apiSpec.documentLabel}) に ${endpoint.method} ${endpoint.path} が定義されている`,
                    dynamic: endpoint.method.toUpperCase() !== 'GET',
                    inputPoints: endpoint.inputPoints,
                    ...(endpoint.contentType === undefined ? {} : { contentType: endpoint.contentType }),
                    diagnosticTracks: diagnosticTracksFor(endpoint.url, endpoint.method, endpoint.inputPoints, false, endpoint.contentType),
                });
            }
        }
        const allCandidates = [...mergedCandidates, ...apiSpecCandidates];
        this.context.latestCandidates = allCandidates;
        this.context.assessmentEndedAt = this.deps.clock.now().toISOString();
        return { runRecord, planHash, observations, deniedUrls, candidates: allCandidates, engineVersion: this.deps.explorer.engineVersion };
    }
    async verifyFindingExecution(operator: OperatorProfile, input: {
        readonly url: string;
        readonly role?: string;
        readonly findingId?: string;
    }): Promise<{
        executed: boolean;
        signals: readonly string[];
        evidenceRef: string;
    }> {
        requirePermission(operator, 'run.manage');
        const caseRecord = this.ports.currentCase();
        const decision = ScopePolicy.decide(caseRecord.scope, input.url);
        if (!decision.allowed) {
            throw domainError('OutOfScope', `payload execution verification target is out of scope: ${decision.reason}`);
        }
        let session: BrowserSessionState | undefined;
        if (input.role !== undefined) {
            const roleSession = this.vault.roleSessionCookies.get(input.role);
            if (roleSession === undefined) {
                throw domainError('ValidationFailed', `no session for role '${input.role}'; run login first`);
            }
            session = roleSession.browserState;
        }
        if (typeof this.deps.explorer.verifyPayloadExecution !== 'function') {
            throw domainError('CapabilityUnavailable', 'configured explorer does not support payload execution verification');
        }
        const startedAt = this.deps.clock.now().toISOString();
        const verification = await this.deps.explorer.verifyPayloadExecution(input.url, session);
        const evidence = await this.evidence.saveText(`payload-verification:${input.findingId ?? startedAt}`, canonicalJson({ url: input.url, role: input.role ?? null, findingId: input.findingId ?? null, executed: verification.executed, signals: verification.signals, verifiedAt: startedAt }), { kind: 'payload-verification' });
        return { executed: verification.executed, signals: verification.signals, evidenceRef: evidence.evidenceId };
    }
    adoptCandidates(operator: OperatorProfile, candidates: readonly ScanCandidate[]): readonly ScanCandidate[] {
        requirePermission(operator, 'run.manage');
        if (candidates.length === 0) {
            throw domainError('ValidationFailed', 'no candidates to adopt');
        }
        const unsafe = candidates.find((candidate) => isSessionControlUrl(candidate.url));
        if (unsafe !== undefined) {
            throw domainError('ValidationFailed', `session-control URL cannot be adopted for automatic scanning: ${unsafe.url}`);
        }
        this.events.publish({
            type: 'CandidatesAdopted',
            at: this.deps.clock.now().toISOString(),
            adoptedCount: candidates.length,
        });
        this.context.adoptedCandidateUrls = new Set(candidates.map((candidate) => ScopePolicy.canonicalUrl(candidate.url)));
        return candidates;
    }
    listObservations(): readonly PageObservation[] {
        return [...this.context.observationsByUrl.values()];
    }
    listDeniedUrls(): readonly {
        url: string;
        reason: string;
    }[] {
        return [...this.context.deniedUrlLog];
    }
}
