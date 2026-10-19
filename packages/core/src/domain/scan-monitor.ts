/**
 * 能動診断の monitor。`docs/detailed-design/f11-active-scan.md` §4 (ScanMonitor)。
 * progress・alert cursor を poll し、停止要求を冪等に送る (F11-UT-005)。
 * adapter の stop は 1 回だけ呼ぶ。個々の送信は制御しない (Delegated)。
 */
import type { EngineAlert } from '@scopepilot2/contracts';
import type { ActiveScanEnginePort } from '../ports/engines.ts';

export interface ScanMonitorResult {
  readonly status: 'complete' | 'failed';
  readonly failureReason?: string;
  readonly alerts: readonly EngineAlert[];
  readonly iterations: number;
}

export class ScanMonitor {
  private stopRequested = false;
  private readonly engine: ActiveScanEnginePort;
  private readonly engineRunId: string;
  private readonly maxIterations: number;
  private readonly pollIntervalMs: number;

  constructor(engine: ActiveScanEnginePort, engineRunId: string, maxIterations = 1000, pollIntervalMs = 2_000) {
    this.engine = engine;
    this.engineRunId = engineRunId;
    this.maxIterations = maxIterations;
    this.pollIntervalMs = pollIntervalMs;
  }

  /** 停止要求は冪等。engine.stop を呼ぶのは初回だけ。 */
  async requestStop(): Promise<void> {
    if (this.stopRequested) {
      return;
    }
    this.stopRequested = true;
    await this.engine.stop(this.engineRunId);
  }

  isStopRequested(): boolean {
    return this.stopRequested;
  }

  /** 完了・失敗・上限到達まで poll し、観測した alert を返す。 */
  async collectUntilDone(): Promise<ScanMonitorResult> {
    const alerts: EngineAlert[] = [];
    let cursor = 0;
    let status: 'running' | 'complete' | 'failed' = 'running';
    let failureReason: string | undefined;
    let iterations = 0;

    while (iterations < this.maxIterations) {
      iterations += 1;
      const batch = await this.engine.alerts(this.engineRunId, cursor);
      cursor = batch.nextCursor;
      alerts.push(...batch.alerts);
      const progress = await this.engine.progress(this.engineRunId);
      status = progress.status;
      if (progress.status === 'failed' && progress.failureReason !== undefined) {
        failureReason = progress.failureReason;
      }
      if (progress.status !== 'running') {
        break;
      }
      // 実 engine (Delegated) は完了まで分単位でかかる: poll 間隔を空けて
      // API を叩き続けない (stub は即座に完了するので sleep しない)。
      if (this.pollIntervalMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, this.pollIntervalMs);
        });
      }
    }
    if (status === 'running') {
      status = 'failed';
      failureReason = failureReason ?? 'scan monitor reached the poll iteration limit';
    }
    return {
      status: status === 'failed' ? 'failed' : 'complete',
      ...(failureReason === undefined ? {} : { failureReason }),
      alerts,
      iterations,
    };
  }
}
