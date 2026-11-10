import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCoreApiServer } from '@scopepilot2/core';
import type { FuzzRunView } from '@scopepilot2/contracts';
import { bootstrapFlow } from '../unit/support/test-flow.ts';

test('GO-15: jobs API accepts, polls, stops in-flight work, and reports validation failure without sending', async () => {
  let release!: () => void;
  let calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { service, operator } = await bootstrapFlow({ fuzzTransport: { async send(input) {
    calls++; await gate;
    return { requestUrl: input.targetUrl, status: 200, contentType: 'text/plain', contentLength: 2, bodyHash: 'ok' };
  } } });
  const server = createCoreApiServer({ service, operator });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/fuzzer`;
  const post = (path: string, body: unknown) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(`${base}/status`)).json()).transport, 'http');
    const response = await post('jobs', { targetUrl: 'http://fixture.target.test/fuzz', positions: [{ name: 'q', values: ['a', 'b'] }], attack: 'sniper' });
    assert.equal(response.status, 202);
    const initial = await response.json() as FuzzRunView;
    assert.equal(initial.state, 'Running');
    assert.equal((await post('stop', { runId: initial.runId })).status, 200);
    release();
    let result = initial;
    for (let attempt = 0; attempt < 20 && result.state === 'Running'; attempt++) {
      result = await (await fetch(`${base}/jobs?runId=${initial.runId}`)).json() as FuzzRunView;
    }
    assert.equal(result.state, 'Stopped');
    assert.equal(result.sent, 1);
    assert.equal(calls, 1);
    const invalid = await (await post('jobs', { targetUrl: 'http://fixture.target.test/fuzz', positions: [{ name: 'q', values: ['a', 'b'] }], maxRequests: 1 })).json() as FuzzRunView;
    const failed = await (await fetch(`${base}/jobs?runId=${invalid.runId}`)).json() as FuzzRunView;
    assert.equal(failed.state, 'Failed');
    assert.match(failed.error ?? '', /exceeds plan limit/);
    assert.equal(calls, 1);
  } finally {
    release();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
