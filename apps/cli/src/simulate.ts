/**
 * `scopepilot simulate` command。`docs/design/19-cli-automation.md` §2・§5。
 * 固定 fixture 上で基準シナリオ (探索→能動診断→所見→報告) を完走させ、
 * 終了コード・監査 event・版情報を返す (F21-UT-009)。
 *
 * Core API HTTP 契約 (design/18, 19 §3) 経由で実行する。A0 は CLI 自身が
 * simulation harness を in-process で host し、127.0.0.1 の ephemeral port へ
 * loopback 通信する (外部ネットワークに出ない)。
 */
import type { Server } from 'node:http';
import type {
  BaselineFlowEvent,
  DomainErrorCode,
  ExecutionPlan,
  Finding,
  PageObservation,
  PlanConfirmation,
  ReportArtifact,
  ScanCandidate,
} from '@scopepilot2/contracts';
import { createCoreApiServer } from '@scopepilot2/core';
import {
  createHarness,
  FIXTURE_NUCLEI_JSONL,
  FIXTURE_NUCLEI_VERSION,
  FIXTURE_OPERATOR,
  SITE_ORIGIN,
} from '@scopepilot2/simulation';
import { exitCodeForDomainError, ExitCodes } from './exit-codes.ts';

export interface SimulateSummary {
  readonly schemaVersion: 'scopepilot2.simulate.v1';
  readonly command: 'simulate';
  readonly status: 'completed' | 'failed';
  readonly exitCode: number;
  readonly caseId: string;
  readonly explorePlanHash: string;
  readonly scanPlanHash: string;
  readonly reportModelHash: string;
  readonly exploredCount: number;
  readonly scannedCount: number;
  readonly findingsCount: number;
  readonly importedCount: number;
  readonly duplicateCount: number;
  readonly engineVersions: { readonly explorer: string; readonly zap: string; readonly nuclei: string };
  readonly capabilityFixtureHashes: {
    readonly playwright?: string;
    readonly zap?: string;
    readonly nuclei?: string;
  };
  readonly eventsCount: number;
  readonly failure?: { readonly code: string; readonly message: string };
}

export interface SimulateOutcome {
  readonly exitCode: number;
  readonly summary: SimulateSummary;
  readonly events: readonly BaselineFlowEvent[];
}

/** `apiUrl` 指定時は in-process server を立てず、指定の Core API へ接続する。 */
export interface SimulateOptions {
  readonly injectUnknownScanTarget?: boolean;
  readonly apiUrl?: string;
}

/** Core API の domain error (HTTP error body)。終了 code へは同じ DomainErrorCode 規約で写す。 */
class CoreApiError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const DOMAIN_ERROR_CODES: ReadonlySet<string> = new Set([
  'ValidationFailed',
  'PermissionDenied',
  'OutOfScope',
  'ConfirmationRequired',
  'Conflict',
  'CapabilityUnavailable',
  'NeedsInput',
  'Unsupported',
  'EngineFailure',
  'Cancelled',
]);

export async function runSimulate(options: SimulateOptions = {}): Promise<SimulateOutcome> {
  if (options.apiUrl !== undefined) {
    return runOnceOverApi(options.apiUrl.replace(/\/$/, ''), options);
  }
  const harness = createHarness();
  const server = createCoreApiServer({ service: harness.service, operator: FIXTURE_OPERATOR });
  try {
    await listenLoopback(server);
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP address for the core api server');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return await runOnceOverApi(baseUrl, options);
  } finally {
    await closeServer(server);
  }
}

/** 1 実行分: Core API の domain error を終了 code/summary へ写す。 */
async function runOnceOverApi(baseUrl: string, options: SimulateOptions): Promise<SimulateOutcome> {
  try {
    return await runScenarioOverApi(baseUrl, options);
  } catch (cause) {
    if (!(cause instanceof CoreApiError)) {
      throw cause;
    }
    const exitCode = exitCodeForDomainError(cause.code);
    const summary: SimulateSummary = {
      schemaVersion: 'scopepilot2.simulate.v1',
      command: 'simulate',
      status: 'failed',
      exitCode,
      caseId: '',
      explorePlanHash: '',
      scanPlanHash: '',
      reportModelHash: '',
      exploredCount: 0,
      scannedCount: 0,
      findingsCount: 0,
      importedCount: 0,
      duplicateCount: 0,
      engineVersions: { explorer: '', zap: '', nuclei: '' },
      capabilityFixtureHashes: {},
      eventsCount: 0,
      failure: { code: cause.code, message: cause.message },
    };
    return { exitCode, summary, events: [] };
  }
}

async function runScenarioOverApi(baseUrl: string, options: SimulateOptions): Promise<SimulateOutcome> {
  // 1. 案件作成
  const caseRecord = await callApi<{ caseId: string }>(baseUrl, 'POST', '/api/case', {
    name: 'Fixture 基準シナリオ案件',
    allowedOrigins: [SITE_ORIGIN],
    deniedOrigins: [],
    limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
  });

  // 2. 認可
  await callApi(baseUrl, 'POST', '/api/authorization', {
    allowedOperationClasses: ['Browse', 'ActiveScan'],
    targetRoles: ['unauthenticated'],
    validFrom: '2026-10-18T00:00:00.000Z',
    validUntil: '2026-10-19T00:00:00.000Z',
    evidenceLabel: '認可証跡(fixture)',
    evidenceContent: 'fixture authorization evidence; no secrets',
  });

  // 3. 探索計画 → 検証・認可結び付け → 確認 → 実行
  const explorePlan = await callApi<{ plan: ExecutionPlan; planHash: string }>(baseUrl, 'POST', '/api/plan/explore', {
    seeds: [`${SITE_ORIGIN}/`],
  });
  const exploreConfirmation = await callApi<PlanConfirmation>(baseUrl, 'POST', '/api/plan/confirm', { plan: explorePlan.plan });
  const exploration = await callApi<{
    observations: readonly PageObservation[];
    candidates: readonly ScanCandidate[];
    engineVersion: string;
  }>(baseUrl, 'POST', '/api/run/explore', {
    plan: explorePlan.plan,
    confirmation: exploreConfirmation,
    maxDepth: 2,
  });

  // 4. 候補の採用 (基準シナリオでは全採用)
  const { adopted } = await callApi<{ adopted: readonly ScanCandidate[] }>(baseUrl, 'POST', '/api/candidates/adopt', {
    candidates: exploration.candidates,
  });

  // 5. 能動診断計画 → 検証・認可結び付け → 確認 → 実行 → 取込
  const scanTargets = adopted.map((candidate) => candidate.url);
  if (options.injectUnknownScanTarget === true) {
    scanTargets.push(`${SITE_ORIGIN}/not-in-context.php`);
  }
  const scanPlan = await callApi<{ plan: ExecutionPlan; planHash: string }>(baseUrl, 'POST', '/api/plan/scan', {
    targets: scanTargets,
  });
  const scanConfirmation = await callApi<PlanConfirmation>(baseUrl, 'POST', '/api/plan/confirm', { plan: scanPlan.plan });
  const activeScan = await callApi<{
    scanRequest: { targets: readonly string[] };
    findings: readonly Finding[];
    engineVersion: string;
  }>(baseUrl, 'POST', '/api/run/scan', {
    plan: scanPlan.plan,
    confirmation: scanConfirmation,
    adopted,
  });

  // 6. Nuclei 結果 (供給済み JSONL) の取込。engine 実行ではなく観測出力の取込経路 (f18)。
  const nucleiImport = await callApi<{
    findings: readonly Finding[];
    importedCount: number;
    duplicateCount: number;
    quarantinedCount: number;
    excludedOutOfScope: number;
    evidenceRef: string;
  }>(baseUrl, 'POST', '/api/import/nuclei', {
    lines: FIXTURE_NUCLEI_JSONL,
    engineVersion: FIXTURE_NUCLEI_VERSION,
  });

  // 7. 報告
  const report = await callApi<ReportArtifact>(baseUrl, 'POST', '/api/report', { guidelines: ['fixture-guideline'] });

  // 監査 event は cursor 付き NDJSON で受け取り、eventId を除いて CLI 出力の形状に戻す。
  const events = await fetchEvents(baseUrl);
  const importedTotals = events
    .filter((event): event is Extract<BaselineFlowEvent, { type: 'FindingsImported' }> => event.type === 'FindingsImported')
    .reduce(
      (totals, event) => ({ imported: totals.imported + event.importedCount, duplicates: totals.duplicates + event.duplicateCount }),
      { imported: 0, duplicates: 0 },
    );
  const capabilities = await callApi<{
    capabilities: readonly { engineKind: string; fixtureHash?: string }[];
  }>(baseUrl, 'GET', '/api/capabilities');
  const capabilityFixtureHashes: { playwright?: string; zap?: string; nuclei?: string } = {};
  for (const capability of capabilities.capabilities) {
    if (
      capability.fixtureHash !== undefined &&
      (capability.engineKind === 'playwright' || capability.engineKind === 'zap' || capability.engineKind === 'nuclei')
    ) {
      capabilityFixtureHashes[capability.engineKind] = capability.fixtureHash;
    }
  }
  const findingsCount = nucleiImport.findings.length;
  const exitCode = findingsCount > 0 ? ExitCodes.FindingsPresent : ExitCodes.Success;
  const summary: SimulateSummary = {
    schemaVersion: 'scopepilot2.simulate.v1',
    command: 'simulate',
    status: 'completed',
    exitCode,
    caseId: caseRecord.caseId,
    explorePlanHash: explorePlan.planHash,
    scanPlanHash: scanPlan.planHash,
    reportModelHash: report.modelHash,
    exploredCount: exploration.observations.length,
    scannedCount: activeScan.scanRequest.targets.length,
    findingsCount,
    importedCount: importedTotals.imported,
    duplicateCount: importedTotals.duplicates,
    engineVersions: {
      explorer: exploration.engineVersion,
      zap: activeScan.engineVersion,
      nuclei: FIXTURE_NUCLEI_VERSION,
    },
    capabilityFixtureHashes,
    eventsCount: events.length,
  };
  return { exitCode, summary, events };
}

async function callApi<T>(baseUrl: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
    if (errorBody === null || typeof errorBody.code !== 'string' || !DOMAIN_ERROR_CODES.has(errorBody.code)) {
      throw new Error(`core api ${method} ${path} failed: HTTP ${response.status}`);
    }
    throw new CoreApiError(errorBody.code as DomainErrorCode, errorBody.message ?? 'core api request failed');
  }
  return (await response.json()) as T;
}

async function fetchEvents(baseUrl: string): Promise<BaselineFlowEvent[]> {
  const response = await fetch(`${baseUrl}/api/events`);
  if (!response.ok) {
    throw new Error(`core api GET /api/events failed: HTTP ${response.status}`);
  }
  const text = await response.text();
  const events: BaselineFlowEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const parsed = JSON.parse(line) as Record<string, unknown>;
    delete parsed.eventId;
    events.push(parsed as unknown as BaselineFlowEvent);
  }
  return events;
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 2000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeAllConnections?.();
  });
}
