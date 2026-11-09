/**
 * ガイドラインカバレッジの契約型定義
 *
 * 設計正本: docs/design/41-spec-gap-resolution.md §3, §8
 *
 * - GuidelineCoverageRoute: 項目ID単位の版付きroute正本（§3.2）
 * - GuidelineItemExecution: 実行結果モデル（§3.3）
 * - GuidelineCoverageSummaryView, GuidelineCoverageItemView: 利用者表示用（§8.3）
 */

/**
 * ガイドラインカバレッジルート: 項目ID単位の版付きroute正本
 *
 * 1項目から複数route、1routeから複数項目へのmany-to-manyを許す。
 * 同じgeneric assertionを複数項目が共有する場合も、「共有している」ことを明示する。
 */
export interface GuidelineCoverageRoute {
  /** 版内で安定、一意なルートID */
  readonly routeId: string;

  /** カタログ識別情報 */
  readonly catalog: {
    readonly catalogId: string;
    readonly version: string;
    readonly sha256: string;
  };

  /** ガイドラインID（例: 'OWASP ASVS 5.0'） */
  readonly guidelineId: string;

  /** 項目ID（例: 'A01', 'V1.2.3'） */
  readonly itemId: string;

  /** ルート種別 */
  readonly routeKind:
    | 'workflow'
    | 'theme'
    | 'zap-rule'
    | 'nuclei-template'
    | 'browser'
    | 'manual-review'
    | 'unsupported';

  /**
   * assertion ID の配列
   * 判定ロジックの安定IDであり、関数名や行番号にしない
   */
  readonly assertionIds: readonly string[];

  /** 入力スキーマ参照 */
  readonly inputSchemaRefs: readonly string[];

  /** 対象セレクタID */
  readonly targetSelectorId: string;

  /** 証拠要件 */
  readonly evidenceRequirements: readonly string[];

  /** 保証等級 */
  readonly guarantee: 'Enforced' | 'Delegated' | 'Unsupported';

  /** 完了ポリシー: 全assertionか、いずれか、手動review */
  readonly completionPolicy: 'all' | 'any' | 'manual';

  /** 適用可能性ルールID */
  readonly applicabilityRuleId: string;

  /** 制約コード配列 */
  readonly limitationCodes: readonly string[];

  /** レビュー者 */
  readonly reviewedBy: string;

  /** レビュー日時 */
  readonly reviewedAt: string;
}

/**
 * ガイドライン項目の実行結果
 *
 * 単一のstatusに実行状態と診断結果を混在させない。
 * executionStatus（実行の状態）とassessment（判定）を分離する。
 */
export interface GuidelineItemExecution {
  /** run ID */
  readonly runId: string;

  /** 項目ID */
  readonly itemId: string;

  /** route ID */
  readonly routeId: string;

  /**
   * 実行状態
   * - not-planned: 計画対象外
   * - needs-input: 追加入力待ち（条件未充足）
   * - unavailable: 実行不可（能力不足）
   * - queued: 実行待ち
   * - running: 実行中
   * - completed: 完了
   * - prohibited: 禁止された
   * - stopped: 停止された
   * - failed: 失敗
   */
  readonly executionStatus:
    | 'not-planned'
    | 'needs-input'
    | 'unavailable'
    | 'queued'
    | 'running'
    | 'completed'
    | 'prohibited'
    | 'stopped'
    | 'failed';

  /**
   * 判定結果（実行状態とは別の軸）
   * - pass: 検査に合格
   * - fail: 問題を検出
   * - inconclusive: 判定保留（部分完了、エラー等）
   * - not-applicable: 対象外
   * - not-assessed: 未評価
   */
  readonly assessment: 'pass' | 'fail' | 'inconclusive' | 'not-applicable' | 'not-assessed';

  /** 保証等級 */
  readonly guarantee: 'Enforced' | 'Delegated' | 'Unsupported';

  /** 証拠参照配列 */
  readonly evidenceRefs: readonly string[];

  /** 不足している入力のコード配列 */
  readonly missingInputCodes: readonly string[];

  /** 制約コード配列 */
  readonly limitationCodes: readonly string[];
}

/**
 * ガイドラインカバレッジのサマリービュー
 *
 * Simple/Advanced/report/CLIが共有する表示用モデル。
 * 選択項目数と、自動実行予定/条件付き自動/追加入力待ち/実行不可/対象外の件数を表示。
 */
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
