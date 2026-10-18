import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { BaselineFlowService, type BaselineFlowService as BaselineFlowServiceType } from '@scopepilot2/core';
import { createCoreApiServer } from '../../src/application/api-server.ts';
import { createTestService, TEST_OPERATOR } from '../unit/support/test-flow.ts';

// IT: 127.0.0.1 の ephemeral port への loopback 通信のみ (docs/detailed-design/03 §2)。
describe('Core API server (node:http)', () => {
  let service: BaselineFlowServiceType;
  let server: ReturnType<typeof createCoreApiServer>;
  let baseUrl: string;

  before(async () => {
    const flow = createTestService();
    service = flow.service;
    server = createCoreApiServer({ service, operator: TEST_OPERATOR });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections?.();
      setTimeout(() => reject(new Error('server close timeout')), 2000);
    });
  });

  test('GET /api/health は契約 version を返す', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { schemaVersion: string; status: string };
    assert.equal(body.schemaVersion, 'scopepilot2.api.v1');
    assert.equal(body.status, 'ok');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    // wildcard CORS を付与しない。
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  test('POST /api/case は案件を作成し、重複しない field は 400 ValidationFailed', async () => {
    const created = await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'api-it',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      }),
    });
    assert.equal(created.status, 201);
    const record = (await created.json()) as { caseId: string; revision: number };
    assert.equal(record.revision, 1);

    const invalid = await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 42, allowedOrigins: [], deniedOrigins: [], limits: {} }),
    });
    assert.equal(invalid.status, 400);
    const error = (await invalid.json()) as { code: string; retryable: boolean };
    assert.equal(error.code, 'ValidationFailed');
    assert.equal(error.retryable, false);
  });

  test('権限不足・競合は安定した status に写る (403 / 409)', async () => {
    const scopeUpdate = await fetch(`${baseUrl}/api/case/scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 99,
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      }),
    });
    assert.equal(scopeUpdate.status, 409);
    const conflict = (await scopeUpdate.json()) as { code: string };
    assert.equal(conflict.code, 'Conflict');
  });

  test('未知 route は 404、body なしは 400、巨大 body は上限で拒否', async () => {
    assert.equal((await fetch(`${baseUrl}/api/unknown`)).status, 404);
    const noBody = await fetch(`${baseUrl}/api/case`, { method: 'POST' });
    assert.equal(noBody.status, 400);
    const big = await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    assert.equal(big.status, 400);
    const error = (await big.json()) as { code: string };
    assert.equal(error.code, 'ValidationFailed');
  });

  test('GET /api/events?since=N は cursor 以降の監査 event を NDJSON で返す', async () => {
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'events-it',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      }),
    });
    const all = await fetch(`${baseUrl}/api/events`);
    const text = await all.text();
    const events = text.trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { eventId: number; type: string });
    assert.ok(events.length >= 2);
    assert.equal(events[0]?.type, 'CaseCreated');
    assert.ok(events.every((event, index) => event.eventId === index + 1), 'eventId は連番');

    const since = await fetch(`${baseUrl}/api/events?since=${events.length - 1}`);
    const tailText = await since.text();
    const tail = tailText.trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { eventId: number });
    assert.equal(tail.length, 1);
    assert.equal(tail[0]?.eventId, events.length);
  });
});
