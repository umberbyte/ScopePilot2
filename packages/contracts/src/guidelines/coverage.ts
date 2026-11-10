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

export interface GuidelineCoverageSummaryView {
  /** 繧ｬ繧､繝峨Λ繧､繝ｳID */
  readonly guidelineId: string;

  /** 繧ｬ繧､繝峨Λ繧､繝ｳ陦ｨ遉ｺ蜷・*/
  readonly guidelineDisplayName: string;

  /** 邱城・岼謨ｰ */
  readonly totalItems: number;

  /**
   * 閾ｪ蜍募ｮ溯｡御ｺ亥ｮ壹・鬆・岼謨ｰ
   * automatic 繧ｯ繝ｩ繧ｹ: 謗｡逕ｨ貂医∩蟇ｾ雎｡縺ｨ譌｢螳壹・螳牙・縺ｪprobe縺縺代〒螳溯｡悟庄閭ｽ
   */
  readonly automaticCount: number;

  /**
   * 譚｡莉ｶ莉倥″閾ｪ蜍輔・鬆・岼謨ｰ
   * conditional-automatic 繧ｯ繝ｩ繧ｹ: 譌｢蟄倥・譯井ｻｶ雉・肇縺九ｉ蠢・ｦ∝・蜉帙ｒ荳諢上↓隗｣豎ｺ縺ｧ縺阪ｋ蝣ｴ蜷医□縺題・蜍募ｮ溯｡悟庄閭ｽ
   */
  readonly conditionalAutomaticCount: number;

  /**
   * 霑ｽ蜉蜈･蜉帛ｾ・■縺ｮ鬆・岼謨ｰ
   * operator-workflow 繧ｯ繝ｩ繧ｹ: 迥ｶ諷句､画峩縲∵ｯ碑ｼ・ｸｻ菴薙∝ｾｩ蜈・∝ｯｾ雎｡蝗ｺ譛頴racle縲∝ｯｩ譟ｻ貂医∩payload縺悟ｿ・ｦ・   */
  readonly needsInputCount: number;

  /**
   * 螳溯｡御ｸ榊庄縺ｮ鬆・岼謨ｰ
   * external-fixture 縺ｾ縺溘・ unsupported 繧ｯ繝ｩ繧ｹ: 險ｱ蜿ｯ貂医∩螟夜Κ險ｭ蛯吶′蠢・ｦ√√∪縺溘・迴ｾ蝨ｨ縺ｮ陬ｽ蜩∝｢・阜縺ｧ縺ｯ謌千ｫ句愛螳壹〒縺阪↑縺・   */
  readonly unavailableCount: number;

  /**
   * 蟇ｾ雎｡螟悶・鬆・岼謨ｰ
   * not-applicable: HTTP隕ｳ貂ｬ蟇ｾ雎｡螟悶∵焔蜍瓶eview縺ｮ縺ｿ縲∫ｭ・   */
  readonly notApplicableCount: number;

  /** 繧ｫ繧ｿ繝ｭ繧ｰ諠・ｱ */
  readonly catalog: {
    readonly catalogId: string;
    readonly version: string;
    readonly sha256: string;
  };
}

/**
 * 繧ｬ繧､繝峨Λ繧､繝ｳ鬆・岼縺ｮ隧ｳ邏ｰ繝薙Η繝ｼ
 *
 * 蜷・・岼縺ｮroute縲∽ｿ晁ｨｼ遲臥ｴ壹∝ｿ・ｦ∝・蜉帙∽ｺ亥ｮ夐壻ｿ｡謨ｰ縲∫憾諷句､画峩繝ｻ蠕ｩ蜈・・譛臥┌繧定｡ｨ遉ｺ縲・ * 螳溯｡悟ｾ後・縲悟ｮ溯｡檎憾諷九阪→縲悟愛螳壹阪ｒ蛻･蛻励↓縺励√悟ｮ御ｺ・・蛻､螳壻ｿ晉蕗縲阪梧悴螳溯｡後・蜈･蜉帛ｾ・■縲咲ｭ峨ｒ譏手ｨ倥・ */
export interface GuidelineCoverageItemView {
  /** 鬆・岼ID */
  readonly itemId: string;

  /** 鬆・岼陦ｨ遉ｺ蜷・*/
  readonly itemDisplayName: string;

  /** 繝√ぉ繝・け鬆・岼縺ｮ隱ｬ譏・*/
  readonly checkItem: string;

  /** 隕∽ｻｶ */
  readonly requirement: string;

  /** route諠・ｱ驟榊・・・鬆・岼縺瑚､・焚route繧呈戟縺｡縺・ｋ・・*/
  readonly routes: readonly {
    readonly routeId: string;
    readonly routeKind: GuidelineCoverageRoute['routeKind'];
    readonly guarantee: 'Enforced' | 'Delegated' | 'Unsupported';
    readonly automationClass: 'automatic' | 'conditional-automatic' | 'operator-workflow' | 'external-fixture' | 'unsupported';
    readonly estimatedRequests: number;
    readonly hasStateChange: boolean;
    readonly requiresRestoration: boolean;
    readonly missingInputs: readonly { code: string; description: string }[];
    readonly limitations: readonly { code: string; description: string }[];
  }[];

  /** 螳溯｡檎ｵ先棡・亥ｮ溯｡悟ｾ後・縺ｿ・・*/
  readonly execution?: {
    readonly executionStatus: GuidelineItemExecution['executionStatus'];
    readonly assessment: GuidelineItemExecution['assessment'];
    readonly completedRouteCount: number;
    readonly totalRouteCount: number;
    readonly evidenceCount: number;
    readonly findingCount: number;
  };
}

/**
 * 繧ｬ繧､繝峨Λ繧､繝ｳ繧ｫ繝舌Ξ繝・ず蠢懃ｭ・ *
 * GET /api/guidelines/coverage 縺ｮ蠢懃ｭ泌梛
 */
export interface GuidelineCoverageResponse {
  /** 繧ｵ繝槭Μ繝ｼ */
  readonly summary: GuidelineCoverageSummaryView;

  /** 鬆・岼隧ｳ邏ｰ驟榊・ */
  readonly items: readonly GuidelineCoverageItemView[];
}

/**
 * run蛻･繧ｬ繧､繝峨Λ繧､繝ｳ繧ｫ繝舌Ξ繝・ず蠢懃ｭ・ *
 * GET /api/runs/{runId}/guideline-coverage 縺ｮ蠢懃ｭ泌梛
 */
export interface RunGuidelineCoverageResponse {
  /** run ID */
  readonly runId: string;

  /** 繧ｬ繧､繝峨Λ繧､繝ｳID */
  readonly guidelineId: string;

  /** 繧ｵ繝槭Μ繝ｼ・亥ｮ溯｡檎ｵ先棡繧貞渚譏・・*/
  readonly summary: GuidelineCoverageSummaryView & {
    readonly completedCount: number;
    readonly passCount: number;
    readonly failCount: number;
    readonly inconclusiveCount: number;
  };

  /** 鬆・岼隧ｳ邏ｰ驟榊・・亥ｮ溯｡檎ｵ先棡莉倥″・・*/
  readonly items: readonly GuidelineCoverageItemView[];
}
