import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  type BaselineFlowService as BaselineFlowServiceType,
  type ExplorationPort,
  type LoginExecutionInput,
  type LoginExecutorPort,
  type LoginSessionCookie,
} from '@scopepilot2/core';
import type { PageObservation } from '@scopepilot2/contracts';
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

    // role 指定は service まで伝播する — session の無い role は 400 (適用の本体は UT で検証)。
    const ghostScan = await fetch(`${baseUrl}/api/run/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, confirmation, adopted, role: 'ghost' }),
    });
    assert.equal(ghostScan.status, 400);
    const ghostScanBody = (await ghostScan.json()) as { code: string; message: string };
    assert.equal(ghostScanBody.code, 'ValidationFailed');
    assert.match(ghostScanBody.message, /no session for role/);
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

  test('repeater は draft 作成・編集・hash 一致送信を API 経路で扱う (design/f04)', async () => {
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'repeater-it',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      }),
    });

    const created = await fetch(`${baseUrl}/api/repeater/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'http://fixture.target.test/page', protocol: 'http/1.1' }),
    });
    assert.equal(created.status, 201);
    const { draft } = (await created.json()) as { draft: { draftId: string; revision: number; planHash: string } };

    // 編集で revision と plan hash が進む。
    const editedResponse = await fetch(`${baseUrl}/api/repeater/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: draft.draftId, headers: [['X-Test', '1']], body: 'payload' }),
    });
    assert.equal(editedResponse.status, 200);
    const { draft: edited } = (await editedResponse.json()) as { draft: { revision: number; planHash: string } };
    assert.equal(edited.revision, 2);
    assert.notEqual(edited.planHash, draft.planHash);

    // 古い hash では送信されない。
    const stale = await fetch(`${baseUrl}/api/repeater/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: draft.draftId, confirmedPlanHash: draft.planHash }),
    });
    const staleBody = (await stale.json()) as { sent: boolean; reason?: string };
    assert.equal(staleBody.sent, false);
    assert.match(staleBody.reason ?? '', /does not match/);

    // 現行 hash では送信され、応答 summary が返る。
    const sent = await fetch(`${baseUrl}/api/repeater/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: draft.draftId, confirmedPlanHash: edited.planHash }),
    });
    const sentBody = (await sent.json()) as { sent: boolean; response?: { status: number; bodyPreview?: string }; attempt?: { outcome: string } };
    assert.equal(sentBody.sent, true);
    assert.equal(sentBody.response?.status, 200);
    assert.match(sentBody.response?.bodyPreview ?? '', /fixture response for/);
    assert.equal(sentBody.attempt?.outcome, 'responded');

    // 一覧に draft と attempt が載る。
    const list = (await (await fetch(`${baseUrl}/api/repeater`)).json()) as {
      drafts: readonly { draftId: string }[];
      attempts: readonly { draftId: string; outcome: string }[];
    };
    assert.ok(list.drafts.some((entry) => entry.draftId === draft.draftId));
    assert.ok(list.attempts.some((entry) => entry.draftId === draft.draftId));

    // scope 外 URL の draft は 403 OutOfScope。
    const outOfScope = await fetch(`${baseUrl}/api/repeater/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'http://elsewhere.example/', protocol: 'http/1.1' }),
    });
    assert.equal(outOfScope.status, 403);

    // role 指定の送信 — session が必要なため専用 service で検証する (design/08)。
    const executor = new (class implements LoginExecutorPort {
      readonly engineVersion = 'it-login-1';
      async execute(
        input: LoginExecutionInput,
      ): Promise<{ authenticated: boolean; finalUrl: string; cookies: readonly LoginSessionCookie[] }> {
        assert.equal(input.secretValues['vault://admin-pass'], 'password123');
        return { authenticated: true, finalUrl: 'http://fixture.target.test/', cookies: [{ name: 'PHPSESSID', value: 'it-session', domain: 'fixture.target.test', path: '/' }] };
      }
    })();
    const roleFlow = createTestService({ loginExecutor: executor });
    const roleServer = createCoreApiServer({ service: roleFlow.service, operator: TEST_OPERATOR });
    let roleBase = '';
    await new Promise<void>((resolve) => {
      roleServer.listen(0, '127.0.0.1', () => {
        const address = roleServer.address();
        if (address !== null && typeof address !== 'string') {
          roleBase = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
    const rolePost = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${roleBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      await rolePost('/api/case', {
        name: 'repeater-role-it',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      });
      await rolePost('/api/authorization', {
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['admin'],
        validFrom: '2026-10-18T00:00:00.000Z',
        validUntil: '2026-10-19T00:00:00.000Z',
        evidenceLabel: '認可(IT)',
        evidenceContent: 'it authorization evidence',
      });
      await rolePost('/api/sessions/flows', {
        role: 'admin',
        flowVersion: 'f1',
        steps: [
          { kind: 'navigate', target: 'http://fixture.target.test/login.php' },
          { kind: 'fill', target: '#u', secretReference: 'vault://admin-user' },
          { kind: 'fill', target: '#p', secretReference: 'vault://admin-pass' },
          { kind: 'click', target: 'input[type=submit]' },
          { kind: 'assert', target: 'Welcome' },
        ],
      });
      const login = await rolePost('/api/sessions/login', {
        role: 'admin',
        baseUrl: 'http://fixture.target.test',
        expectedUrlPrefix: 'http://fixture.target.test/',
        secretValues: { 'vault://admin-user': 'admin', 'vault://admin-pass': 'password123' },
      });
      assert.equal(login.status, 200);

      const roleDraft = (await (await rolePost('/api/repeater/drafts', { targetUrl: 'http://fixture.target.test/page', protocol: 'http/1.1' })).json()) as { draft: { draftId: string; planHash: string } };
      const roleSent = await rolePost('/api/repeater/send', { draftId: roleDraft.draft.draftId, confirmedPlanHash: roleDraft.draft.planHash, role: 'admin' });
      assert.equal(roleSent.status, 200);
      const roleSentBody = (await roleSent.json()) as { sent: boolean; sessionCookieNames?: readonly string[] };
      assert.equal(roleSentBody.sent, true);
      assert.deepEqual(roleSentBody.sessionCookieNames, ['PHPSESSID']);

      // session の無い role は 400。
      const ghost = await rolePost('/api/repeater/send', { draftId: roleDraft.draft.draftId, confirmedPlanHash: roleDraft.draft.planHash, role: 'ghost' });
      assert.equal(ghost.status, 400);
    } finally {
      await new Promise<void>((resolve, reject) => {
        roleServer.close(() => {
          resolve();
        });
        roleServer.closeAllConnections?.();
        setTimeout(() => reject(new Error('role server close timeout')), 2000);
      });
    }
  });

  test('fuzzer は payload 登録と組合せ実行 (cluster 集約) を API 経路で扱う (design/f05)', async () => {
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fuzzer-it',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      }),
    });

    // 供給元・版・license なしの登録は 400。
    const missing = await fetch(`${baseUrl}/api/fuzzer/payload-sets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', source: '', version: '1', license: 'MIT', sha256: 'a', values: ['v'] }),
    });
    assert.equal(missing.status, 400);
    const registered = await fetch(`${baseUrl}/api/fuzzer/payload-sets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'it-sqli', source: 'fixture-handbook', version: '1.0.0', license: 'MIT', sha256: 'a1b2c3', values: ["' OR '1'='1", "' OR '1'='2"] }),
    });
    assert.equal(registered.status, 201);
    const sets = (await (await fetch(`${baseUrl}/api/fuzzer/payload-sets`)).json()) as { sets: readonly { name: string; license: string }[] };
    assert.ok(sets.sets.some((set) => set.name === 'it-sqli' && set.license === 'MIT'));

    const run = await fetch(`${baseUrl}/api/fuzzer/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: 'http://fixture.target.test/fuzz',
        positions: [
          { name: 'user', values: ['admin', 'guest'] },
          { name: 'id', values: ['1', '2'] },
        ],
      }),
    });
    assert.equal(run.status, 200);
    const runBody = (await run.json()) as { total: number; sent: number; clusters: readonly { members: readonly number[]; representative: readonly string[] }[] };
    assert.equal(runBody.total, 4);
    assert.equal(runBody.sent, 4);
    assert.equal(runBody.clusters.length, 2, 'fixture 応答は先頭 position で集約');

    // 組合せ上限超過は 400。
    const overLimit = await fetch(`${baseUrl}/api/fuzzer/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: 'http://fixture.target.test/fuzz',
        positions: [
          { name: 'a', values: ['1', '2', '3', '4'] },
          { name: 'b', values: ['1', '2', '3', '4'] },
        ],
        maxRequests: 10,
      }),
    });
    assert.equal(overLimit.status, 400);

    // role 指定は service まで伝播する — session の無い role は 400 (適用の本体は UT で検証)。
    const ghostRole = await fetch(`${baseUrl}/api/fuzzer/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: 'http://fixture.target.test/fuzz',
        positions: [{ name: 'a', values: ['1'] }],
        role: 'ghost',
      }),
    });
    assert.equal(ghostRole.status, 400);
    const ghostBody = (await ghostRole.json()) as { code: string; message: string };
    assert.equal(ghostBody.code, 'ValidationFailed');
    assert.match(ghostBody.message, /no session for role/);

    // 実行は監査 event に残る。
    const eventsText = await (await fetch(`${baseUrl}/api/events`)).text();
    assert.match(eventsText, /FuzzRunCompleted/);
  });

  test('sessions は login flow 登録・refresh・cookie jar 割当を扱う (design/f09)', async () => {
    // secret 値の持ち込みは 400。fill は secret 参照必須 (NeedsInput)。
    const inline = await fetch(`${baseUrl}/api/sessions/flows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin', flowVersion: 'f1', steps: [{ kind: 'fill', target: '#u', secretReference: 'vault://a', secretValue: 'x' }] }),
    });
    assert.equal(inline.status, 400);
    const missingSecret = await fetch(`${baseUrl}/api/sessions/flows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin', flowVersion: 'f1', steps: [{ kind: 'fill', target: '#u' }] }),
    });
    assert.equal(missingSecret.status, 409, 'NeedsInput は 409');

    const registered = await fetch(`${baseUrl}/api/sessions/flows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'admin',
        flowVersion: 'f1',
        steps: [
          { kind: 'navigate', target: 'http://fixture.target.test/login.php' },
          { kind: 'fill', target: '#username', secretReference: 'vault://admin-user' },
          { kind: 'click', target: 'input[type=submit]' },
        ],
      }),
    });
    assert.equal(registered.status, 201);
    const flow = (await registered.json()) as { flow: { stepCount: number; secretReferences: readonly { secretReference: string }[] } };
    assert.equal(flow.flow.stepCount, 3);
    assert.equal(flow.flow.secretReferences[0]?.secretReference, 'vault://admin-user');
    assert.equal(JSON.stringify(flow).includes('secretValue'), false, '応答に secret 値を含まない');

    const refreshed = await fetch(`${baseUrl}/api/sessions/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    const refreshBody = (await refreshed.json()) as { outcome: string; sessionRevision: number };
    assert.equal(refreshBody.outcome, 'refreshed');
    assert.equal(refreshBody.sessionRevision, 1);

    const cookies = await fetch(`${baseUrl}/api/sessions/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin', cookieNames: ['PHPSESSID'] }),
    });
    assert.equal(cookies.status, 200);

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as { sessions: readonly { role: string; sessionRevision: number; cookieNames: readonly string[] }[] };
    const admin = list.sessions.find((session) => session.role === 'admin');
    assert.equal(admin?.sessionRevision, 1);
    assert.deepEqual(admin?.cookieNames, ['PHPSESSID']);
  });

  // 手書き fake: 認証済み session を返す login 実行器と、cookie 受渡しを記録する explorer
  // (design/f09 §4 の API 経路検証用。共有 service とは別の instance で組み立てる)。
  class ItLoginExecutor implements LoginExecutorPort {
    readonly engineVersion = 'it-login-1';
    async execute(
      input: LoginExecutionInput,
    ): Promise<{ authenticated: boolean; finalUrl: string; cookies: readonly LoginSessionCookie[] }> {
      assert.equal(input.secretValues['vault://admin-pass'], 'password123', 'executor は秘密値を受け取る');
      return {
        authenticated: true,
        finalUrl: 'http://fixture.target.test/index.php',
        cookies: [{ name: 'PHPSESSID', value: 'it-session-value', domain: 'fixture.target.test', path: '/' }],
      };
    }
  }

  class ItSessionExplorer implements ExplorationPort {
    readonly engineVersion = 'it-session-explorer-1';
    readonly sessionCookieNames: (readonly string[])[] = [];

    async observe(): Promise<PageObservation | null> {
      throw new Error('observe should not be called when a role session is given');
    }

    async observeWithSession(
      url: string,
      session: { readonly cookies: readonly LoginSessionCookie[] },
    ): Promise<PageObservation | null> {
      this.sessionCookieNames.push(session.cookies.map((cookie) => cookie.name));
      return {
        url,
        status: 200,
        contentType: 'text/html',
        discoveredFrom: null,
        depth: 0,
        originType: 'crawl',
        links: [],
        forms: [],
      };
    }
  }

  test('POST /api/sessions/login は login を実行し、role 指定探索が session を使う (design/f09 §4)', async () => {
    const explorer = new ItSessionExplorer();
    const flow = createTestService({ loginExecutor: new ItLoginExecutor(), explorer });
    const loginServer = createCoreApiServer({ service: flow.service, operator: TEST_OPERATOR });
    let loginBaseUrl = '';
    await new Promise<void>((resolve) => {
      loginServer.listen(0, '127.0.0.1', () => {
        const address = loginServer.address();
        if (address !== null && typeof address !== 'string') {
          loginBaseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
    const post = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${loginBaseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    try {
      await post('/api/case', {
        name: 'login-it',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      });
      await post('/api/authorization', {
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['admin'],
        validFrom: '2026-10-18T00:00:00.000Z',
        validUntil: '2026-10-19T00:00:00.000Z',
        evidenceLabel: '認可(IT)',
        evidenceContent: 'it authorization evidence',
      });
      await post('/api/sessions/flows', {
        role: 'admin',
        flowVersion: 'f1',
        steps: [
          { kind: 'navigate', target: 'http://fixture.target.test/login.php' },
          { kind: 'fill', target: '#username', secretReference: 'vault://admin-user' },
          { kind: 'fill', target: '#password', secretReference: 'vault://admin-pass' },
          { kind: 'click', target: 'input[type=submit]' },
          { kind: 'assert', target: 'Welcome' },
        ],
      });

      // 秘密値が 1 つでも欠ければ 409 NeedsInput。
      const missing = await post('/api/sessions/login', {
        role: 'admin',
        baseUrl: 'http://fixture.target.test',
        expectedUrlPrefix: 'http://fixture.target.test/',
        secretValues: { 'vault://admin-user': 'admin' },
      });
      assert.equal(missing.status, 409);

      const login = await post('/api/sessions/login', {
        role: 'admin',
        baseUrl: 'http://fixture.target.test',
        expectedUrlPrefix: 'http://fixture.target.test/',
        secretValues: { 'vault://admin-user': 'admin', 'vault://admin-pass': 'password123' },
      });
      assert.equal(login.status, 200);
      const loginBody = (await login.json()) as { authenticated: boolean; finalUrl: string; cookieNames: readonly string[] };
      assert.equal(loginBody.authenticated, true);
      assert.deepEqual(loginBody.cookieNames, ['PHPSESSID']);
      assert.equal(JSON.stringify(loginBody).includes('password123'), false, '応答に秘密値を含まない');
      assert.equal(JSON.stringify(loginBody).includes('it-session-value'), false, '応答に cookie 値を含まない');

      // 一覧には秘密値の参照名が出る (値は出ない)。
      const list = (await (await fetch(`${loginBaseUrl}/api/sessions`)).json()) as { sessions: readonly { role: string; secretReferences: readonly string[] }[] };
      const admin = list.sessions.find((session) => session.role === 'admin');
      assert.deepEqual(admin?.secretReferences, ['vault://admin-user', 'vault://admin-pass']);
      const listText = JSON.stringify(list);
      assert.equal(listText.includes('password123'), false);
      assert.equal(listText.includes('it-session-value'), false);

      // role 指定探索は保存済み session で観測する。
      const planResponse = await post('/api/plan/explore', { seeds: ['http://fixture.target.test/'] });
      const { plan } = (await planResponse.json()) as { plan: unknown };
      const confirmResponse = await post('/api/plan/confirm', { plan });
      const confirmation = (await confirmResponse.json()) as { confirmationId: string };
      const runResponse = await post('/api/run/explore', { plan, confirmation, maxDepth: 1, role: 'admin' });
      assert.equal(runResponse.status, 200);
      const run = (await runResponse.json()) as { runRecord: { state: string }; observations: readonly unknown[] };
      assert.equal(run.runRecord.state, 'Completed');
      assert.ok(run.observations.length > 0);
      assert.deepEqual(explorer.sessionCookieNames, [['PHPSESSID']], '探索は session cookie を explorer へ渡した');

      // 監査 event は参照のみ (F09-UT-006)。
      const eventsText = await (await fetch(`${loginBaseUrl}/api/events`)).text();
      assert.match(eventsText, /LoginCompleted/);
      assert.ok(eventsText.includes('vault://admin-user'));
      assert.equal(eventsText.includes('password123'), false);
      assert.equal(eventsText.includes('it-session-value'), false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        loginServer.close(() => {
          resolve();
        });
        loginServer.closeAllConnections?.();
        setTimeout(() => reject(new Error('login server close timeout')), 2000);
      });
    }
  });

  test('extensions は署名検証を通過した manifest だけを読み込む (design/f20)', async () => {
    const post = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const untrusted = await post('/api/extensions', { extensionId: 'bad', version: '1', signature: 's', publisherTrusted: false, permissions: [], apiRange: ['scopepilot2.api.v1'] });
    assert.equal(untrusted.status, 400);

    // fixture 信頼 root と同一規約の署名を組み立てる。
    const { hashStable } = await import('@scopepilot2/contracts');
    const manifestHash = hashStable('scopepilot2.extension.manifest', { extensionId: 'it-helper', version: '1.0.0', publisherTrusted: true, permissions: ['observations.read'], apiRange: ['scopepilot2.api.v1'] });
    const signature = `trusted-it-helper-1.0.0-${manifestHash.slice(0, 8)}`;
    const installed = await post('/api/extensions', { extensionId: 'it-helper', version: '1.0.0', signature, publisherTrusted: true, permissions: ['observations.read'], apiRange: ['scopepilot2.api.v1'] });
    assert.equal(installed.status, 201);
    const installedBody = (await installed.json()) as { loaded: boolean; extension: { extensionId: string } };
    assert.equal(installedBody.loaded, true);
    assert.equal(installedBody.extension.extensionId, 'it-helper');

    // secret read 権限の要求は署名が正しくても拒否 (値を返す権限は存在しない)。
    const greedyHash = hashStable('scopepilot2.extension.manifest', { extensionId: 'greedy', version: '1', publisherTrusted: true, permissions: ['secrets.read'], apiRange: ['scopepilot2.api.v1'] });
    const secretRead = await post('/api/extensions', { extensionId: 'greedy', version: '1', signature: `trusted-greedy-1-${greedyHash.slice(0, 8)}`, publisherTrusted: true, permissions: ['secrets.read'], apiRange: ['scopepilot2.api.v1'] });
    assert.equal(secretRead.status, 403, 'secret read 権限は 403 PermissionDenied');

    const list = (await (await fetch(`${baseUrl}/api/extensions`)).json()) as { extensions: readonly { extensionId: string }[] };
    assert.ok(list.extensions.some((extension) => extension.extensionId === 'it-helper'));
    const eventsText = await (await fetch(`${baseUrl}/api/events`)).text();
    assert.match(eventsText, /ExtensionInstalled/);
  });

  test('tools/dom-flows は観測から source→sink 候補を返す (design/f16)', async () => {
    const analyzed = await fetch(`${baseUrl}/api/tools/dom-flows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: 'http://fixture.target.test/app',
        observations: [
          { api: 'location.search', marker: 'q=1' },
          { api: 'innerHTML', marker: 'q=1' },
        ],
        nodes: [{ text: 'plain', looksLikePii: false }, { text: 'secret-mail', looksLikePii: true }],
      }),
    });
    assert.equal(analyzed.status, 200);
    const result = (await analyzed.json()) as { candidates: readonly { sourceApi: string; sinkApi: string; confidence: number }[]; evidence: readonly string[] };
    assert.deepEqual(result.candidates, [{ sourceApi: 'location.search', sinkApi: 'innerHTML', confidence: 0.9, marker: 'q=1' }]);
    assert.deepEqual(result.evidence, ['plain', '[redacted: potential PII]']);

    const outOfScope = await fetch(`${baseUrl}/api/tools/dom-flows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'http://elsewhere.example/app', observations: [] }),
    });
    assert.equal(outOfScope.status, 403);

    const roleWithoutLive = await fetch(`${baseUrl}/api/tools/dom-flows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'http://fixture.target.test/app', observations: [], role: 'admin' }),
    });
    assert.equal(roleWithoutLive.status, 400, 'role is explicit and cannot be silently ignored outside live mode');
  });

  test('tools/transport は選択と header 検証を扱う (design/f15)', async () => {
    const post = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const negotiated = await post('/api/tools/transport/negotiate', { targetUrl: 'http://fixture.target.test/api', allowFallback: false });
    assert.equal(negotiated.status, 200);
    const result = (await negotiated.json()) as { protocol: string; downgraded: boolean; alpn: string };
    assert.deepEqual(result, { protocol: 'h2', downgraded: false, alpn: 'h2', runtime: 'fixture-transport' });

    const explicitH1 = await post('/api/tools/transport/negotiate', {
      targetUrl: 'http://fixture.target.test/api',
      requested: 'http/1.1',
      allowFallback: false,
    });
    assert.equal(explicitH1.status, 200);
    assert.deepEqual(await explicitH1.json(), {
      protocol: 'http/1.1',
      downgraded: false,
      alpn: 'http/1.1 (explicit)',
      runtime: 'fixture-transport',
    });

    const noFallback = await post('/api/tools/transport/negotiate', { targetUrl: 'http://fixture.target.test/h1-only', allowFallback: false });
    assert.equal(noFallback.status, 503);

    const validated = await post('/api/tools/transport/validate-headers', {
      headers: [[':method', 'GET'], [':scheme', 'http'], [':authority', 'fixture.target.test'], [':path', '/'], ['x-a', '1']],
      scheme: 'http',
    });
    assert.equal(validated.status, 200);
    const validation = (await validated.json()) as { ordered: readonly string[]; authority: string };
    assert.deepEqual(validation.ordered, [':method', ':scheme', ':authority', ':path']);

    const badHeaders = await post('/api/tools/transport/validate-headers', { headers: [['x-a', '1'], [':method', 'GET']], scheme: 'http' });
    assert.equal(badHeaders.status, 400);

    const eventsText = await (await fetch(`${baseUrl}/api/events`)).text();
    assert.match(eventsText, /TransportNegotiated/);
  });

  test('websocket は frame 取込・送信・一覧を扱う (design/f14)', async () => {
    const post = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const imported = await post('/api/websocket/frames', {
      targetUrl: 'http://fixture.target.test/ws',
      frames: [
        { direction: 'received', payload: 'hello' },
        { direction: 'received', payload: 'hello' },
      ],
    });
    assert.equal(imported.status, 200);
    const importBody = (await imported.json()) as { imported: number; duplicates: number };
    assert.deepEqual(importBody, { imported: 1, duplicates: 1 });

    const sent = await post('/api/websocket/send', {
      targetUrl: 'http://fixture.target.test/ws',
      messages: ['ping', 'pong'],
      subprotocols: ['scopepilot.echo', 'json-v2'],
    });
    assert.equal(sent.status, 200);
    const sentBody = (await sent.json()) as { sent: number; rejected: string | null; planHash: string };
    assert.equal(sentBody.sent, 2);
    assert.equal(sentBody.rejected, null);
    assert.match(sentBody.planHash, /^[0-9a-f]{64}$/);

    const badSubprotocol = await post('/api/websocket/send', {
      targetUrl: 'http://fixture.target.test/ws',
      messages: ['invalid'],
      subprotocols: ['bad protocol'],
    });
    assert.equal(badSubprotocol.status, 400);

    const missingRole = await post('/api/websocket/send', {
      targetUrl: 'http://fixture.target.test/ws',
      messages: ['authenticated'],
      role: 'missing-websocket-role',
    });
    assert.equal(missingRole.status, 400, 'role field is forwarded and requires a completed login session');

    const badDirection = await post('/api/websocket/frames', { targetUrl: 'http://fixture.target.test/ws', frames: [{ direction: 'sideways', payload: 'x' }] });
    assert.equal(badDirection.status, 400);

    const list = (await (await fetch(`${baseUrl}/api/websocket/frames`)).json()) as { frames: readonly { direction: string; text: string; rawHash: string }[] };
    assert.ok(list.frames.some((frame) => frame.direction === 'sent' && frame.text === 'ping'));
    assert.ok(list.frames.every((frame) => frame.rawHash.length === 12));

    const eventsText = await (await fetch(`${baseUrl}/api/events`)).text();
    assert.match(eventsText, /WsFramesImported/);
    assert.match(eventsText, /WsMessagesSent/);
  });

  test('oast は token 発行・callback 記録・attempt 一覧を扱う (design/f13)', async () => {
    const post = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const unsupported = await post('/api/oast/attempts', { targetUrl: 'http://fixture.target.test/x', protocol: 'smtp' });
    assert.equal(unsupported.status, 503, '非対応 protocol は CapabilityUnavailable');

    const started = await post('/api/oast/attempts', { targetUrl: 'http://fixture.target.test/xss', protocol: 'http' });
    assert.equal(started.status, 201);
    const attempt = (await started.json()) as { attemptId: string; token: string };
    assert.match(attempt.token, /^oast-/);

    const recorded = await post('/api/oast/callbacks', {
      events: [
        { eventId: 'oast-ev-1', token: attempt.token, payload: 'interaction' },
        { eventId: 'oast-unknown', token: 'oast-not-ours', payload: 'noise' },
      ],
    });
    assert.equal(recorded.status, 200);
    const counts = (await recorded.json()) as { kept: number; correlated: number; uncorrelated: number };
    assert.deepEqual(counts, { kept: 2, duplicates: 0, correlated: 1, uncorrelated: 1 });

    const list = (await (await fetch(`${baseUrl}/api/oast/attempts`)).json()) as { attempts: readonly { attemptId: string; status: string; interactions: number; candidateOnly: boolean }[] };
    const entry = list.attempts.find((candidate) => candidate.attemptId === attempt.attemptId);
    assert.equal(entry?.status, 'waiting');
    assert.equal(entry?.interactions, 1);
    assert.equal(JSON.stringify(list).includes(attempt.token), false, '一覧に token を出さない');

    const eventsText = await (await fetch(`${baseUrl}/api/events`)).text();
    assert.match(eventsText, /OastAttemptStarted/);
    assert.match(eventsText, /OastCallbacksRecorded/);
  });

  test('import/api-spec は OpenAPI 仕様から endpoint を返す (design/f12)', async () => {
    const imported = await fetch(`${baseUrl}/api/import/api-spec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentLabel: 'IT API 仕様', document: {"openapi": "3.1.0", "servers": [{"url": "http://fixture.target.test/api"}, {"url": "http://elsewhere.example/api"}], "paths": {"/users": {"get": {}, "post": {}}, "/users/{id}": {"get": {}}}} }),
    });
    assert.equal(imported.status, 200);
    const result = (await imported.json()) as { servers: readonly string[]; excludedServers: readonly string[]; endpoints: readonly { method: string; url: string }[]; warnings: readonly string[] };
    assert.deepEqual(result.servers, ['http://fixture.target.test/api']);
    assert.deepEqual(result.excludedServers, ['http://elsewhere.example/api']);
    assert.equal(result.endpoints.length, 3);
    assert.ok(result.endpoints.some((endpoint) => endpoint.url === 'http://fixture.target.test/api/users' && endpoint.method === 'POST'));
    assert.equal(result.warnings.length, 1);

    const malformed = await fetch(`${baseUrl}/api/import/api-spec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentLabel: 'x', document: { nope: true } }),
    });
    assert.equal(malformed.status, 400);

    const list = (await (await fetch(`${baseUrl}/api/import/api-spec`)).json()) as { imports: readonly { documentLabel: string; endpointCount: number }[] };
    assert.ok(list.imports.some((entry) => entry.documentLabel === 'IT API 仕様' && entry.endpointCount === 3));
    const eventsText = await (await fetch(`${baseUrl}/api/events`)).text();
    assert.match(eventsText, /ApiSpecImported/);
  });

  test('tools/sequencer は token 統計を返し、token 原文を出さない (design/f07)', async () => {
    const run = await fetch(`${baseUrl}/api/tools/sequencer/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'http://fixture.target.test/session-token', samples: 40 }),
    });
    assert.equal(run.status, 200);
    const result = (await run.json()) as { tokenSource: string; verdict: string; sampleCount: number; duplicates: number; missing: number; shannonEntropyBitsPerByte?: number };
    assert.equal(result.verdict, 'assessed');
    assert.equal(result.tokenSource, 'body');
    assert.equal(result.sampleCount, 40);
    assert.equal(JSON.stringify(result).includes('token=sample-'), false, 'token 原文は応答に出ない');

    const cookieRun = await fetch(`${baseUrl}/api/tools/sequencer/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'http://fixture.target.test/session-token', samples: 30, tokenSource: 'cookie', tokenCookieName: 'SEQ_TOKEN' }),
    });
    assert.equal(cookieRun.status, 200);
    const cookieResult = (await cookieRun.json()) as { tokenSource: string; tokenCookieName?: string; sampleCount: number };
    assert.equal(cookieResult.tokenSource, 'cookie');
    assert.equal(cookieResult.tokenCookieName, 'SEQ_TOKEN');
    assert.equal(cookieResult.sampleCount, 30);
    assert.equal(JSON.stringify(cookieResult).includes('sample-'), false, 'cookie token 原文は応答に出ない');

    const invalidCookieName = await fetch(`${baseUrl}/api/tools/sequencer/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'http://fixture.target.test/session-token', samples: 30, tokenSource: 'cookie', tokenCookieName: 'bad name' }),
    });
    assert.equal(invalidCookieName.status, 400);

    const invalidCookieNameType = await fetch(`${baseUrl}/api/tools/sequencer/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'http://fixture.target.test/session-token', samples: 30, tokenSource: 'cookie', tokenCookieName: 123 }),
    });
    assert.equal(invalidCookieNameType.status, 400);

    const invalidSource = await fetch(`${baseUrl}/api/tools/sequencer/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'http://fixture.target.test/session-token', samples: 30, tokenSource: 'header' }),
    });
    assert.equal(invalidSource.status, 400);

    const boundary = await fetch(`${baseUrl}/api/tools/sequencer/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'http://fixture.target.test/x', samples: 10 }),
    });
    assert.equal(boundary.status, 400);

    const missingRole = await fetch(`${baseUrl}/api/tools/sequencer/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'http://fixture.target.test/session-token', samples: 30, role: 'missing-sequencer-role' }),
    });
    assert.equal(missingRole.status, 400, 'role field is forwarded and requires a completed login session');

    const list = (await (await fetch(`${baseUrl}/api/tools/sequencer/runs`)).json()) as { sessions: readonly { sessionId: string; tokenSource: string; tokenCookieName?: string }[] };
    assert.ok(list.sessions.length >= 1);
    assert.ok(list.sessions.some((session) => session.tokenSource === 'cookie' && session.tokenCookieName === 'SEQ_TOKEN'));
    const eventsText = await (await fetch(`${baseUrl}/api/events`)).text();
    assert.match(eventsText, /SequencerSessionCompleted/);
  });

  test('documents/hints は hint を登録し、探索計画と観測の由来へ統合する (AGENTS.md)', async () => {
    const post = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    // 他 test と同様、この test 用の案件と認可を用意する。
    await post('/api/case', {
      name: 'doc-hints-it',
      allowedOrigins: ['http://fixture.target.test'],
      deniedOrigins: [],
      limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
    });
    await post('/api/authorization', {
      allowedOperationClasses: ['Browse', 'ActiveScan'],
      targetRoles: ['unauthenticated'],
      validFrom: '2026-10-18T00:00:00.000Z',
      validUntil: '2026-10-19T00:00:00.000Z',
      evidenceLabel: '認可(IT)',
      evidenceContent: 'it authorization evidence',
    });

    // 許可外 URL を混ぜて登録 — acceptedUrlCount は許可内のみ計上。
    const registered = await post('/api/documents/hints', {
      documentLabel: 'API 仕様書 (IT)',
      urls: ['http://fixture.target.test/setup.php', 'http://elsewhere.example/admin'],
    });
    assert.equal(registered.status, 201);
    const registration = (await registered.json()) as { documentLabel: string; urlCount: number; acceptedUrlCount: number };
    assert.deepEqual(registration, { documentLabel: 'API 仕様書 (IT)', urlCount: 2, acceptedUrlCount: 1 });

    const empty = await post('/api/documents/hints', { documentLabel: 'x', urls: [] });
    assert.equal(empty.status, 400);

    const list = (await (await fetch(`${baseUrl}/api/documents/hints`)).json()) as { hints: readonly { documentLabel: string; urls: readonly string[] }[] };
    assert.equal(list.hints[0]?.documentLabel, 'API 仕様書 (IT)');

    // 計画の target snapshot に許可内 hint だけ統合される。
    const planResponse = await post('/api/plan/explore', { seeds: ['http://fixture.target.test/'] });
    const { plan } = (await planResponse.json()) as { plan: { steps: readonly { targetSnapshot: readonly string[] }[] } };
    assert.deepEqual(plan.steps[0]?.targetSnapshot, ['http://fixture.target.test/', 'http://fixture.target.test/setup.php']);
    const confirmResponse = await post('/api/plan/confirm', { plan });
    const confirmation = (await confirmResponse.json()) as { confirmationId: string };
    const runResponse = await post('/api/run/explore', { plan, confirmation, maxDepth: 1 });
    assert.equal(runResponse.status, 200);

    // 観測の由来は文書ヒント (未確認) として残る。
    const observations = (await (await fetch(`${baseUrl}/api/observations`)).json()) as { observations: readonly { url: string; originType: string }[] };
    assert.equal(observations.observations.find((observation) => observation.url === 'http://fixture.target.test/setup.php')?.originType, 'document-hint');
    assert.equal(observations.observations.find((observation) => observation.url === 'http://fixture.target.test/')?.originType, 'crawl');

    const eventsText = await (await fetch(`${baseUrl}/api/events`)).text();
    assert.match(eventsText, /DocumentHintsRegistered/);
  });

  test('certificates/ca は profile 一覧と信頼登録状態を扱う (design/24)', async () => {
    const list = (await (await fetch(`${baseUrl}/api/certificates/ca`)).json()) as { profiles: readonly { profileId: string; trusted: boolean; fingerprint: string }[] };
    assert.equal(list.profiles.length, 1);
    assert.equal(list.profiles[0]?.profileId, 'scopepilot2-diagnostics');
    assert.equal(list.profiles[0]?.trusted, false);

    const changed = await fetch(`${baseUrl}/api/certificates/ca/trust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'scopepilot2-diagnostics', trusted: true }),
    });
    assert.equal(changed.status, 200);
    const after = (await (await fetch(`${baseUrl}/api/certificates/ca`)).json()) as { profiles: readonly { trusted: boolean }[] };
    assert.equal(after.profiles[0]?.trusted, true);

    const unknown = await fetch(`${baseUrl}/api/certificates/ca/trust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'ghost', trusted: true }),
    });
    assert.equal(unknown.status, 400);
    const eventsText = await (await fetch(`${baseUrl}/api/events`)).text();
    assert.match(eventsText, /CaProfileTrustChanged/);
  });

  test('documents/parameter-hints は parameter バリエーションを登録・一覧する (AGENTS.md)', async () => {
    const post = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const emptyValues = await post('/api/documents/parameter-hints', { documentLabel: 'x', parameters: [{ name: 'a', values: [] }] });
    assert.equal(emptyValues.status, 400);

    const registered = await post('/api/documents/parameter-hints', {
      documentLabel: 'IT API 仕様',
      parameters: [{ name: 'user', values: ['admin', 'guest'] }],
    });
    assert.equal(registered.status, 201);
    const registration = (await registered.json()) as { documentLabel: string; parameterCount: number };
    assert.deepEqual(registration, { documentLabel: 'IT API 仕様', parameterCount: 1 });

    const list = (await (await fetch(`${baseUrl}/api/documents/parameter-hints`)).json()) as { hints: readonly { documentLabel: string; parameters: readonly { name: string; values: readonly string[] }[] }[] };
    assert.deepEqual(list.hints[0]?.parameters[0], { name: 'user', values: ['admin', 'guest'] });
    const eventsText = await (await fetch(`${baseUrl}/api/events`)).text();
    assert.match(eventsText, /DocumentParameterHintsRegistered/);
  });

  test('documents/priority-hints は探索の処理順に優先を反映する (AGENTS.md)', async () => {
    const post = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const badCategory = await post('/api/documents/priority-hints', { documentLabel: 'x', rules: [{ urlIncludes: '/a', category: 'other' }] });
    assert.equal(badCategory.status, 400);

    const registered = await post('/api/documents/priority-hints', {
      documentLabel: 'IT 手順書',
      rules: [{ urlIncludes: '/login.php', category: 'pii' }],
    });
    assert.equal(registered.status, 201);
    const registration = (await registered.json()) as { documentLabel: string; ruleCount: number };
    assert.deepEqual(registration, { documentLabel: 'IT 手順書', ruleCount: 1 });

    const list = (await (await fetch(`${baseUrl}/api/documents/priority-hints`)).json()) as { rules: readonly { urlIncludes: string; category: string }[] };
    assert.deepEqual(list.rules, [{ urlIncludes: '/login.php', category: 'pii' }]);

    const eventsText = await (await fetch(`${baseUrl}/api/events`)).text();
    assert.match(eventsText, /DocumentPriorityHintsRegistered/);
  });

  test('documents/auth-hints は認証情報の所在を登録・一覧する (AGENTS.md・design/08)', async () => {
    const post = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const inlineSecret = await post('/api/documents/auth-hints', {
      documentLabel: 'API 仕様書',
      entries: [{ role: 'admin', authMethod: 'Form', documentLocation: 'p.1', secretValue: 'x' }],
    });
    assert.equal(inlineSecret.status, 400, '秘密値の持込みは拒否');

    const badMethod = await post('/api/documents/auth-hints', {
      documentLabel: 'API 仕様書',
      entries: [{ role: 'admin', authMethod: 'OAuth', documentLocation: 'p.1' }],
    });
    assert.equal(badMethod.status, 400);

    const registered = await post('/api/documents/auth-hints', {
      documentLabel: 'API 仕様書 (IT)',
      entries: [
        { role: 'admin', authMethod: 'Form', documentLocation: 'p.13 管理者ログイン' },
        { role: 'api-client', authMethod: 'ApiKey', documentLocation: '付録 B' },
      ],
    });
    assert.equal(registered.status, 201);
    const registration = (await registered.json()) as { documentLabel: string; entryCount: number };
    assert.deepEqual(registration, { documentLabel: 'API 仕様書 (IT)', entryCount: 2 });

    const list = (await (await fetch(`${baseUrl}/api/documents/auth-hints`)).json()) as {
      hints: readonly { documentLabel: string; entries: readonly { role: string; authMethod: string; documentLocation: string }[] }[];
    };
    assert.equal(list.hints[0]?.documentLabel, 'API 仕様書 (IT)');
    assert.deepEqual(list.hints[0]?.entries[0], { role: 'admin', authMethod: 'Form', documentLocation: 'p.13 管理者ログイン' });

    const eventsText = await (await fetch(`${baseUrl}/api/events`)).text();
    assert.match(eventsText, /DocumentAuthHintsRegistered/);
  });

  test('business-logic check は role 差分検証を inconclusive/pass/fail で返す (design/f17)', async () => {
    const post = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    await post('/api/case', {
      name: 'bizlogic-it',
      allowedOrigins: ['http://fixture.target.test'],
      deniedOrigins: [],
      limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
    });
    // CrossRoleTest を許可する認可。
    await post('/api/authorization', {
      allowedOperationClasses: ['Browse', 'ActiveScan', 'CrossRoleTest'],
      targetRoles: ['admin', 'guest'],
      validFrom: '2026-10-18T00:00:00.000Z',
      validUntil: '2026-10-19T00:00:00.000Z',
      evidenceLabel: '認可(IT)',
      evidenceContent: 'it authorization evidence',
    });
    const steps = [{ kind: 'navigate', target: 'http://fixture.target.test/login.php' }];
    await post('/api/sessions/flows', { role: 'admin', flowVersion: 'f1', steps });
    await post('/api/sessions/flows', { role: 'guest', flowVersion: 'f1', steps });
    await post('/api/sessions/refresh', { role: 'admin' });
    await post('/api/sessions/refresh', { role: 'guest' });

    // 期待と一致すれば pass。
    const pass = await post('/api/business-logic/checks', {
      roles: ['admin', 'guest'],
      targetUrl: 'http://fixture.target.test/admin-only',
      expectation: { expression: 'body.contains', args: ['business-response:admin'] },
    });
    assert.equal(pass.status, 200);
    const passBody = (await pass.json()) as { status: string; comparison: { outcome: string }; matrix: { evidenceSeparated: boolean } };
    assert.equal(passBody.comparison.outcome, 'pass');
    assert.equal(passBody.status, 'pass');
    assert.equal(passBody.matrix.evidenceSeparated, true);

    // 期待と不一致なら fail + restore-failed。
    const fail = await post('/api/business-logic/checks', {
      roles: ['admin', 'guest'],
      targetUrl: 'http://fixture.target.test/admin-only',
      expectation: { expression: 'body.contains', args: ['business-response:guest'] },
    });
    const failBody = (await fail.json()) as { status: string; comparison: { outcome: string }; restore: { outcome: string } };
    assert.equal(failBody.comparison.outcome, 'fail');
    assert.equal(failBody.restore.outcome, 'restore-failed');

    // allowlist 外 expression は 400。履歴と監査に残る。
    const bad = await post('/api/business-logic/checks', {
      roles: ['admin', 'guest'],
      targetUrl: 'http://fixture.target.test/admin-only',
      expectation: { expression: 'eval.js', args: [] },
    });
    assert.equal(bad.status, 400);
    const history = (await (await fetch(`${baseUrl}/api/business-logic/checks`)).json()) as { checks: readonly { checkId: string; status: string }[] };
    assert.equal(history.checks.length, 2);
    const eventsText = await (await fetch(`${baseUrl}/api/events`)).text();
    assert.match(eventsText, /BusinessLogicCheckCompleted/);
  });

  test('GET /api/traffic は通信一覧と endpoint 集約を返す (design/f03)', async () => {
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'traffic-it',
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
    const confirmation = (await (await fetch(`${baseUrl}/api/plan/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    })).json()) as { confirmationId: string };
    await fetch(`${baseUrl}/api/run/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, confirmation, maxDepth: 1 }),
    });

    const trafficResponse = await fetch(`${baseUrl}/api/traffic?limit=50`);
    assert.equal(trafficResponse.status, 200);
    const traffic = (await trafficResponse.json()) as { mode: string; total: number; entries?: readonly { url: string; source: string }[] };
    assert.equal(traffic.mode, 'list');
    assert.ok(traffic.total > 0);
    assert.ok((traffic.entries ?? []).length > 0);

    // endpoint 集約 (query 同一視) と limit 検証。
    const endpoints = (await (await fetch(`${baseUrl}/api/traffic/site-map`)).json()) as { endpoints: readonly { path: string; observedUrls: number }[] };
    assert.ok(endpoints.endpoints.length > 0);
    const badLimit = await fetch(`${baseUrl}/api/traffic?limit=501`);
    assert.equal(badLimit.status, 400);
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
