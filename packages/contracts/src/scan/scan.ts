/** 能動診断の engine 入出力。`docs/design/10-active-scan.md`、`docs/detailed-design/f11-active-scan.md`。 */
import type { PlanLimits } from '../plan/plan.ts';

export type ScanAttackStrength = 'Low' | 'Medium' | 'High';

/** ScopePilot から外部 engine へ渡す入力 (Delegated)。個々の送信は傍受・拒否しない。 */
export interface ActiveScanRequest {
  readonly runId: string;
  readonly targets: readonly string[];
  readonly attackStrength: ScanAttackStrength;
  readonly leasedLimits: PlanLimits;
  readonly authorizationRef: string;
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
