/**
 * 能動診断の monitor。`docs/detailed-design/f11-active-scan.md` §4 (ScanMonitor)。
 * progress・alert cursor を poll し、停止要求を冪等に送る (F11-UT-005)。
 * adapter の stop は 1 回だけ呼ぶ。個々の送信は制御しない (Delegated)。
 */
import type { EngineAlert } from '@scopepilot2/contracts';
import type { ActiveScanEnginePort } from '../ports/engines.ts';

export interface ScanMonitorResult {
  readonly status: 'complete' | 'failed' | 'stopped';
  readonly failureReason?: string;
  readonly alerts: readonly EngineAlert[];
  readonly iterations: number;
  readonly progress: number;
}

export class ScanMonitor {
  private stopRequested = false;
  private readonly engine: ActiveScanEnginePort;
  private readonly engineRunId: string;
  private readonly maxIterations: number;
  private readonly pollIntervalMs: number;
  /** 完了後も alert が遅れて現れる engine 向けの落ち着き待ち (実 ZAP の pscan 遅延)。 */
  private readonly alertSettleMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly onProgress: ((progress: import('@scopepilot2/contracts').EngineProgress) => void) | undefined;

  constructor(
    engine: ActiveScanEnginePort,
    engineRunId: string,
    maxIterations = 1000,
    pollIntervalMs = 2_000,
    alertSettleMs = 0,
    signal?: AbortSignal,
    onProgress?: (progress: import('@scopepilot2/contracts').EngineProgress) => void,
  ) {
    this.engine = engine;
    this.engineRunId = engineRunId;
    this.maxIterations = maxIterations;
    this.pollIntervalMs = pollIntervalMs;
    this.alertSettleMs = alertSettleMs;
    this.signal = signal;
    this.onProgress = onProgress;
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
    let lastProgress = 0;

    while (iterations < this.maxIterations) {
      if (this.signal?.aborted === true) {
        await this.requestStop();
        return { status: 'stopped', alerts, iterations, progress: lastProgress };
      }
      iterations += 1;
      const batch = await this.engine.alerts(this.engineRunId, cursor);
      cursor = batch.nextCursor;
      alerts.push(...batch.alerts);
      const progress = await this.engine.progress(this.engineRunId);
      lastProgress = progress.progress;
      this.onProgress?.(progress);
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
        if (!this.signal?.aborted) {
          await new Promise<void>((resolve) => {
            const onAbort = (): void => {
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(() => {
              this.signal?.removeEventListener('abort', onAbort);
              resolve();
            }, this.pollIntervalMs);
            this.signal?.addEventListener('abort', onAbort, { once: true });
          });
        }
      }
    }
    if (status === 'running') {
      status = 'failed';
      failureReason = failureReason ?? 'scan monitor reached the poll iteration limit';
    }
    // 実 engine では完了直後の alert 生成が非同期に遅れることがある (ZAP の passive
    // scan)。落ち着き待ちを指定された場合、完了後も alert 追加分を短く poll する。
    if (this.alertSettleMs > 0) {
      const settleDeadline = Date.now() + this.alertSettleMs;
      let quiet = 0;
      while (Date.now() < settleDeadline && quiet < 2) {
        await new Promise((resolve) => {
          setTimeout(resolve, 500);
        });
        const late = await this.engine.alerts(this.engineRunId, cursor);
        cursor = late.nextCursor;
        alerts.push(...late.alerts);
        quiet = late.alerts.length === 0 ? quiet + 1 : 0;
      }
    }
    return {
      status: status === 'failed' ? 'failed' : 'complete',
      ...(failureReason === undefined ? {} : { failureReason }),
      alerts,
      iterations,
      progress: lastProgress,
    };
  }
}
