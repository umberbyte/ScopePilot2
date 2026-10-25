/**
 * `scopepilot fuzz` — fuzz session を実行して cluster 集約を返す (design/19 §2)。
 * `--api` 指定時は外部 Core API (案件は作成済みであること。無い場合は案内して終了)、
 * 無指定時は in-process (fixture) で案件・認可まで bootstrap して実行する。
 */
import { createCoreApiServer } from '@scopepilot2/core';
import { createHarness, FIXTURE_OPERATOR } from '@scopepilot2/simulation';
import type { OutputWriters } from './output-formatter.ts';
import type { FuzzPosition } from './cli-parser.ts';

interface FuzzRunView {
  readonly runId: string;
  readonly total: number;
  readonly sent: number;
  readonly clusters: readonly { key: string; members: readonly number[]; representative: readonly string[] }[];
}

async function postJson(base: string, path: string, body: unknown): Promise<{ ok: boolean; status: number; body: { code?: string; message?: string } & Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, body: { code: 'EngineFailure', message: 'unreachable' } };
  }
  const parsed = (await response.json().catch(() => ({}))) as { code?: string; message?: string } & Record<string, unknown>;
  return { ok: response.ok, status: response.status, body: parsed };
}

async function runOverApi(base: string, target: string, positions: readonly FuzzPosition[], writers: OutputWriters, bootstrap: boolean): Promise<number> {
  if (bootstrap) {
    // in-process のみ: fixture 案件と認可を作る。外部 API の案件は勝手に作らない。
    await postJson(base, '/api/case', {
      name: 'ScopePilot2 案件',
      allowedOrigins: [new URL(target).origin],
      deniedOrigins: [],
      limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
    });
    await postJson(base, '/api/authorization', {
      allowedOperationClasses: ['Browse', 'ActiveScan', 'CrossRoleTest'],
      targetRoles: ['unauthenticated'],
      validFrom: '2026-10-18T00:00:00.000Z',
      validUntil: '2026-10-19T00:00:00.000Z',
      evidenceLabel: '認可 (CLI)',
      evidenceContent: 'cli fuzz evidence',
    });
  }
  const result = await postJson(base, '/api/fuzzer/runs', { targetUrl: target, positions });
  if (!result.ok) {
    if (result.status === 0) {
      writers.stderr(`error: Core API is unreachable`);
      return 7;
    }
    if (result.body.code === 'OutOfScope') {
      writers.stderr(`error: ${result.body.message ?? 'target is out of scope'}`);
      return 6;
    }
    if (result.body.code === 'ValidationFailed') {
      writers.stderr(`error: ${result.body.message ?? 'validation failed'}`);
      return 2;
    }
    if (result.body.code === 'PermissionDenied') {
      writers.stderr(`error: ${result.body.message ?? 'permission denied'}`);
      return 3;
    }
    writers.stderr(`error: POST /api/fuzzer/runs failed: HTTP ${result.status} ${result.body.message ?? ''}`.trimEnd());
    return 1;
  }
  const run = result.body as unknown as FuzzRunView;
  writers.stdout(
    JSON.stringify(
      {
        schemaVersion: 'scopepilot2.fuzz.v1',
        runId: run.runId,
        total: run.total,
        sent: run.sent,
        clusters: run.clusters.map((cluster) => ({
          key: cluster.key,
          count: cluster.members.length,
          representative: cluster.representative,
        })),
      },
      null,
      2,
    ),
  );
  return 0;
}

export async function runFuzz(
  options: { apiUrl?: string; target: string; positions: readonly FuzzPosition[] },
  writers: OutputWriters,
): Promise<number> {
  if (options.apiUrl !== undefined) {
    return await runOverApi(options.apiUrl.replace(/\/$/, ''), options.target, options.positions, writers, false);
  }

  const harness = createHarness();
  const server = createCoreApiServer({ service: harness.service, operator: FIXTURE_OPERATOR });
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP address for the core api server');
    }
    return await runOverApi(`http://127.0.0.1:${address.port}`, options.target, options.positions, writers, true);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}
