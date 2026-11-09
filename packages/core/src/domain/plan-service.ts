/**
 * ExecutionPlan の作成・正規化・hash・検証。`docs/design/22-execution-control.md` 2章、
 * `docs/detailed-design/01-system-components.md` 5章 (PlanService)。
 * 同じ入力から安定した計画 hash を作る (A0 受け入れ条件)。
 */
import {
  hashStable,
  canonicalJson,
  domainError,
  type AuthorizationRecord,
  type CaseScope,
  type EngineCapabilitySnapshot,
  type ExecutionPlan,
  type PlanConfirmation,
  type PlanHashInput,
  type PlanLimits,
  type PlanStep,
  type PlanStepKind,
  type OperationClass,
} from '@scopepilot2/contracts';
import { ScopePolicy } from './scope-policy.ts';

const PLAN_HASH_NAMESPACE = 'scopepilot2.plan';

/** 探索の既定上限。`docs/detailed-design/f08-browser-exploration.md` 3章 (depth 5, page 500)。 */
export const DEFAULT_EXPLORE_LIMITS: PlanLimits = {
  maxRequests: 2000,
  maxPages: 500,
  maxDurationMinutes: 30,
  maxConcurrency: 2,
  requestsPerSecond: 2,
};

/** 能動診断の既定上限。`docs/detailed-design/f11-active-scan.md` 3章 (depth 5, 2 RPS, 30分, URL 5000)。 */
export const DEFAULT_ACTIVE_SCAN_LIMITS: PlanLimits = {
  maxRequests: 5000,
  maxPages: 500,
  maxDurationMinutes: 30,
  maxConcurrency: 2,
  requestsPerSecond: 2,
};

export function planHashOf(plan: ExecutionPlan): string {
  const input: PlanHashInput = {
    schemaVersion: 'scopepilot2.plan.v1',
    caseId: plan.caseId,
    authorizationId: plan.authorizationId,
    operatorId: plan.operatorId,
    targetRole: plan.targetRole,
    guidelineIds: plan.guidelineIds,
    steps: plan.steps.map((step) => ({
      ...(step.discoverySources === undefined ? {} : { discoverySources: step.discoverySources }),
      kind: step.kind,
      operationClass: step.operationClass,
      targetSnapshot: step.targetSnapshot,
      engineKind: step.engineKind,
      guarantee: step.guarantee,
      ...(step.engineVersion === undefined ? {} : { engineVersion: step.engineVersion }),
      limits: step.limits,
    })),
    limits: plan.limits,
    runtimeBundleHash: plan.runtimeBundleHash,
    inputEvidenceHash: plan.inputEvidenceHash,
  };
  return hashStable(PLAN_HASH_NAMESPACE, input);
}

export interface PlanValidationContext {
  readonly scope: CaseScope;
  readonly authorization: AuthorizationRecord;
  readonly now: Date;
  readonly capabilities: readonly EngineCapabilitySnapshot[];
}

/** 検証問題を列挙する。最初の問題を command 層で domain error へ変換する。 */
export function validatePlan(plan: ExecutionPlan, context: PlanValidationContext): readonly string[] {
  const issues: string[] = [];
  const now = context.now.toISOString();

  if (context.authorization.validFrom > now || now >= context.authorization.validUntil) {
    issues.push(`authorization ${context.authorization.authorizationId} is not valid at ${now}`);
  }
  if (context.authorization.caseId !== plan.caseId) {
    issues.push(`authorization belongs to case ${context.authorization.caseId}, plan to ${plan.caseId}`);
  }

  for (const step of plan.steps) {
    if (step.discoverySources?.length && (step.operationClass !== 'ActiveCrawl' || step.discoverySources.some((source) => !['robots', 'sitemap', 'manifest', 'wordlist'].includes(source)))) issues.push('discovery requires an ActiveCrawl step and known sources');
    if (!context.authorization.allowedOperationClasses.includes(step.operationClass)) {
      issues.push(`step ${step.stepId} requires operation class ${step.operationClass} which is not authorized`);
    }
    if (step.guarantee === 'Unsupported') {
      issues.push(`step ${step.stepId} is Unsupported and must not run`);
    }
    const snapshot = context.capabilities.find(
      (capability) => capability.engineKind === step.engineKind,
    );
    if (snapshot === undefined) {
      issues.push(`no capability snapshot for engine ${step.engineKind}`);
    } else if (snapshot.guaranteeLevels.preSendScopeEnforcement === 'Unsupported') {
      issues.push(`engine ${step.engineKind} cannot enforce or delegate scope; feature must stay unpublished`);
    }
    for (const target of step.targetSnapshot) {
      const decision = ScopePolicy.decide(context.scope, target);
      if (!decision.allowed) {
        issues.push(`target ${target} is out of scope: ${decision.reason}`);
      }
    }
  }

  if (plan.limits.maxRequests > context.scope.limits.maxRequests) {
    issues.push(`plan maxRequests ${plan.limits.maxRequests} exceeds case limit ${context.scope.limits.maxRequests}`);
  }
  if (plan.limits.maxPages > context.scope.limits.maxPages) {
    issues.push(`plan maxPages ${plan.limits.maxPages} exceeds case limit ${context.scope.limits.maxPages}`);
  }
  if (plan.limits.maxDurationMinutes > context.scope.limits.maxDurationMinutes) {
    issues.push(`plan maxDurationMinutes ${plan.limits.maxDurationMinutes} exceeds case limit ${context.scope.limits.maxDurationMinutes}`);
  }
  return issues;
}

export function firstPlanIssueAsError(issues: readonly string[]) {
  const first = issues[0];
  if (first === undefined) {
    return null;
  }
  if (first.includes('out of scope')) {
    return domainError('OutOfScope', first, { details: { issues } });
  }
  if (first.includes('not authorized') || first.includes('authorization ')) {
    return domainError('PermissionDenied', first, { details: { issues } });
  }
  if (first.includes('capability') || first.includes('Unsupported') || first.includes('capability snapshot')) {
    return domainError('CapabilityUnavailable', first, { details: { issues } });
  }
  return domainError('ValidationFailed', first, { details: { issues } });
}

export interface BuildPlanInput {
  readonly planId: string;
  readonly caseId: string;
  readonly authorizationId: string;
  readonly operatorId: string;
  readonly targetRole: string;
  readonly guidelineIds?: readonly string[];
  readonly steps: readonly {
    readonly discoverySources?: PlanStep['discoverySources'];
    readonly kind: PlanStepKind;
    readonly operationClass: OperationClass;
    readonly targets: readonly string[];
    readonly engineKind: PlanStep['engineKind'];
    readonly guarantee: PlanStep['guarantee'];
    readonly engineVersion?: string;
    readonly limits: PlanLimits;
  }[];
  readonly limits: PlanLimits;
  readonly runtimeBundleHash: string;
  readonly inputEvidenceHash: string;
  readonly createdAt: string;
}

/** step を構成順に、target snapshot を canonical URL の辞書順へ正規化する。 */
export function buildPlan(input: BuildPlanInput): ExecutionPlan {
  const steps: PlanStep[] = input.steps.map((step, index) => ({
    stepId: `${input.planId}-s${index + 1}`,
    ...(step.discoverySources === undefined ? {} : { discoverySources: [...new Set(step.discoverySources)].sort() }),
    kind: step.kind,
    operationClass: step.operationClass,
    targetSnapshot: [...new Set(step.targets.map((url) => ScopePolicy.canonicalUrl(url)))].sort(),
    engineKind: step.engineKind,
    guarantee: step.guarantee,
    ...(step.engineVersion === undefined ? {} : { engineVersion: step.engineVersion }),
    limits: step.limits,
  }));
  return {
    planId: input.planId,
    caseId: input.caseId,
    authorizationId: input.authorizationId,
    operatorId: input.operatorId,
    targetRole: input.targetRole,
    guidelineIds: [...new Set(input.guidelineIds ?? [])].sort(),
    steps,
    limits: input.limits,
    runtimeBundleHash: input.runtimeBundleHash,
    inputEvidenceHash: input.inputEvidenceHash,
    createdAt: input.createdAt,
  };
}

/** 確認画面に相当する内容の写し。hash と内容の両方で計画と突き合わせる。 */
export function confirmedViewOf(plan: ExecutionPlan): PlanConfirmation['confirmedView'] {
  return plan.steps.map((step) => ({ kind: step.kind, targets: step.targetSnapshot, limits: step.limits }));
}

export function confirmationMatches(plan: ExecutionPlan, confirmation: PlanConfirmation): boolean {
  return (
    confirmation.planHash === planHashOf(plan) &&
    canonicalJson(confirmation.guidelineIds) === canonicalJson(plan.guidelineIds) &&
    canonicalJson(confirmation.confirmedView) === canonicalJson(confirmedViewOf(plan))
  );
}
