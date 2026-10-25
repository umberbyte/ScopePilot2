/**
 * `scopepilot case status` — 案件の現在状態を Core API へ問い合わせる (design/19 §2)。
 * `--api` は必須 (in-process harness に案件はない)。
 */
import type { OutputWriters } from './output-formatter.ts';

interface CaseRecordView {
  readonly caseId: string;
  readonly name: string;
  readonly revision: number;
  readonly scope: { readonly allowedOrigins: readonly string[]; readonly deniedOrigins: readonly string[] };
  readonly createdAt: string;
}

export async function runCaseStatus(options: { apiUrl: string }, writers: OutputWriters): Promise<number> {
  const base = options.apiUrl.replace(/\/$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}/api/case`);
  } catch {
    writers.stderr(`error: Core API at ${options.apiUrl} is unreachable`);
    return 7;
  }
  const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  if (response.ok) {
    const record = body as unknown as CaseRecordView;
    writers.stdout(JSON.stringify({ schemaVersion: 'scopepilot2.case.v1', source: options.apiUrl, case: record }, null, 2));
    return 0;
  }
  if (body?.code === 'ValidationFailed') {
    writers.stderr(`error: ${body.message ?? 'case is not available'}`);
    return 2;
  }
  if (body?.code === 'PermissionDenied') {
    writers.stderr(`error: ${body.message ?? 'permission denied'}`);
    return 3;
  }
  writers.stderr(`error: GET /api/case failed: HTTP ${response.status} ${body?.message ?? ''}`.trimEnd());
  return 1;
}
