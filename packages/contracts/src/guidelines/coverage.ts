/** Item-level coverage authority. Design 41 sections 1.2 and 3. */
import type { GuaranteeLevel } from '../plan/plan.ts';
import type { EngineCapabilitySnapshot } from '../engines/capability.ts';

export interface GuidelineCatalogIdentity {
  readonly catalogId: string;
  readonly version: string;
  readonly sha256: string;
}
export interface GuidelineCoverageRoute {
  readonly routeId: string;
  readonly catalog: GuidelineCatalogIdentity;
  readonly guidelineId: string;
  readonly itemId: string;
  readonly routeKind: 'workflow' | 'theme' | 'zap-rule' | 'nuclei-template' | 'browser' | 'manual-review' | 'unsupported';
  readonly assertionIds: readonly string[];
  readonly inputSchemaRefs: readonly string[];
  readonly targetSelectorId: string;
  readonly evidenceRequirements: readonly string[];
  readonly guarantee: GuaranteeLevel;
  readonly completionPolicy: 'all' | 'any' | 'manual';
  readonly applicabilityRuleId: string;
  readonly limitationCodes: readonly string[];
  readonly reviewedBy: string;
  readonly reviewedAt: string;
}
export interface GuidelineRouteSnapshot {
  readonly catalog: GuidelineCatalogIdentity;
  readonly guidelineId: string;
  readonly itemId: string;
  readonly routeId: string;
  readonly assertionIds: readonly string[];
  readonly evidenceRequirements: readonly string[];
  readonly guarantee: GuaranteeLevel;
  readonly completionPolicy: GuidelineCoverageRoute['completionPolicy'];
  readonly routeHash: string;
  readonly label: string;
  readonly limitationCodes: readonly string[];
}
export const GuidelineExecutionStatuses = ['not-planned', 'needs-input', 'unavailable', 'queued', 'running', 'completed', 'prohibited', 'stopped', 'failed'] as const;
export const GuidelineAssessments = ['pass', 'fail', 'inconclusive', 'not-applicable', 'not-assessed'] as const;
export interface GuidelineItemExecution {
  readonly runId: string;
  readonly itemId: string;
  readonly routeId: string;
  readonly executionStatus: typeof GuidelineExecutionStatuses[number];
  readonly assessment: typeof GuidelineAssessments[number];
  readonly guarantee: GuaranteeLevel;
  readonly evidenceRefs: readonly string[];
  readonly missingInputCodes: readonly string[];
  readonly limitationCodes: readonly string[];
}
export interface GuidelineRunCoverage {
  readonly runId: string;
  readonly snapshots: readonly GuidelineRouteSnapshot[];
  readonly executions: readonly GuidelineItemExecution[];
  readonly items: readonly {
    readonly guidelineId: string;
    readonly itemId: string;
    readonly assessment: GuidelineItemExecution['assessment'];
  }[];
}
export interface GuidelineCoverageForecast {
  readonly guidelineId: string;
  readonly items: readonly {
    readonly itemId: string;
    readonly routes: readonly GuidelineRouteSnapshot[];
    readonly executionStatus: GuidelineItemExecution['executionStatus'];
    readonly missingInputCodes: readonly string[];
  }[];
}
/** All four inputs are included in the execution plan hash. No secret values. */
export interface GuidelineCoveragePlan {
  readonly selectedItems: readonly { readonly guidelineId: string; readonly itemId: string }[];
  readonly snapshots: readonly GuidelineRouteSnapshot[];
  readonly inputResolution: readonly { readonly routeId: string; readonly resolvedInputRefs: readonly string[]; readonly missingInputCodes: readonly string[] }[];
  readonly capabilities: readonly EngineCapabilitySnapshot[];
}
