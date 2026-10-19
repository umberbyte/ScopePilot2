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

  test('GET /api/authorization は現在の認可を返し、未付与では 400 ValidationFailed', async () => {
    // この test は独立した server ではなく共有 server を使うため、先に案件を作る。
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'authz-get-it',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      }),
    });
    const missing = await fetch(`${baseUrl}/api/authorization`);
    assert.equal(missing.status, 400);
    const missingBody = (await missing.json()) as { code: string };
    assert.equal(missingBody.code, 'ValidationFailed');

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
    const current = await fetch(`${baseUrl}/api/authorization`);
    assert.equal(current.status, 200);
    const record = (await current.json()) as {
      allowedOperationClasses: readonly string[];
      targetRoles: readonly string[];
      validFrom: string;
      validUntil: string;
      evidenceRef: { readonly kind?: string };
    };
    assert.deepEqual(record.allowedOperationClasses, ['Browse', 'ActiveScan']);
    assert.equal(record.validUntil, '2026-10-19T00:00:00.000Z');
    // 証跡は hash 参照のみで、秘密値 (本文) は含まない。
    assert.equal(JSON.stringify(record).includes('it authorization evidence'), false);
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

  test('POST /api/tools/decode と /api/tools/compare-text は標準 codec と行差分を返す', async () => {
    const decode = await fetch(`${baseUrl}/api/tools/decode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputText: Buffer.from('Hello, ScopePilot!', 'utf8').toString('base64'), codecs: ['base64'] }),
    });
    assert.equal(decode.status, 200);
    const decoded = (await decode.json()) as { outputText: string; outputBytes: number };
    assert.equal(decoded.outputText, 'Hello, ScopePilot!');

    // codec chain (base64 → url) と未知 codec 拒否。
    const chained = await fetch(`${baseUrl}/api/tools/decode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputText: Buffer.from(encodeURIComponent('a b&c'), 'utf8').toString('base64'), codecs: ['base64', 'url'] }),
    });
    assert.equal((await chained.json() as { outputText: string }).outputText, 'a b&c');
    const unknown = await fetch(`${baseUrl}/api/tools/decode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputText: 'x', codecs: ['rot13'] }),
    });
    assert.equal(unknown.status, 400);

    // 比較: 1 行差分と provenance hash。
    const compare = await fetch(`${baseUrl}/api/tools/compare-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ left: 'same\nfirst-diff', right: 'same\nsecond-diff' }),
    });
    assert.equal(compare.status, 200);
    const diff = (await compare.json()) as {
      equal: boolean;
      differingLines: readonly { line: number; left: string; right: string }[];
      provenance: { leftHash: string; rightHash: string };
    };
    assert.equal(diff.equal, false);
    assert.deepEqual(diff.differingLines, [{ line: 2, left: 'first-diff', right: 'second-diff' }]);
    assert.notEqual(diff.provenance.leftHash, diff.provenance.rightHash);
  });

  test('break queue は intake → forward/drop を管理し、scope 外への編集は reject する (design/f02)', async () => {
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'proxy-it',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      }),
    });

    const intake = async (messageReference: string): Promise<{ item: { itemId: string; state: string } }> => {
      const response = await fetch(`${baseUrl}/api/proxy/intercept/intake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'request', messageReference, holdMs: 600_000 }),
      });
      assert.equal(response.status, 201);
      return (await response.json()) as { item: { itemId: string; state: string } };
    };
    const forward = async (itemId: string, targetUrl: string) => {
      const response = await fetch(`${baseUrl}/api/proxy/intercept/forward`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, targetUrl }),
      });
      return { status: response.status, body: (await response.json()) as { decision: { action: string; reason?: string } } };
    };

    // 対象内 URL への編集は forward、対象外は reject (F02-UT-004 の HTTP 経路)。
    const first = await intake('proxy-it-1');
    const forwarded = await forward(first.item.itemId, 'http://fixture.target.test/edited');
    assert.equal(forwarded.status, 200);
    assert.equal(forwarded.body.decision.action, 'forward');

    const second = await intake('proxy-it-2');
    const rejected = await forward(second.item.itemId, 'http://elsewhere.example/');
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.decision.action, 'reject');
    assert.match(rejected.body.decision.reason ?? '', /not in allowed origins/);

    // reject 後も item は Held のまま (別 URL で再判断できる)。
    const retried = await forward(second.item.itemId, 'http://fixture.target.test/ok');
    assert.equal(retried.body.decision.action, 'forward');

    // drop と一覧・event。
    const third = await intake('proxy-it-3');
    const dropped = await fetch(`${baseUrl}/api/proxy/intercept/drop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: third.item.itemId }),
    });
    assert.equal(dropped.status, 200);
    const list = (await (await fetch(`${baseUrl}/api/proxy/intercept`)).json()) as {
      items: readonly { itemId: string; state: string }[];
      events: readonly { type: string; itemId: string }[];
    };
    const thirdItem = list.items.find((item) => item.itemId === third.item.itemId);
    assert.equal(thirdItem?.state, 'Dropped');
    assert.ok(list.events.some((event) => event.type === 'dropped' && event.itemId === third.item.itemId));

    // 保持でない item への操作は 409。
    const conflict = await fetch(`${baseUrl}/api/proxy/intercept/drop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: first.item.itemId }),
    });
    assert.equal(conflict.status, 409);
  });

  test('GET /api/observations は site map 用の観測一覧と scope 拒否を返す', async () => {
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'observations-it',
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
    // この suite の FakeExplorer は同一 origin 内の /child/ だけを link するため
    // 探索中の scope 拒否は発生しない。拒否記録の表示は simulation fixture
    // (home が http://elsewhere.example/out-of-scope へ link) を使う app test で検証する。
    const planResponse = await fetch(`${baseUrl}/api/plan/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seeds: ['http://fixture.target.test/'] }),
    });
    const { plan } = (await planResponse.json()) as { plan: unknown };
    const confirmationResponse = await fetch(`${baseUrl}/api/plan/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    const confirmation = (await confirmationResponse.json()) as { confirmationId: string };
    const exploreRun = await fetch(`${baseUrl}/api/run/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, confirmation, maxDepth: 1 }),
    });
    assert.equal(exploreRun.status, 200, `run/explore failed: ${await exploreRun.text()}`);

    const response = await fetch(`${baseUrl}/api/observations`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      observations: readonly { url: string; status: number; depth: number; originType: string }[];
      deniedUrls: readonly { url: string; reason: string }[];
    };
    assert.ok(body.observations.length > 0);
    assert.ok(body.observations.every((observation) => observation.url.startsWith('http://fixture.target.test')));
    assert.ok(Array.isArray(body.deniedUrls));
    const urls = body.observations.map((observation) => observation.url);
    assert.equal(new Set(urls).size, urls.length, '観測 URL は正規化済みで一意');
  });

  test('POST /api/plan/explore の任意 limits は案件上限へクランプされる', async () => {
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'plan-limits-it',
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
    const response = await fetch(`${baseUrl}/api/plan/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seeds: ['http://fixture.target.test/'],
        limits: { maxRequests: 999_999, maxPages: 50, maxDurationMinutes: 5 },
      }),
    });
    assert.equal(response.status, 200);
    const { plan } = (await response.json()) as { plan: { steps: readonly { limits: { maxRequests: number; maxPages: number; maxDurationMinutes: number } }[] } };
    const limits = plan.steps[0]?.limits;
    assert.equal(limits?.maxRequests, 5000, '案件上限へクランプ');
    assert.equal(limits?.maxPages, 50, '指定値はそのまま');
    assert.equal(limits?.maxDurationMinutes, 5);
  });

  test('GET /api/findings と POST /api/findings/status は所見確認状態を監査付きで扱う', async () => {
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'findings-it',
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

    // 診断を実行して所見を作る (plan → confirm → run/scan)。
    const planResponse = await fetch(`${baseUrl}/api/plan/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: ['http://fixture.target.test/page'] }),
    });
    const { plan } = (await planResponse.json()) as { plan: unknown };
    const confirmationResponse = await fetch(`${baseUrl}/api/plan/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    const confirmation = (await confirmationResponse.json()) as { confirmationId: string };
    const scanResponse = await fetch(`${baseUrl}/api/run/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan,
        confirmation,
        adopted: [
          { candidateId: 'cand-findings-1', url: 'http://fixture.target.test/page', method: 'GET', category: 'page', guidelineBasis: ['provisional:page'], confidence: 0.7, observationUrl: 'http://fixture.target.test/page' },
        ],
      }),
    });
    assert.equal(scanResponse.status, 200);
    const scanBody = (await scanResponse.json()) as { findings: readonly { findingId: string; status: string; source: { unverified: boolean } }[] };
    assert.ok(scanBody.findings.length > 0, '診断で所見が 1 件以上作られる');

    const listResponse = await fetch(`${baseUrl}/api/findings`);
    assert.equal(listResponse.status, 200);
    const listBody = (await listResponse.json()) as { findings: readonly { findingId: string; status: string }[] };
    const target = listBody.findings[0];
    assert.notEqual(target, undefined);
    assert.equal(target?.status, 'candidate');

    const updateResponse = await fetch(`${baseUrl}/api/findings/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ findingId: target?.findingId, status: 'confirmed' }),
    });
    assert.equal(updateResponse.status, 200);
    const updated = (await updateResponse.json()) as { finding: { status: string } };
    assert.equal(updated.finding.status, 'confirmed');

    // 不正な status と未知の findingId は 400。同じ状態への再設定も 400。
    const badStatus = await fetch(`${baseUrl}/api/findings/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ findingId: target?.findingId, status: 'candidate' }),
    });
    assert.equal(badStatus.status, 400);
    const unknown = await fetch(`${baseUrl}/api/findings/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ findingId: 'finding-9999', status: 'confirmed' }),
    });
    assert.equal(unknown.status, 400);
    const same = await fetch(`${baseUrl}/api/findings/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ findingId: target?.findingId, status: 'confirmed' }),
    });
    assert.equal(same.status, 400);

    // 状態変更は監査 event に確認者付きで残る。
    const eventsResponse = await fetch(`${baseUrl}/api/events`);
    const eventsText = await eventsResponse.text();
    assert.match(eventsText, /FindingStatusChanged/);
    assert.match(eventsText, /operator-test/);
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
