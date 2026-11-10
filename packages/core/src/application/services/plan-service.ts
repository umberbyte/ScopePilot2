import { domainError, hashStable, type AuthorizationRecord, type CaseRecord, type ExecutionPlan, type OperatorProfile, type PlanConfirmation, type PlanLimits, type ScopeLimits } from '@scopepilot2/contracts';
import { ScopePolicy } from '../../domain/scope-policy.ts';
import { mergeDocumentHintSeeds } from '../../domain/exploration.ts';
import { buildPlan, confirmationMatches, DEFAULT_ACTIVE_SCAN_LIMITS, DEFAULT_EXPLORE_LIMITS, firstPlanIssueAsError, planHashOf, validatePlan } from '../../domain/plan-service.ts';
import { WORKFLOW_SCAN_DEFAULT_MAX_REQUESTS, WORKFLOW_SCAN_PAYLOAD_SET } from '../../domain/workflow-scan.ts';
import type { BaselineFlowDeps } from '../baseline-contracts.ts';
import type { CaseSessionContext } from './case-session-context.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import { requirePermission } from './authorization-policy.ts';
const PLAN_SAFETY_CEILING = { maxConcurrency: 2, requestsPerSecond: 2 } as const;
export interface PlanWorkspacePort {
    currentCase(): CaseRecord;
    currentAuthorization(): AuthorizationRecord;
    registerConfirmation(confirmation: {
        confirmationId: string;
        planHash: string;
    }): void;
    isConfirmationInvalidated(id: string): boolean;
    invalidationReason(id: string): string | undefined;
}
export class PlanService {
    private readonly deps: Pick<BaselineFlowDeps, 'clock' | 'ids' | 'runtimeBundleHash' | 'capabilities' | 'scanEngine' | 'nucleiRunner' | 'workflowScanTransportFactory'>;
    private readonly context: CaseSessionContext;
    private readonly ports: PlanWorkspacePort;
    private readonly events: EventPublisherPort;
    constructor(deps: PlanService['deps'], context: CaseSessionContext, ports: PlanWorkspacePort, events: EventPublisherPort) {
        this.deps = deps;
        this.context = context;
        this.ports = ports;
        this.events = events;
    }
    buildExplorationPlan(operator: OperatorProfile, seeds: readonly string[], limitsRequest?: {
        readonly maxRequests: number;
        readonly maxPages: number;
        readonly maxDurationMinutes: number;
    }): {
        plan: ExecutionPlan;
        planHash: string;
    } {
        requirePermission(operator, 'run.manage');
        const caseRecord = this.ports.currentCase();
        const authorization = this.ports.currentAuthorization();
        if (seeds.length === 0) {
            throw domainError('ValidationFailed', 'exploration needs at least one seed URL');
        }
        if (limitsRequest !== undefined) {
            // UI からの上限指定は案件上限へクランプされる (Advanced モードの上限編集・design/02 §3)。
            this.requirePositiveLimits(limitsRequest, 'plan.explore');
        }
        const limits = this.planLimits({ ...DEFAULT_EXPLORE_LIMITS, ...limitsRequest }, caseRecord.scope.limits);
        // document hint は許可 Origin 内の URL だけ追加開始点へ統合する (AGENTS.md)。
        // 計画の target snapshot に含まれるため、hint 由来の送信も確認画面の対象になる。
        const merged = mergeDocumentHintSeeds(seeds, this.context.documentHintDocuments.flatMap((document) => document.urls), caseRecord.scope);
        const inputEvidenceHash = hashStable('scopepilot2.plan.input', merged.targets.map((url) => ScopePolicy.canonicalUrl(url)).sort());
        const planId = this.deps.ids.next('plan');
        const plan = buildPlan({
            planId,
            caseId: caseRecord.caseId,
            authorizationId: authorization.authorizationId,
            operatorId: operator.operatorId,
            targetRole: authorization.targetRoles[0] ?? 'unauthenticated',
            steps: [
                {
                    kind: 'explore',
                    operationClass: 'Browse',
                    targets: merged.targets,
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
        this.context.explorationHintSeeds.set(planId, new Set(merged.hintTargets));
        return { plan, planHash: planHashOf(plan) };
    }
    buildActiveScanPlan(operator: OperatorProfile, targets: readonly string[], limitsRequest?: {
        readonly maxRequests: number;
        readonly maxPages: number;
        readonly maxDurationMinutes: number;
    }, options: {
        readonly includeNuclei?: boolean;
        readonly includeWorkflowScan?: boolean;
        readonly guidelines?: readonly string[];
    } = {}): {
        plan: ExecutionPlan;
        planHash: string;
    } {
        requirePermission(operator, 'run.manage');
        const caseRecord = this.ports.currentCase();
        const authorization = this.ports.currentAuthorization();
        if (targets.length === 0) {
            throw domainError('ValidationFailed', 'active scan needs at least one adopted target');
        }
        if (limitsRequest !== undefined) {
            this.requirePositiveLimits(limitsRequest, 'plan.scan');
        }
        const limits = this.planLimits({ ...DEFAULT_ACTIVE_SCAN_LIMITS, ...limitsRequest }, caseRecord.scope.limits);
        const inputEvidenceHash = hashStable('scopepilot2.plan.input', targets.map((url) => ScopePolicy.canonicalUrl(url)).sort());
        const includeNuclei = options.includeNuclei === true;
        const includeWorkflowScan = options.includeWorkflowScan === true;
        if (includeNuclei && this.deps.nucleiRunner === undefined) {
            throw domainError('CapabilityUnavailable', 'Nuclei requires both a configured binary and a reviewed HTTP template manifest');
        }
        if (includeWorkflowScan && this.deps.workflowScanTransportFactory === undefined) {
            throw domainError('CapabilityUnavailable', 'workflow scan transport is not configured');
        }
        const enabledStepCount = 1 + (includeNuclei ? 1 : 0) + (includeWorkflowScan ? 1 : 0);
        if (limits.maxRequests < enabledStepCount) {
            throw domainError('ValidationFailed', `plan needs at least ${String(enabledStepCount)} requests for the selected diagnostic steps`);
        }
        const workflowMaxRequests = includeWorkflowScan
            ? Math.min(WORKFLOW_SCAN_DEFAULT_MAX_REQUESTS, Math.floor(limits.maxRequests / enabledStepCount))
            : 0;
        const remainingRequests = limits.maxRequests - workflowMaxRequests;
        const nucleiMaxRequests = includeNuclei ? Math.floor(remainingRequests / 2) : 0;
        const zapMaxRequests = remainingRequests - nucleiMaxRequests;
        const withRequestLimit = (maxRequests: number): PlanLimits => ({ ...limits, maxRequests });
        const workflowTargets = [...new Set(targets.map((url) => ScopePolicy.canonicalUrl(url)))];
        const plan = buildPlan({
            planId: this.deps.ids.next('plan'),
            caseId: caseRecord.caseId,
            authorizationId: authorization.authorizationId,
            operatorId: operator.operatorId,
            targetRole: authorization.targetRoles[0] ?? 'unauthenticated',
            guidelineIds: options.guidelines ?? [],
            steps: [
                {
                    kind: 'active-scan',
                    operationClass: 'ActiveScan',
                    targets,
                    engineKind: 'zap',
                    guarantee: 'Delegated',
                    engineVersion: this.deps.scanEngine.engineVersion,
                    limits: withRequestLimit(zapMaxRequests),
                },
                ...(!includeWorkflowScan ? [] : [{
                        kind: 'workflow-scan' as const,
                        operationClass: 'ActiveScan' as const,
                        targets: workflowTargets,
                        engineKind: 'node-http' as const,
                        guarantee: 'Enforced' as const,
                        engineVersion: WORKFLOW_SCAN_PAYLOAD_SET,
                        limits: withRequestLimit(workflowMaxRequests),
                    }]),
                ...(!includeNuclei || this.deps.nucleiRunner === undefined ? [] : [{
                        kind: 'nuclei-scan' as const,
                        operationClass: 'NucleiScan' as const,
                        targets,
                        engineKind: 'nuclei' as const,
                        guarantee: 'Delegated' as const,
                        engineVersion: this.deps.nucleiRunner.engineVersion,
                        limits: withRequestLimit(nucleiMaxRequests),
                    }]),
            ],
            limits,
            runtimeBundleHash: this.deps.runtimeBundleHash,
            inputEvidenceHash,
            createdAt: this.deps.clock.now().toISOString(),
        });
        return { plan, planHash: planHashOf(plan) };
    }
    authorizePlan(plan: ExecutionPlan): {
        planHash: string;
    } {
        const caseRecord = this.ports.currentCase();
        const authorization = this.ports.currentAuthorization();
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
        this.events.publish({ type: 'PlanValidated', at: this.deps.clock.now().toISOString(), planHash });
        this.events.publish({
            type: 'PlanAuthorized',
            at: this.deps.clock.now().toISOString(),
            planHash,
            authorizationId: authorization.authorizationId,
        });
        return { planHash };
    }
    confirmPlan(plan: ExecutionPlan, operator: OperatorProfile): PlanConfirmation {
        requirePermission(operator, 'run.manage');
        const aggregate = this.ports;
        const confirmation: PlanConfirmation = {
            confirmationId: this.deps.ids.next('confirm'),
            planHash: planHashOf(plan),
            confirmedBy: operator.operatorId,
            confirmedAt: this.deps.clock.now().toISOString(),
            guidelineIds: plan.guidelineIds,
            confirmedView: plan.steps.map((step) => ({ kind: step.kind, targets: step.targetSnapshot, limits: step.limits })),
        };
        aggregate.registerConfirmation({ confirmationId: confirmation.confirmationId, planHash: confirmation.planHash });
        this.events.publish({
            type: 'PlanConfirmed',
            at: this.deps.clock.now().toISOString(),
            planHash: confirmation.planHash,
            confirmedBy: operator.operatorId,
        });
        return confirmation;
    }
    requireMatchingConfirmation(plan: ExecutionPlan, confirmation: PlanConfirmation): void {
        const aggregate = this.ports;
        if (aggregate.isConfirmationInvalidated(confirmation.confirmationId)) {
            throw domainError('ConfirmationRequired', `plan confirmation was invalidated: ${aggregate.invalidationReason(confirmation.confirmationId) ?? 'unknown reason'}`);
        }
        if (!confirmationMatches(plan, confirmation)) {
            throw domainError('ConfirmationRequired', 'plan confirmation does not match the current plan');
        }
    }
    private planLimits(requested: PlanLimits, caseLimits: ScopeLimits): PlanLimits {
        return {
            maxRequests: Math.min(requested.maxRequests, caseLimits.maxRequests),
            maxPages: Math.min(requested.maxPages, caseLimits.maxPages),
            maxDurationMinutes: Math.min(requested.maxDurationMinutes, caseLimits.maxDurationMinutes),
            // 並列度・rate は安全規定値を超えられない (案件上限に含まれないため既定で頭打ち)。
            maxConcurrency: Math.min(requested.maxConcurrency, PLAN_SAFETY_CEILING.maxConcurrency),
            requestsPerSecond: Math.min(requested.requestsPerSecond, PLAN_SAFETY_CEILING.requestsPerSecond),
        };
    }
    private requirePositiveLimits(limits: ScopeLimits, label: string): void {
        for (const [key, value] of Object.entries(limits)) {
            if (!Number.isInteger(value) || value <= 0) {
                throw domainError('ValidationFailed', `${label} limit ${key} must be a positive integer`);
            }
        }
    }
}
