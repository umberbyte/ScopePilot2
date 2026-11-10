import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combinationAt, planCombinations, runFuzz, type FuzzTransportPort } from '@scopepilot2/core';
import { bootstrapFlow } from '../support/test-flow.ts';

const positions = [{ name: 'a', values: ['1', '2'] }, { name: 'b', values: ['x', 'y', 'z'] }];
test('GO-15: all four attack strategies preserve originals and enumerate correctly', () => {
  assert.equal(planCombinations(positions, 6, 'sniper').total, 5);
  assert.deepEqual(combinationAt(positions, 2, 'sniper', ['A', 'B']), ['A', 'x']);
  assert.equal(planCombinations(positions, 6, 'pitchfork').total, 2);
  assert.deepEqual(combinationAt(positions, 1, 'pitchfork'), ['2', 'y']);
  assert.equal(planCombinations(positions, 6, 'battering-ram').total, 2);
  assert.deepEqual(combinationAt(positions, 1, 'battering-ram'), ['2', '2']);
  assert.deepEqual(combinationAt(positions, 5, 'cluster-bomb'), ['2', 'z']);
  for (const cap of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => planCombinations(positions, cap));
});
test('GO-15: cancellation during rate wait sends no additional request', async () => {
  let cancelled = false;
  const calls: number[] = [];
  const result = await runFuzz({ async send(index) { calls.push(index); } }, positions, 6, {
    isCancelled: () => cancelled, now: () => 0, sleep: async () => { cancelled = true; },
  });
  assert.deepEqual(calls, [0]);
  assert.equal(result.sent, 1);
});
test('GO-15: payload catalog selection, body markers, response byte differences and case cap', async () => {
  const calls: Parameters<FuzzTransportPort['send']>[0][] = [];
  const { service, operator } = await bootstrapFlow({ fuzzTransport: { async send(input) {
    calls.push(input);
    return { requestUrl: input.targetUrl, status: calls.length === 1 ? 200 : 201, contentType: 'text/plain', contentLength: calls.length * 3, bodyHash: String(calls.length) };
  } } });
  service.registerPayloadSet(operator, { name: 'generic', source: 'unit fixture', version: '1', license: 'CC0', sha256: 'fixture-hash', values: ['x', 'y'] });
  const result = await service.runFuzzSession(operator, {
    targetUrl: 'http://fixture.target.test/fuzz?a=original',
    request: { method: 'POST', contentType: 'text/plain', bodyTemplate: 'left=\u00a7old\u00a7&right=\u00a7keep\u00a7' },
    positions: [{ name: 'a', values: ['q'] }, { name: 'body:1', values: [], payloadSet: 'generic' }, { name: 'body:2', values: ['r'] }],
    attack: 'pitchfork',
  });
  assert.equal(result.transport, 'http');
  assert.equal(result.payloadSources[1]?.source, 'unit fixture');
  assert.match(result.payloadSources[1]?.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(calls[0]?.request?.body, 'left=x&right=r');
  assert.deepEqual(calls[0]?.combination, ['q']);
  assert.deepEqual(calls[0]?.positions.map(p => p.name), ['a']);
  assert.equal(result.rows[0]?.lengthDiff, 0);
  assert.equal(result.rows[0]?.changed, false);
  const fixture = await bootstrapFlow();
  const diff = await fixture.service.runFuzzSession(fixture.operator, { targetUrl: 'http://fixture.target.test/fuzz', positions: [{ name: 'q', values: ['a', 'long'] }] });
  assert.equal(diff.transport, 'fixture');
  assert.equal(diff.rows[1]?.lengthDiff, 3);
  assert.equal(diff.rows[1]?.changed, true);
  await assert.rejects(service.runFuzzSession(operator, { targetUrl: 'http://fixture.target.test/fuzz', positions: [{ name: 'q', values: Array(10001).fill('x') }], maxRequests: 999999 }), /exceeds plan limit/);
  assert.equal(calls.length, 1);
});
test('GO-15: async fixture progress and stopping retain partial results', async () => {
  const { service, operator } = await bootstrapFlow();
  const initial = service.startFuzzJob(operator, { targetUrl: 'http://fixture.target.test/fuzz', positions: [{ name: 'q', values: Array(20).fill('x') }] });
  assert.equal(initial.transport, 'fixture');
  assert.throws(() => service.startFuzzJob(operator, { targetUrl: 'http://fixture.target.test/fuzz', positions }), /already running/);
  service.stopFuzzJob(operator, initial.runId);
  await new Promise<void>(resolve => setImmediate(resolve));
  const result = service.getFuzzJob(initial.runId);
  assert.equal(result.state, 'Stopped');
  assert.ok(result.sent < result.total);
  assert.equal(result.rows.length, result.sent);
});
