import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ScanMonitor } from '@scopepilot2/core';
import { FakeScanEngine } from '../support/test-flow.ts';
import type { ActiveScanEnginePort } from '@scopepilot2/core';

describe('ScanMonitor', () => {
  test('[F11-UT-005] 停止の二重要求でも adapter stop は 1 回だけ呼ぶ (冪等)', async () => {
    const engine = new FakeScanEngine();
    const monitor = new ScanMonitor(engine, 'fake-run-1');
    await monitor.requestStop();
    await monitor.requestStop();
    await monitor.requestStop();
    assert.equal(engine.stopCalls, 1);
    assert.equal(monitor.isStopRequested(), true);
  });

  test('[F11-UT-005] poll は完了まで続き、観測 alert と反復回数を返す', async () => {
    const engine = new FakeScanEngine();
    const monitor = new ScanMonitor(engine, 'fake-run-1', 10);
    const result = await monitor.collectUntilDone();
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.alerts, []);
    assert.equal(result.iterations, 1);
  });

  test('AbortSignalで実行中ZAPを一度だけ停止する', async () => {
    let stopCalls = 0;
    const engine: ActiveScanEnginePort = {
      engineVersion: 'zap-test',
      async start() { return 'scan-1'; },
      async alerts(_runId, cursor) { return { alerts: [], nextCursor: cursor }; },
      async progress() { return { status: 'running', progress: 10, lastActivityAt: new Date().toISOString(), messageCount: 1 }; },
      async stop() { stopCalls += 1; },
    };
    const controller = new AbortController();
    const monitor = new ScanMonitor(engine, 'scan-1', 10, 10_000, 0, controller.signal);
    const running = monitor.collectUntilDone();
    controller.abort();
    const result = await running;
    assert.equal(result.status, 'stopped');
    assert.equal(stopCalls, 1);
  });
});
