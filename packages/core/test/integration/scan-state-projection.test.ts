import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { DomainError, type ScanStateProjection } from '@scopepilot2/contracts';
import type { BaselineFlowService, ActiveScanExecutionControl } from '@scopepilot2/core';
import { createCoreApiServer } from '../../src/application/api-server.ts';
import { TEST_OPERATOR } from '../unit/support/test-flow.ts';

for (const outcome of ['Completed', 'Stopped', 'Failed', 'Failed-result', 'Stopped-result'] as const) {
  test(`GO-26 API: ${outcome}, cooperative stop waits for cleanup and failure wins over abort`, async () => {
    let finish!: () => void;
    let control!: ActiveScanExecutionControl;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const service = { async runActiveScan(...args: unknown[]) {
      control = args[5] as ActiveScanExecutionControl;
      await gate;
      if (outcome === 'Stopped') throw new DomainError('Cancelled', 'cleanup finished');
      if (outcome === 'Failed') throw new DomainError('EngineFailure', 'storage failed after stop');
      return { runRecord: outcome === 'Failed-result' ? { state: 'Failed', stopReason: 'engine-failure' }
        : outcome === 'Stopped-result' ? { state: 'Stopped', stopReason: 'budget-exhausted' }
        : { state: 'Completed', stopReason: 'completed' } };
    } } as unknown as BaselineFlowService;
    const server = createCoreApiServer({ service, operator: TEST_OPERATOR });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/run/scan`;
    const post = async (path: string, body: unknown) => fetch(`${base}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    try {
      const accepted = await post('start', { plan: {}, confirmation: {}, adopted: [] });
      assert.equal(accepted.status, 202);
      const { executionId } = await accepted.json() as { executionId: string };
      const status = async () => (await (await fetch(`${base}/status?executionId=${executionId}`)).json()) as ScanStateProjection;
      const running = await status();
      assert.equal(running.runState, 'Running');
      assert.equal(running.state, running.runState);
      assert.equal(running.dispatchState, 'dispatched');
      if (outcome === 'Stopped' || outcome === 'Failed') {
        const stopping = await (await post('stop', { executionId })).json() as ScanStateProjection;
        assert.equal(stopping.runState, 'Stopping');
        assert.equal(stopping.stopReason, 'user-request');
        assert.equal(control.signal?.aborted, true);
        control.onEvent?.({ at: 'now', phase: 'stopped', engine: 'zap', message: 'engine stopped, saving evidence' });
        assert.equal((await status()).state, 'Stopping');
        assert.equal((await (await post('stop', { executionId })).json() as ScanStateProjection).state, 'Stopping');
      }
      finish();
      const terminal = await status();
      const expected = outcome === 'Failed-result' ? 'Failed' : outcome === 'Stopped-result' ? 'Stopped' : outcome;
      assert.equal(terminal.runState, expected);
      assert.equal(terminal.state, expected);
      assert.equal(terminal.stopReason, outcome === 'Completed' ? 'completed' : outcome === 'Stopped' ? 'user-request' : outcome === 'Stopped-result' ? 'budget-exhausted' : 'engine-failure');
      const repeated = await (await post('stop', { executionId })).json() as ScanStateProjection;
      assert.equal(repeated.state, expected);
      assert.equal(repeated.runState, expected);
      assert.equal(repeated.stopReason, terminal.stopReason);
    } finally {
      finish();
      server.close();
      await once(server, 'close');
    }
  });
}
