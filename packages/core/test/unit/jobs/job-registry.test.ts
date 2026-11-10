import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobRegistry, jobContext } from '../../../src/application/job-registry.ts';
const input = { kind: 'active-scan' as const, label: 'test', guarantee: 'Mixed' as const, transport: 'fixture' as const };
test('job transitions are validated; terminals cannot restart', async () => {
  const r = new JobRegistry(); const id = r.create(input);
  assert.throws(() => r.transition(id, 'Completed'), /invalid job transition/);
  await r.execute(id, async () => 'done');
  assert.equal(r.get(id)?.summary.state, 'Completed');
  assert.equal(r.get(id)?.result, 'done');
  assert.throws(() => r.transition(id, 'Running'), /invalid job transition/);
  assert.equal(r.stop(id).state, 'Completed');
});
test('cooperative stop waits for worker acknowledgement, even when worker returns successfully', async () => {
  const r = new JobRegistry(); const id = r.create(input);
  let finish!: () => void; let signal!: AbortSignal;
  const running = r.execute(id, async s => { signal = s; await new Promise<void>(resolve => { finish = resolve; }); });
  r.stop(id); r.stop(id);
  assert.equal(signal.aborted, true); assert.equal(r.get(id)?.summary.state, 'Stopping');
  finish(); await running;
  assert.equal(r.get(id)?.summary.state, 'Stopped');
  assert.equal(r.get(id)?.summary.stopReason, 'user-request');
});
test('queued stop prevents execution; failure terminates and redacts credentials', async () => {
  const r = new JobRegistry(); const id = r.create(input); r.stop(id);
  await r.execute(id, async () => { assert.fail('stopped worker ran'); });
  const failed = r.create(input); await r.execute(failed, async () => { throw new Error('Authorization: Bearer secret'); });
  assert.equal(r.get(failed)?.summary.state, 'Failed');
  assert.doesNotMatch(JSON.stringify(r.get(failed)), /Bearer secret/);
});
test('counters are absolute snapshots, delegated counts remain separate, contexts isolate concurrent jobs', async () => {
  const r = new JobRegistry(); const a = r.create(input); const b = r.create(input);
  await Promise.all([a, b].map(id => r.execute(id, async () => {
    await Promise.resolve(); assert.equal(jobContext.getStore()?.jobId, id);
    r.emit(id, { category: 'phase', messageKey: 'job.phase', message: 'progress', params: {}, counters: { requestsReportedByEngine: 100, requestsSent: id === a ? 2 : 4 } });
    r.emit(id, { category: 'warning', messageKey: 'job.phase', message: 'warning', params: {} });
  })));
  assert.equal(r.aggregateCounters().requestsSent, 6);
  assert.equal(r.aggregateCounters().requestsReportedByEngine, 200);
  assert.equal(r.get(a)?.summary.counters.requestsSent, 2);
  assert.equal(r.get(b)?.summary.counters.requestsSent, 4);
  assert.equal(r.get(a)?.summary.counters.requestsReportedByEngine, 100);
  assert.equal(r.get(a)?.summary.counters.warnings, 1);
  assert.deepEqual(r.events().map(e => e.seq), r.events().map((_, i) => i + 1));
});
test('event cap preserves important events and records truncation once', () => {
  const r = new JobRegistry(undefined, 2); const id = r.create(input);
  for (let n = 0; n < 5; n++) r.emit(id, { category: 'request', messageKey: 'job.request.sent', message: 'request', params: {} });
  r.emit(id, { category: 'egress-denied', messageKey: 'job.egress.denied', message: 'denied', params: {} });
  assert.equal(r.events().filter(e => e.messageKey === 'job.events.truncated').length, 1);
  assert.equal(r.get(id)?.summary.counters.deniedByScope, 1);
});

test('invalid counters leave the previous snapshot intact; batches flush before terminal events', async () => {
  const r = new JobRegistry(undefined, 2); const id = r.create(input);
  assert.throws(() => r.emit(id, { category: 'phase', messageKey: 'job.phase', message: 'bad', params: {}, counters: { budget: { leased: -1, used: 0, limit: 2 } } }), /invalid job counter/);
  assert.equal(r.get(id)?.summary.counters.budget.leased, 0);
  await r.execute(id, async () => {
    for (let n = 1; n <= 5; n++) r.emit(id, { category: 'request', messageKey: 'job.request.sent', message: 'sent', params: {}, counters: { requestsSent: n } });
  });
  const events = r.events(); const batch = events.find(e => e.messageKey === 'job.request.batch');
  assert.equal(batch?.params.count, 5); assert.equal(batch?.counters?.requestsSent, 5);
  assert.equal(events.at(-1)?.params.state, 'Completed');
});

test('concurrency queues work and stopping a queued job never calls its operation', async () => {
  const r = new JobRegistry(undefined, 50_000, 1); const a = r.create(input); const b = r.create(input);
  let finish!: () => void;
  const first = r.execute(a, async () => { await new Promise<void>(resolve => { finish = resolve; }); });
  const second = r.execute(b, async () => { assert.fail('queued cancelled operation ran'); });
  assert.equal(r.get(b)?.summary.state, 'Queued'); r.stop(b); finish(); await Promise.all([first, second]);
  assert.equal(r.get(b)?.summary.state, 'Stopped');
});
