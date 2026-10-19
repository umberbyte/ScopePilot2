/** 能動診断の engine 入出力。`docs/design/10-active-scan.md`、`docs/detailed-design/f11-active-scan.md`。 */
import type { PlanLimits } from '../plan/plan.ts';

export const ScanAttackStrengths = ['Low', 'Medium', 'High'] as const;

export type ScanAttackStrength = (typeof ScanAttackStrengths)[number];

/** ScopePilot から外部 engine へ渡す入力 (Delegated)。個々の送信は傍受・拒否しない。 */
export interface ActiveScanRequest {
  readonly runId: string;
  readonly targets: readonly string[];
  readonly attackStrength: ScanAttackStrength;
  readonly leasedLimits: PlanLimits;
  readonly authorizationRef: string;
  /**
   * role session 適用時の cookie 名 (design/08: F11 は Cookie 適用対象)。名前のみ —
   * 値は要求に入れない (API 応答に scanRequest が映るため)。実 ZAP は proxy 経由
   * login で jar へ session を作る既存経路を使い、ここは trace と検証に使う。
   */
  readonly sessionCookieNames?: readonly string[];
}

/** ZAP 形式の alert 要約。取込時に重複除外し、実影響は未確認として扱う。 */
export interface EngineAlert {
  readonly engineAlertId: string;
  readonly pluginId: string;
  readonly name: string;
  readonly risk: 'Informational' | 'Low' | 'Medium' | 'High';
  readonly url: string;
  readonly method: string;
  readonly param?: string;
  readonly evidenceSummary: string;
}

export interface EngineProgress {
  readonly status: 'running' | 'complete' | 'failed';
  /** 0..100。 */
  readonly progress: number;
  readonly lastActivityAt: string;
  readonly messageCount: number;
  /** status が failed の場合の観測可能な失敗理由 (engine の出力から推測したもの)。 */
  readonly failureReason?: string;
}
