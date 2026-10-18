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
  // 手書き fake: Running 候補を 1 件持つ run repository (design/22 §6 の意味論)。
  const fakeRunRepository = {
    candidates: [
      { runId: 'run-orphan', planId: 'plan-1', caseId: 'case-0001', state: 'Running' as const, attempt: 1 },
    ],
    listInterruptedCandidates() {
      return [...this.candidates];
    },
    markInterrupted() {
      const marked = this.candidates.map((candidate) => ({ ...candidate, state: 'Interrupted' as const, stopReason: 'interrupted' as const }));
      this.candidates = [];
      return marked;
    },
  };

  before(async () => {
    const flow = createTestService();
    service = flow.service;
    server = createCoreApiServer({ service, operator: TEST_OPERATOR, runRepository: fakeRunRepository });
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

  test('POST /api/plan/confirm → /api/run/explore は確認一致で探索を実行する', async () => {
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'explore-it',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      }),
    });
    await fetch(`${baseUrl}/api/authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['unauthenticated'],
        validFrom: '2026-10-18T00:00:00.000Z',
        validUntil: '2026-10-19T00:00:00.000Z',
        evidenceLabel: '認可(IT)',
        evidenceContent: 'it authorization evidence',
      }),
    });
    const planResponse = await fetch(`${baseUrl}/api/plan/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seeds: ['http://fixture.target.test/'] }),
    });
    assert.equal(planResponse.status, 200);
    const { plan, planHash } = (await planResponse.json()) as { plan: unknown; planHash: string };
    assert.match(planHash, /^[0-9a-f]{64}$/);

    const confirmResponse = await fetch(`${baseUrl}/api/plan/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    assert.equal(confirmResponse.status, 200);
    const confirmation = (await confirmResponse.json()) as { confirmationId: string };

    const runResponse = await fetch(`${baseUrl}/api/run/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, confirmation, maxDepth: 2 }),
    });
    assert.equal(runResponse.status, 200);
    const result = (await runResponse.json()) as { runRecord: { state: string; stopReason: string }; observations: unknown[]; candidates: unknown[] };
    assert.equal(result.runRecord.state, 'Completed');
    assert.equal(result.runRecord.stopReason, 'completed');
    assert.ok(result.observations.length > 0);
    assert.ok(result.candidates.length > 0);

    // 確認 hash 不一致は 409 ConfirmationRequired。
    const unconfirmed = await fetch(`${baseUrl}/api/run/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, confirmation: { ...confirmation, planHash: 'x'.repeat(64) }, maxDepth: 2 }),
    });
    assert.equal(unconfirmed.status, 409);
    const error = (await unconfirmed.json()) as { code: string };
    assert.equal(error.code, 'ConfirmationRequired');
  });

  test('POST /api/plan/scan → /api/candidates/adopt → /api/run/scan → /api/report は診断から報告まで実行する', async () => {
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'scan-it',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      }),
    });
    await fetch(`${baseUrl}/api/authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['unauthenticated'],
        validFrom: '2026-10-18T00:00:00.000Z',
        validUntil: '2026-10-19T00:00:00.000Z',
        evidenceLabel: '認可(IT)',
        evidenceContent: 'it authorization evidence',
      }),
    });

    const candidate = {
      candidateId: 'cand-it-1',
      url: 'http://fixture.target.test/page',
      method: 'GET',
      category: 'page',
      guidelineBasis: ['provisional:page'],
      confidence: 0.7,
      observationUrl: 'http://fixture.target.test/page',
    };
    const adoptedResponse = await fetch(`${baseUrl}/api/candidates/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidates: [candidate] }),
    });
    assert.equal(adoptedResponse.status, 200);
    const { adopted } = (await adoptedResponse.json()) as { adopted: unknown[] };
    assert.equal(adopted.length, 1);

    const planResponse = await fetch(`${baseUrl}/api/plan/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: [candidate.url] }),
    });
    assert.equal(planResponse.status, 200);
    const { plan, planHash } = (await planResponse.json()) as { plan: unknown; planHash: string };
    assert.match(planHash, /^[0-9a-f]{64}$/);

    const confirmResponse = await fetch(`${baseUrl}/api/plan/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    const confirmation = (await confirmResponse.json()) as { confirmationId: string };

    const runResponse = await fetch(`${baseUrl}/api/run/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, confirmation, adopted: [candidate] }),
    });
    assert.equal(runResponse.status, 200);
    const scan = (await runResponse.json()) as {
      runRecord: { state: string; stopReason: string };
      scanRequest: { targets: string[] };
      engineVersion: string;
      findings: unknown[];
    };
    assert.equal(scan.runRecord.state, 'Completed');
    assert.equal(scan.runRecord.stopReason, 'completed');
    assert.deepEqual(scan.scanRequest.targets, [candidate.url]);
    assert.equal(scan.engineVersion, 'fake-zap-1');

    const reportResponse = await fetch(`${baseUrl}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guidelines: ['it-guideline'] }),
    });
    assert.equal(reportResponse.status, 200);
    const report = (await reportResponse.json()) as { modelHash: string };
    assert.match(report.modelHash, /^[0-9a-f]{64}$/);

    // 空の targets・空の candidates は 400 ValidationFailed。
    const emptyTargets = await fetch(`${baseUrl}/api/plan/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: [] }),
    });
    assert.equal(emptyTargets.status, 400);
    const emptyCandidates = await fetch(`${baseUrl}/api/candidates/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidates: [] }),
    });
    assert.equal(emptyCandidates.status, 400);
  });

  test('POST /api/import/nuclei は JSONL 取込結果 (quarantine・scope外・重複・正規化) を返す', async () => {
    const response = await fetch(`${baseUrl}/api/import/nuclei`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engineVersion: '3.4.0-it',
        lines: [
          '{"template-id":"it-header.yaml","matched-at":"http://fixture.target.test/","info":{"severity":"info","name":"IT header"}}',
          '{"template-id":"it-header.yaml","matched-at":"http://fixture.target.test/","info":{"severity":"info","name":"IT header"}}',
          '{"template-id":"it-critical.yaml","matched-at":"http://fixture.target.test/setup.php","info":{"severity":"critical","name":"IT critical"}}',
          '{"template-id":"it-external.yaml","matched-at":"http://elsewhere.example/x","info":{"severity":"info","name":"IT external"}}',
          '{broken json',
        ],
      }),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      findings: { readonly source: { readonly kind: string }; readonly severity: string; readonly sourceSeverity?: string; readonly url: string }[];
      importedCount: number;
      duplicateCount: number;
      quarantinedCount: number;
      excludedOutOfScope: number;
      evidenceRef: string;
    };
    assert.equal(result.importedCount, 2);
    assert.equal(result.duplicateCount, 1);
    assert.equal(result.quarantinedCount, 1);
    assert.equal(result.excludedOutOfScope, 1);
    assert.ok(result.evidenceRef.length > 0);
    const critical = result.findings.find(
      (finding) => finding.source.kind === 'nuclei-match' && finding.sourceSeverity === 'critical',
    );
    assert.notEqual(critical, undefined);
    assert.equal(critical?.severity, 'high');
    assert.ok(
      result.findings
        .filter((finding) => finding.source.kind === 'nuclei-match')
        .every((finding) => finding.url.startsWith('http://fixture.target.test')),
      'scope 外 matched-at の所見は作らない',
    );

    const invalid = await fetch(`${baseUrl}/api/import/nuclei`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: ['{}'] }),
    });
    assert.equal(invalid.status, 400);
    const error = (await invalid.json()) as { code: string };
    assert.equal(error.code, 'ValidationFailed');
  });

  test('GET /api/capabilities は能力表 (source・版) を返す', async () => {
    const response = await fetch(`${baseUrl}/api/capabilities`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      capabilities: { engineKind: string; engineVersion: string; source: string }[];
    };
    const kinds = body.capabilities.map((capability) => capability.engineKind);
    assert.ok(kinds.includes('zap'));
    assert.ok(body.capabilities.every((capability) => capability.source === 'fixture' || capability.source === 'measured'));
  });

  test('上限停止: maxPages=2 の案件で探索は Stopped/budget-exhausted になる (design/19 受け入れ2)', async () => {
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'budget-stop-it',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 2, maxDurationMinutes: 60 },
      }),
    });
    await fetch(`${baseUrl}/api/authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['unauthenticated'],
        validFrom: '2026-10-18T00:00:00.000Z',
        validUntil: '2026-10-19T00:00:00.000Z',
        evidenceLabel: '認可(IT)',
        evidenceContent: 'it authorization evidence',
      }),
    });
    const planResponse = await fetch(`${baseUrl}/api/plan/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seeds: ['http://fixture.target.test/'] }),
    });
    assert.equal(planResponse.status, 200);
    const { plan } = (await planResponse.json()) as { plan: unknown };
    const confirmResponse = await fetch(`${baseUrl}/api/plan/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    const confirmation = (await confirmResponse.json()) as { confirmationId: string };
    const runResponse = await fetch(`${baseUrl}/api/run/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, confirmation, maxDepth: 5 }),
    });
    assert.equal(runResponse.status, 200);
    const result = (await runResponse.json()) as { runRecord: { state: string; stopReason: string }; observations: unknown[] };
    assert.equal(result.runRecord.state, 'Stopped');
    assert.equal(result.runRecord.stopReason, 'budget-exhausted');
    assert.equal(result.observations.length, 2, 'page 上限で観測を打ち切り');
  });

  test('認可期限切れ: 期限切れ認可では計画検証が 403 になる (design/19 受け入れ2)', async () => {
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'authz-expired-it',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      }),
    });
    await fetch(`${baseUrl}/api/authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['unauthenticated'],
        validFrom: '2026-10-18T00:00:00.000Z',
        validUntil: '2026-10-18T09:00:00.000Z',
        evidenceLabel: '認可(IT)',
        evidenceContent: 'it authorization evidence',
      }),
    });
    // 固定時計 (TEST_NOW=09:00Z) の境界で validUntil == now は期限切れ扱い。
    const planResponse = await fetch(`${baseUrl}/api/plan/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seeds: ['http://fixture.target.test/'] }),
    });
    assert.equal(planResponse.status, 403);
    const error = (await planResponse.json()) as { code: string };
    assert.equal(error.code, 'PermissionDenied');
  });

  test('scope 縮小後の旧 confirmation では実行できない (409, F01-UT-006 の HTTP 経路)', async () => {
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'scope-narrow-it',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      }),
    });
    await fetch(`${baseUrl}/api/authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['unauthenticated'],
        validFrom: '2026-10-18T00:00:00.000Z',
        validUntil: '2026-10-19T00:00:00.000Z',
        evidenceLabel: '認可(IT)',
        evidenceContent: 'it authorization evidence',
      }),
    });
    const planResponse = await fetch(`${baseUrl}/api/plan/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seeds: ['http://fixture.target.test/'] }),
    });
    const { plan } = (await planResponse.json()) as { plan: unknown };
    const confirmResponse = await fetch(`${baseUrl}/api/plan/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    const confirmation = (await confirmResponse.json()) as { confirmationId: string };

    // scope を縮小 (上限減) すると confirmation は無効化される。
    const narrowResponse = await fetch(`${baseUrl}/api/case/scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 4000, maxPages: 500, maxDurationMinutes: 60 },
      }),
    });
    assert.equal(narrowResponse.status, 200);
    const narrowed = (await narrowResponse.json()) as { narrowed: boolean; invalidatedConfirmationIds: string[] };
    assert.equal(narrowed.narrowed, true);
    assert.deepEqual(narrowed.invalidatedConfirmationIds, [confirmation.confirmationId]);

    const staleRun = await fetch(`${baseUrl}/api/run/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, confirmation, maxDepth: 2 }),
    });
    assert.equal(staleRun.status, 409);
    const error = (await staleRun.json()) as { code: string; message: string };
    assert.equal(error.code, 'ConfirmationRequired');
    assert.match(error.message, /invalidated/);
  });

  test('GET /api/events の SSE 形式は Last-Event-ID 以降を再送する (design/18)', async () => {
    const sseResponse = await fetch(`${baseUrl}/api/events`, {
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': '0' },
    });
    assert.equal(sseResponse.status, 200);
    assert.match(sseResponse.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await sseResponse.text();
    const blocks = text.split('\n\n').filter((block) => block !== '');
    assert.ok(blocks.length >= 2);
    const first = blocks[0] ?? '';
    assert.match(first, /^id: 1\nevent: CaseCreated\ndata: /);
    for (const [index, block] of blocks.entries()) {
      assert.match(block, new RegExp(`^id: ${index + 1}\n`));
    }
    const total = blocks.length;
    const resumed = await fetch(`${baseUrl}/api/events`, {
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(total - 1) },
    });
    const resumedText = await resumed.text();
    const resumedBlocks = resumedText.split('\n\n').filter((block) => block !== '');
    assert.equal(resumedBlocks.length, 1);
    assert.match(resumedBlocks[0] ?? '', new RegExp(`^id: ${total}
`));
  });

  test('GET /api/runs/interrupted は実行中残置 run を Interrupted 化し、再実行は空を返す', async () => {
    const first = await fetch(`${baseUrl}/api/runs/interrupted`);
    assert.equal(first.status, 200);
    const body = (await first.json()) as { interrupted: readonly { runId: string; state: string; stopReason: string }[] };
    assert.equal(body.interrupted.length, 1);
    assert.equal(body.interrupted[0]?.runId, 'run-orphan');
    assert.equal(body.interrupted[0]?.state, 'Interrupted');
    assert.equal(body.interrupted[0]?.stopReason, 'interrupted');

    const second = await fetch(`${baseUrl}/api/runs/interrupted`);
    const empty = (await second.json()) as { interrupted: readonly unknown[] };
    assert.equal(empty.interrupted.length, 0, '自動再開せず、2 回目は空');
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
