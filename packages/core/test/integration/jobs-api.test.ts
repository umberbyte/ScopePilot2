import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCoreApiServer } from '../../src/application/api-server.ts';
import { bootstrapFlow } from '../unit/support/test-flow.ts';
async function openStream(url: string, since = 0) {
  const response = await fetch(url, { headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(since) } });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(); let buffer = '';
  return { close: () => reader.cancel(), async next(): Promise<{ seq: number; jobId: string }> {
    while (!buffer.includes('\n\n')) { const chunk = await reader.read(); if (chunk.done) throw new Error('SSE ended'); buffer += new TextDecoder().decode(chunk.value); }
    const end = buffer.indexOf('\n\n'); const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    return JSON.parse(block.split('\n').find(l => l.startsWith('data: '))!.slice(6));
  } };
}
test('SSE replays global Last-Event-ID without gaps, then delivers new events; per-job stream filters', { timeout: 10000 }, async () => {
  const { service, operator } = await bootstrapFlow();
  const server = createCoreApiServer({ service, operator });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
  try {
    const input = { kind: 'active-scan' as const, label: 'test', guarantee: 'Mixed' as const, transport: 'fixture' as const };
    const a = service.jobs.create(input); const b = service.jobs.create(input);
    const stream = await openStream(`${base}/api/jobs/events`);
    assert.equal((await stream.next()).seq, 1); await stream.close();
    service.jobs.transition(a, 'Running'); service.jobs.transition(b, 'Running');
    const resumed = await openStream(`${base}/api/jobs/events`, 1);
    assert.deepEqual([(await resumed.next()).seq, (await resumed.next()).seq, (await resumed.next()).seq], [2, 3, 4]);
    service.jobs.stop(a); assert.equal((await resumed.next()).seq, 5); await resumed.close();
    const scoped = await openStream(`${base}/api/jobs/${b}/events`, 1);
    assert.equal((await scoped.next()).jobId, b); assert.equal((await scoped.next()).seq, 4); await scoped.close();
    const invalid = await fetch(`${base}/api/jobs/events`, { headers: { 'Last-Event-ID': 'bad' } }); assert.equal(invalid.status, 400);
    const list = await (await fetch(`${base}/api/jobs?state=active`)).json() as { jobs: unknown[] }; assert.equal(list.jobs.length, 2);
    const stop = await fetch(`${base}/api/jobs/${b}/stop`, { method: 'POST' }); assert.equal(stop.status, 202);
    const compatStop = await fetch(`${base}/api/run/scan/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ executionId: a }) });
    assert.equal(compatStop.status, 202); assert.equal((await compatStop.json() as { state: string }).state, 'Stopping');
    const history = await (await fetch(`${base}/api/jobs/${a}/events?before=9999&limit=2`, { headers: { Accept: 'application/x-ndjson' } })).text();
    assert.equal(history.trim().split('\n').length, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('jobs start and scan compatibility share registry, results, audit attribution, and phase logs', { timeout: 10000 }, async () => {
  const { service, operator } = await bootstrapFlow();
  const server = createCoreApiServer({ service, operator });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const { plan } = service.buildActiveScanPlan(operator, ['http://fixture.target.test/']); service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);
    const adopted = [{ candidateId: 'test', url: 'http://fixture.target.test/', method: 'GET', category: 'page', guidelineBasis: [], confidence: 1, observationUrl: 'http://fixture.target.test/' }];
    for (const route of ['/api/run/scan/start', '/api/jobs']) {
      const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(route.endsWith('start') ? { plan, confirmation, adopted } : { kind: 'active-scan', plan, confirmation, params: { adopted } }) });
      assert.equal(response.status, 202, await response.clone().text());
      const body = await response.json() as { jobId?: string; executionId?: string }; const id = body.jobId ?? body.executionId!;
      for (let n = 0; service.jobs.active(service.jobs.get(id)!.summary.state) && n < 100; n++) await new Promise(r => setTimeout(r, 5));
      const status = await (await fetch(`${base}/api/run/scan/status?executionId=${id}`)).json() as { state: string; logs: string[]; result: unknown };
      assert.equal(status.state, 'Completed'); assert.ok(status.logs.length > 1); assert.ok(status.result);
      assert.ok(service.events().some(e => e.type === 'RunStarted' && e.jobId === id && e.runId));
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('audit SSE remains open for new events and reconnect preserves IDs under jobId filtering', { timeout: 10000 }, async () => {
  const { service, operator } = await bootstrapFlow();
  const server = createCoreApiServer({ service, operator });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const since = service.events().length;
    const response = await fetch(`${base}/api/events`, { headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(since) } });
    const reader = response.body!.getReader();
    const { plan } = service.buildActiveScanPlan(operator, ['http://fixture.target.test/']);
    service.authorizePlan(plan);
    const read = await reader.read(); const text = new TextDecoder().decode(read.value);
    assert.match(text, new RegExp(`id: ${since + 1}`)); assert.match(text, /PlanValidated/);
    await reader.cancel();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
