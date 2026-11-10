/**
 * アクティビティパネルの型定義。
 * docs/design/40-advanced-mode-redesign.md §5.4 に基づく。
 *
 * P0 JobRegistry が未マージのため、既存の events と ActiveScanExecutionEvent を使う。
 * P0 マージ後は JobEvent・JobSummary に移行する。
 */

/** アクティビティパネルで表示するイベントカテゴリ */
export type ActivityEventCategory =
  | 'lifecycle'      // 状態遷移（開始・停止・完了）
  | 'request'        // 送信
  | 'egress-denied'  // scope 拒否
  | 'warning'        // 警告
  | 'error'          // エラー
  | 'other';         // その他

/** アクティビティパネルで表示するイベント (暫定版・既存 events ベース) */
export interface ActivityEvent {
  readonly seq: number;
  readonly at: string;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly category: ActivityEventCategory;
  readonly source: 'scopepilot' | 'zap' | 'nuclei' | 'playwright' | 'system';
  readonly message: string;
  readonly url?: string;
  readonly runId?: string;
  readonly jobId?: string;  // TODO: P0 マージ後に追加
  readonly evidenceId?: string;
  readonly findingId?: string;
}

/** アクティビティパネルのフィルタ設定 */
export interface ActivityFilter {
  readonly scope: 'this-job' | 'all-jobs';
  readonly category?: ActivityEventCategory;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly source?: 'scopepilot' | 'zap' | 'nuclei' | 'playwright' | 'system';
  readonly search?: string;
  readonly jobId?: string;
  readonly runId?: string;
}

/** アクティビティパネルのジョブ要約 (暫定版・既存 RunRecord ベース) */
export interface ActivityJobSummary {
  readonly jobId: string;  // TODO: P0 では runId を使用
  readonly kind: string;
  readonly label: string;
  readonly state: 'running' | 'stopping' | 'completed' | 'stopped' | 'failed';
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly counters: {
    readonly requestsSent: number;
    readonly deniedByScope: number;
    readonly errors: number;
    readonly warnings: number;
    readonly findings?: number;
  };
}

/** アクティビティパネルのタブ */
export type ActivityTab = 'jobs' | 'log' | 'sent' | 'rejected' | 'error';
