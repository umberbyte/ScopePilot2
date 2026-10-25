/**
 * ActiveScanEnginePort の固定 fixture adapter (ZAP 相当、Delegated)。
 * 与えられた入力 (targets・lease) と観測出力を記録し、旧版から継承した
 * 「取込 context に存在しない URL は `URL Does not Exist` で失敗する」挙動を再現する。
 * 個々の送信はシミュレートしない (Delegated の前提)。
 */
import type { ActiveScanRequest, EngineAlert, EngineProgress } from '@scopepilot2/contracts';
import type { ActiveScanEnginePort } from '@scopepilot2/core';
import { FIXTURE_SITE_PAGES } from '../fixtures/target-site.ts';
import { FIXTURE_ZAP_ALERT_BATCHES, FIXTURE_ZAP_VERSION, zapAlertsFixtureHash } from '../fixtures/zap-alerts.ts';

interface FixtureRun {
  readonly request: ActiveScanRequest;
  status: 'running' | 'complete' | 'failed';
  progress: number;
  polls: number;
  failureReason?: string;
  stopRequests: number;
}

export class FixtureZapEngine implements ActiveScanEnginePort {
  readonly engineVersion = FIXTURE_ZAP_VERSION;
  private readonly runs = new Map<string, FixtureRun>();
  private sequence = 0;

  async start(request: ActiveScanRequest): Promise<string> {
    this.sequence += 1;
    const engineRunId = `zaprun-${String(this.sequence).padStart(4, '0')}`;
    const missing = request.targets.filter((target) => FIXTURE_SITE_PAGES[target] === undefined);
    const run: FixtureRun =
      missing.length > 0
        ? {
            request,
            status: 'failed',
            progress: 0,
            polls: 0,
            failureReason: `URL Does not Exist: ${missing.join(', ')}`,
            stopRequests: 0,
          }
        : { request, status: 'running', progress: 0, polls: 0, stopRequests: 0 };
    this.runs.set(engineRunId, run);
    return engineRunId;
  }

  async progress(engineRunId: string): Promise<EngineProgress> {
    const run = this.runOrThrow(engineRunId);
    run.polls += 1;
    if (run.status === 'failed') {
      const reason = run.failureReason ?? 'engine failed';
      return { status: 'failed', progress: 0, lastActivityAt: '', messageCount: 0, failureReason: reason };
    }
    if (run.polls >= FIXTURE_ZAP_ALERT_BATCHES.length) {
      run.status = 'complete';
      run.progress = 100;
    } else {
      run.progress = Math.round((run.polls / FIXTURE_ZAP_ALERT_BATCHES.length) * 100);
    }
    return { status: run.status, progress: run.progress, lastActivityAt: '', messageCount: this.observedAlertCount(engineRunId) };
  }

  async alerts(engineRunId: string, cursor: number): Promise<{ alerts: readonly EngineAlert[]; nextCursor: number }> {
    const run = this.runOrThrow(engineRunId);
    if (run.status === 'failed') {
      return { alerts: [], nextCursor: cursor };
    }
    const batches = FIXTURE_ZAP_ALERT_BATCHES;
    if (cursor >= batches.reduce((sum, batch) => sum + batch.length, 0)) {
      return { alerts: [], nextCursor: cursor };
    }
    let skipped = 0;
    for (const batch of batches) {
      if (cursor < skipped + batch.length) {
        return { alerts: [...batch], nextCursor: skipped + batch.length };
      }
      skipped += batch.length;
    }
    return { alerts: [], nextCursor: cursor };
  }

  /** 停止は冪等 (F11-UT-005)。 */
  async stop(engineRunId: string): Promise<void> {
    const run = this.runOrThrow(engineRunId);
    run.stopRequests += 1;
    run.status = run.status === 'complete' ? 'complete' : 'failed';
  }

  run(engineRunId: string): Readonly<FixtureRun> | undefined {
    return this.runs.get(engineRunId);
  }

  allRuns(): readonly Readonly<FixtureRun>[] {
    return [...this.runs.values()];
  }

  fixtureHash(): string {
    return zapAlertsFixtureHash();
  }

  private observedAlertCount(engineRunId: string): number {
    return FIXTURE_ZAP_ALERT_BATCHES.reduce((sum, batch) => sum + batch.length, 0);
  }

  private runOrThrow(engineRunId: string): FixtureRun {
    const run = this.runs.get(engineRunId);
    if (run === undefined) {
      throw new Error(`unknown engine run: ${engineRunId}`);
    }
    return run;
  }
}
