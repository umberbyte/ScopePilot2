import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { PageObservation, RunRecord } from '@scopepilot2/contracts';
import {
  BaselineFlowService,
  createCoreApiServer,
  FixedClock,
  InMemoryEvidenceStore,
  SequentialIdGenerator,
  type ActiveScanEnginePort,
  type ExplorationPort,
  type StoredEvidence,
} from '@scopepilot2/core';
import { CaseRepository, migrate, openDatabase, RunRepository } from '../../src/index.ts';
import type { DatabaseSync } from 'node:sqlite';

/** core の unit test と同じ最小 fake (呼出し記録と固定結果だけ)。 */
const fakeExplorer: ExplorationPort = {
  engineVersion: 'fake-explorer-1',
  async observe(url: string): Promise<PageObservation | null> {
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
  },
};

const fakeScanEngine: ActiveScanEnginePort = {
  engineVersion: 'fake-zap-1',
  async start() {
    return 'fake-run-1';
  },
  async progress() {
    return { status: 'complete', progress: 100, lastActivityAt: '', messageCount: 0 };
  },
  async alerts(_id: string, cursor: number) {
    return { alerts: [], nextCursor: cursor };
  },
  async stop() {},
};

const operator = {
  operatorId: 'operator-it',
  displayName: 'IT Operator',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'] as const,
};

describe('run persistence end-to-end (SQLite + Core API)', () => {
  let dir: string;
  let db: DatabaseSync;
  let runRepository: RunRepository;
  let server: ReturnType<typeof createCoreApiServer>;
  let baseUrl: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'scopepilot2-runpersistence-'));
    db = openDatabase(join(dir, 'scopepilot.db'));
    migrate(db);
    runRepository = new RunRepository(db);
    const service = new BaselineFlowService({
      runtimeProfile: 'test',
      clock: new FixedClock(['2026-10-18T09:00:00.000Z']),
      ids: new SequentialIdGenerator(),
      evidence: new InMemoryEvidenceStore(),
      explorer: fakeExplorer,
      scanEngine: fakeScanEngine,
      capabilities: [
        {
          engineKind: 'playwright',
          engineVersion: 'fake-explorer-1',
          source: 'fixture',
          guaranteeLevels: { preSendScopeEnforcement: 'Enforced', stopControl: 'Enforced', budgetLease: 'Enforced', rateLimit: 'Enforced' },
          maxOvershootRatio: 0,
          measuredAt: '2026-10-18T09:00:00.000Z',
        },
      ],
      runtimeBundleHash: 'it-runtime-bundle',
      runSink: { save: (record: RunRecord) => runRepository.save(record) },
    });
    new CaseRepository(db).save({
      caseId: 'case-0001',
      name: 'persistence-it',
      revision: 1,
      scope: { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [], limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 } },
      createdAt: '2026-10-18T09:00:00.000Z',
    });
    server = createCoreApiServer({ service, operator, runRepository });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected tcp address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections?.();
    });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('API 実行の run が SQLite へ保存され、Interrupted 検出は冪等', async () => {
    await fetch(`${baseUrl}/api/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'persistence-it',
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
        evidenceContent: 'x',
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
    const confirmation = (await confirmResponse.json()) as object;
    const runResponse = await fetch(`${baseUrl}/api/run/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, confirmation, maxDepth: 1 }),
    });
    assert.equal(runResponse.status, 200);
    const run = (await runResponse.json()) as { runRecord: { runId: string; state: string } };

    // 完了 run は Interrupted 対象外。
    const none = await fetch(`${baseUrl}/api/runs/interrupted`);
    const noneBody = (await none.json()) as { interrupted: readonly unknown[] };
    assert.equal(noneBody.interrupted.length, 0);

    // 残置 Running を人為的に保存し、検出 → Interrupted 化 → 冪等を検証。
    runRepository.save({ runId: 'run-orphan', planId: 'plan-x', caseId: 'case-0001', state: 'Running', attempt: 1 });
    const first = await fetch(`${baseUrl}/api/runs/interrupted`);
    const firstBody = (await first.json()) as { interrupted: readonly { runId: string; state: string }[] };
    assert.deepEqual(
      firstBody.interrupted.map((entry) => [entry.runId, entry.state]),
      [['run-orphan', 'Interrupted']],
    );
    const second = await fetch(`${baseUrl}/api/runs/interrupted`);
    const secondBody = (await second.json()) as { interrupted: readonly unknown[] };
    assert.equal(secondBody.interrupted.length, 0);

    // 再オープン後も完了/Interrupted 状態は保持される。
    assert.equal(runRepository.get(run.runRecord.runId)?.state, 'Completed');
    assert.equal(runRepository.get('run-orphan')?.state, 'Interrupted');
  });
});
