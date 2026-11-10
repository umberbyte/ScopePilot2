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
  /** ガイドラインID */
  readonly guidelineId: string;

  /** ガイドライン表示名 */
  readonly guidelineDisplayName: string;

  /** 総項目数 */
  readonly totalItems: number;

  /**
   * 自動実行予定の項目数
   * automatic クラス: 採用済み対象と既定の安全なprobeだけで実行可能
   */
  readonly automaticCount: number;

  /**
   * 条件付き自動の項目数
   * conditional-automatic クラス: 既存の案件資産から必要入力を一意に解決できる場合だけ自動実行可能
   */
  readonly conditionalAutomaticCount: number;

  /**
   * 追加入力待ちの項目数
   * operator-workflow クラス: 状態変更、比較主体、復元、対象固有oracle、審査済みpayloadが必要
   */
  readonly needsInputCount: number;

  /**
   * 実行不可の項目数
   * external-fixture または unsupported クラス: 許可済み外部設備が必要、または現在の製品境界では成立判定できない
   */
  readonly unavailableCount: number;

  /**
   * 対象外の項目数
   * not-applicable: HTTP観測対象外、手動reviewのみ、等
   */
  readonly notApplicableCount: number;

  /** カタログ情報 */
  readonly catalog: {
    readonly catalogId: string;
    readonly version: string;
    readonly sha256: string;
  };
}

/**
 * ガイドライン項目の詳細ビュー
 *
 * 各項目のroute、保証等級、必要入力、予定通信数、状態変更・復元の有無を表示。
 * 実行後は「実行状態」と「判定」を別列にし、「完了・判定保留」「未実行・入力待ち」等を明記。
 */
export interface GuidelineCoverageItemView {
  /** 項目ID */
  readonly itemId: string;

  /** 項目表示名 */
  readonly itemDisplayName: string;

  /** チェック項目の説明 */
  readonly checkItem: string;

  /** 要件 */
  readonly requirement: string;

  /** route情報配列（1項目が複数routeを持ちうる） */
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

  /** 実行結果（実行後のみ） */
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
 * ガイドラインカバレッジ応答
 *
 * GET /api/guidelines/coverage の応答型
 */
export interface GuidelineCoverageResponse {
  /** サマリー */
  readonly summary: GuidelineCoverageSummaryView;

  /** 項目詳細配列 */
  readonly items: readonly GuidelineCoverageItemView[];
}

/**
 * run別ガイドラインカバレッジ応答
 *
 * GET /api/runs/{runId}/guideline-coverage の応答型
 */
export interface RunGuidelineCoverageResponse {
  /** run ID */
  readonly runId: string;

  /** ガイドラインID */
  readonly guidelineId: string;

  /** サマリー（実行結果を反映） */
  readonly summary: GuidelineCoverageSummaryView & {
    readonly completedCount: number;
    readonly passCount: number;
    readonly failCount: number;
    readonly inconclusiveCount: number;
  };

  /** 項目詳細配列（実行結果付き） */
  readonly items: readonly GuidelineCoverageItemView[];
}
