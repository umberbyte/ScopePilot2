import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JobSummary, SequencerSessionResult, StartJobRequest } from '@scopepilot2/contracts';
import type { SequencerTransportPort } from '../../src/ports/engines.ts';
import { createCoreApiServer } from '../../src/application/api-server.ts';
import { bootstrapFlow } from '../unit/support/test-flow.ts';

async function setup(transport?: SequencerTransportPort) {
  const { service, operator } = await bootstrapFlow(transport === undefined ? {} : { sequencerTransport: transport });
  const server = createCoreApiServer({ service, operator });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { service, base, post, async close() { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}
const params = { targetUrl: 'http://fixture.target.test/token', samples: 30 };
async function terminal(base: string, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = await (await fetch(`${base}/api/jobs/${id}`)).json() as { summary: JobSummary; result?: SequencerSessionResult; error?: string };
    if (!['Queued', 'Running', 'Stopping'].includes(job.summary.state)) return job;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('job did not terminate');
}

test('Sequencer jobs complete with sample progress, replayable SSE, fixture disclosure and secret-free results', { timeout: 10000 }, async () => {
  const ctx = await setup();
  try {
    const request: StartJobRequest = { kind: 'sequencer', params: { ...params, replayRequest: { headers: [['Authorization', 'Bearer replay-secret']], body: 'replay-body-secret' } } };
    const response = await ctx.post('/api/jobs', request);
    assert.equal(response.status, 202, await response.clone().text());
    const { jobId } = await response.json() as { jobId: string };
    const detail = await terminal(ctx.base, jobId);
    assert.equal(detail.summary.state, 'Completed');
    assert.equal(detail.summary.kind, 'sequencer');
    assert.equal(detail.summary.guarantee, 'Enforced');
    assert.equal(detail.summary.transport, 'fixture');
    assert.equal(detail.summary.counters.requestsSent, 0, 'synthetic samples are never reported as real HTTP requests');
    assert.deepEqual(detail.summary.counters.progress, { done: 30, total: 30, unit: 'samples' });
    assert.equal(detail.result?.sampleCount, 30);
    assert.equal(detail.result?.verdict, 'assessed');
    assert.ok(ctx.service.events().some(e => e.type === 'SequencerSessionCompleted' && e.jobId === jobId));
    const events = ctx.service.jobs.events().filter(e => e.jobId === jobId);
    const cursor = events[2]!.seq;
    const responseSse = await fetch(`${ctx.base}/api/jobs/${jobId}/events`, { headers: { 'Last-Event-ID': String(cursor) } });
    const reader = responseSse.body!.getReader();
    const chunk = await reader.read();
    const replay = new TextDecoder().decode(chunk.value);
    assert.match(replay, new RegExp(`id: ${events[3]!.seq}`));
    assert.match(replay, /Completed/);
    await reader.cancel();
    assert.doesNotMatch(JSON.stringify({ detail, events }), /replay-secret|replay-body-secret|sample-0/);
  } finally { await ctx.close(); }
});

test('live Sequencer streams progress before completion and stop retains partial statistics with no later sends', { timeout: 10000 }, async () => {
  let count = 0;
  const transport: SequencerTransportPort = { async collect(input) {
    for (let i = 0; i < input.samples; i++) {
      input.signal?.throwIfAborted();
      input.beforeRequest?.();
      count++;
      input.onResponse({ requestUrl: input.targetUrl, status: 200, contentType: 'text/plain', body: `token=private-sample-${i}` });
      await new Promise<void>(r => setTimeout(r, 10));
    }
  } };
  const ctx = await setup(transport);
  try {
    const { jobId } = await (await ctx.post('/api/jobs', { kind: 'sequencer', params })).json() as { jobId: string };
    const controller = new AbortController();
    const response = await fetch(`${ctx.base}/api/jobs/${jobId}/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    let buffer = '';
    while (!buffer.includes('Sample collected')) buffer += new TextDecoder().decode((await reader.read()).value);
    assert.equal(ctx.service.jobs.get(jobId)!.summary.state, 'Running');
    assert.equal((await ctx.post(`/api/jobs/${jobId}/stop`, {})).status, 202);
    const result = await terminal(ctx.base, jobId);
    assert.equal(result.summary.state, 'Stopped');
    assert.equal(result.summary.transport, 'live');
    assert.ok(count > 0 && count < 30);
    assert.equal(result.summary.counters.requestsSent, count);
    assert.equal(result.summary.counters.budget.used, count);
    assert.equal(result.summary.counters.progress?.done, count);
    assert.equal(result.result?.sampleCount, count);
    assert.equal(result.result?.verdict, 'insufficient');
    const stoppedAt = count;
    await new Promise(r => setTimeout(r, 40));
    assert.equal(count, stoppedAt);
    assert.doesNotMatch(JSON.stringify(ctx.service.jobs.get(jobId)), /private-sample/);
    assert.ok(!ctx.service.events().some(e => e.type === 'SequencerSessionCompleted'));
    controller.abort();
  } finally { await ctx.close(); }
});

test('Sequencer validates before acceptance, and sanitizes transport errors', { timeout: 10000 }, async () => {
  const ctx = await setup({ async collect() { throw new Error('opaque-response-secret and replay-header-secret'); } });
  try {
    for (const invalid of [{ ...params, samples: 29 }, { ...params, samples: 10001 }, { ...params, samples: 5001 }, { ...params, targetUrl: 'http://outside.test/' }, { ...params, tokenSource: 'bad' }, { ...params, tokenSource: ['body'] }, { ...params, role: 'not-logged-in' }, { ...params, replayRequest: { headers: [['Host', 'outside.test']] } }]) {
      const response = await ctx.post('/api/jobs', { kind: 'sequencer', params: invalid });
      assert.ok([400, 403].includes(response.status), await response.text());
    }
    assert.equal(ctx.service.jobs.list().length, 0);
    const { jobId } = await (await ctx.post('/api/jobs', { kind: 'sequencer', params })).json() as { jobId: string };
    const failed = await terminal(ctx.base, jobId);
    assert.equal(failed.summary.state, 'Failed');
    assert.equal(failed.summary.counters.errors, 1);
    assert.doesNotMatch(JSON.stringify({ failed, events: ctx.service.jobs.events() }), /opaque-response-secret|replay-header-secret/);
  } finally { await ctx.close(); }
});

test('queued Sequencer can stop without calling its transport', { timeout: 10000 }, async () => {
  let calls = 0;
  const ctx = await setup({ async collect() { calls++; } });
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const blocking = [1, 2].map(() => {
    const id = ctx.service.jobs.create({ kind: 'sequencer', label: 'blocker', guarantee: 'Enforced', transport: 'fixture' });
    return ctx.service.jobs.execute(id, () => gate);
  });
  try {
    const { jobId } = await (await ctx.post('/api/jobs', { kind: 'sequencer', params })).json() as { jobId: string };
    assert.equal(ctx.service.jobs.get(jobId)!.summary.state, 'Queued');
    await ctx.post(`/api/jobs/${jobId}/stop`, {});
    release(); await Promise.all(blocking);
    assert.equal((await terminal(ctx.base, jobId)).summary.state, 'Stopped');
    assert.equal(calls, 0);
  } finally { release(); await ctx.close(); }
});

test('in-flight stop counts dispatched requests even without a response', { timeout: 10000 }, async () => {
  const ctx = await setup({ async collect(input) {
    input.beforeRequest?.();
    await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  try {
    const { jobId } = await (await ctx.post('/api/jobs', { kind: 'sequencer', params })).json() as { jobId: string };
    await ctx.post(`/api/jobs/${jobId}/stop`, {});
    const job = await terminal(ctx.base, jobId);
    assert.equal(job.summary.state, 'Stopped');
    assert.equal(job.summary.counters.requestsSent, 1);
    assert.equal(job.summary.counters.progress?.done, 0);
    assert.equal(job.result?.sampleCount, 0);
  } finally { await ctx.close(); }
});

test('scope changes reject the next send and emit an attributed denial', { timeout: 10000 }, async () => {
  let next!: () => void;
  const gate = new Promise<void>(r => { next = r; });
  let sends = 0;
  const ctx = await setup({ async collect(input) {
    input.beforeRequest?.(); sends++;
    input.onResponse({ requestUrl: input.targetUrl, status: 200, contentType: 'text/plain', body: 'token=secret-first' });
    await gate;
    input.beforeRequest?.(); sends++;
  } });
  try {
    const { jobId } = await (await ctx.post('/api/jobs', { kind: 'sequencer', params })).json() as { jobId: string };
    const current = ctx.service.currentCase();
    const response = await ctx.post('/api/case/scope', { expectedRevision: current.revision, allowedOrigins: ['http://different.test'], deniedOrigins: [], limits: current.scope.limits });
    assert.equal(response.status, 200);
    next();
    const job = await terminal(ctx.base, jobId);
    assert.equal(sends, 1);
    assert.equal(job.summary.state, 'Failed');
    assert.equal(job.summary.counters.deniedByScope, 1);
    assert.ok(ctx.service.jobs.events().some(e => e.jobId === jobId && e.category === 'egress-denied'));
  } finally { next(); await ctx.close(); }
});

test('run.manage permission is required before creating a Sequencer job', async () => {
  const { service, operator } = await bootstrapFlow();
  assert.throws(() => service.startSequencerJob({ ...operator, permissions: ['case.read'] }, params), /permission/);
  assert.equal(service.jobs.list().length, 0);
});
