/**
 * Core API (ローカル REST) の seed。`docs/design/18-extension-api.md`、design/19 §3。
 * UI と CLI が共有するローカル契約の実体。node:http のみで実装し、依存を追加しない。
 *
 * - 変更系は JSON body を 1 MiB 上限で受け、DomainError を安定した HTTP status + code へ写す。
 * - wildcard CORS は許可しない (loopback 既定・F20 §5)。
 * - /api/events は cursor (since) 以降の監査 event を NDJSON で返す (SSE 実装への土台)。
 */
import type { Server } from 'node:http';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DomainError, hashStable, type DomainErrorCode, type OperatorProfile } from '@scopepilot2/contracts';
import type { BaselineFlowService } from './baseline-flow.ts';
import { CodecRegistry, compareText, provenanceOf, transformPipeline, type CompareOptions } from '../domain/decoder-comparer.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const HTTP_STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  ValidationFailed: 400,
  PermissionDenied: 403,
  OutOfScope: 403,
  ConfirmationRequired: 409,
  Conflict: 409,
  CapabilityUnavailable: 503,
  NeedsInput: 409,
  Unsupported: 501,
  EngineFailure: 502,
  Cancelled: 409,
};

export interface CoreApiServerOptions {
  readonly service: BaselineFlowService;
  readonly operator: OperatorProfile;
  /** run 記録の照会・Interrupted 検出 (design/22 §6)。任意。 */
  readonly runRepository?: {
    listInterruptedCandidates(): readonly import('@scopepilot2/contracts').RunRecord[];
    markInterrupted(): readonly import('@scopepilot2/contracts').RunRecord[];
  };
}

export function createCoreApiServer(options: CoreApiServerOptions): Server {
  const { service, operator, runRepository } = options;

  const server = createServer((request, response) => {
    void handle(request, response).catch((cause: unknown) => {
      respondError(response, 500, 'InternalError', 'unexpected server error', false);
      server.emit('core-api-error', cause);
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = request.method ?? 'GET';
    const route = `${method} ${url.pathname}`;

    // wildcard CORS は付与しない。同一 machine の契約クライアントのみ想定。
    response.setHeader('Cache-Control', 'no-store');

    if (route === 'GET /api/health') {
      return respondJson(response, 200, { schemaVersion: 'scopepilot2.api.v1', status: 'ok' });
    }
    if (route === 'GET /api/case') {
      try {
        return respondJson(response, 200, service.currentCase());
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/case') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const record = service.createCase(operator, {
          name: stringField(body, 'name'),
          allowedOrigins: stringArrayField(body, 'allowedOrigins'),
          deniedOrigins: stringArrayField(body, 'deniedOrigins'),
          limits: limitsField(body),
        });
        return respondJson(response, 201, record);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/case/scope') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const outcome = service.updateCaseScope(operator, {
          expectedRevision: numberField(body, 'expectedRevision'),
          allowedOrigins: stringArrayField(body, 'allowedOrigins'),
          deniedOrigins: stringArrayField(body, 'deniedOrigins'),
          limits: limitsField(body),
        });
        return respondJson(response, 200, outcome);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/authorization') {
      try {
        return respondJson(response, 200, service.currentAuthorization());
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/authorization') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const record = await service.grantAuthorization(operator, {
          allowedOperationClasses: stringArrayField(body, 'allowedOperationClasses') as never,
          targetRoles: stringArrayField(body, 'targetRoles'),
          validFrom: stringField(body, 'validFrom'),
          validUntil: stringField(body, 'validUntil'),
          evidence: {
            label: stringField(body, 'evidenceLabel'),
            content: stringField(body, 'evidenceContent'),
          },
        });
        return respondJson(response, 201, record);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/plan/explore') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const result = service.buildExplorationPlan(operator, stringArrayField(body, 'seeds'), optionalLimitsField(body));
        service.authorizePlan(result.plan);
        return respondJson(response, 200, { plan: result.plan, planHash: result.planHash });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/plan/scan') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const result = service.buildActiveScanPlan(operator, stringArrayField(body, 'targets'), optionalLimitsField(body));
        service.authorizePlan(result.plan);
        return respondJson(response, 200, { plan: result.plan, planHash: result.planHash });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/candidates/adopt') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const adopted = service.adoptCandidates(operator, candidateArrayField(body, 'candidates'));
        return respondJson(response, 200, { adopted });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/report') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const artifact = service.generateReport(operator, { guidelines: stringArrayField(body, 'guidelines') });
        return respondJson(response, 200, artifact);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/capabilities') {
      return respondJson(response, 200, { capabilities: service.capabilities() });
    }
    if (route === 'POST /api/plan/confirm') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const plan = planField(body);
        const confirmation = service.confirmPlan(plan, operator);
        return respondJson(response, 200, confirmation);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/run/explore') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const result = await service.runExploration(operator, planField(body), confirmationField(body), {
          maxDepth: positiveIntegerField(body, 'maxDepth'),
        });
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/run/scan') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const result = await service.runActiveScan(operator, planField(body), confirmationField(body), adoptedField(body));
        return respondJson(response, 200, {
          runRecord: result.runRecord,
          planHash: result.planHash,
          scanRequest: result.scanRequest,
          overshootReservation: result.overshootReservation,
          engineVersion: result.engineVersion,
          findings: result.findings,
        });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/import/nuclei') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const result = await service.importNucleiResults(operator, {
          lines: stringArrayField(body, 'lines'),
          engineVersion: stringField(body, 'engineVersion'),
        });
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/findings') {
      return respondJson(response, 200, { findings: service.listFindings() });
    }
    if (route === 'GET /api/observations') {
      // site map の素材 (design/02 A04)。観測 URL と scope 拒否を開示する。
      return respondJson(response, 200, { observations: service.listObservations(), deniedUrls: service.listDeniedUrls() });
    }
    if (route === 'POST /api/findings/status') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const findingId = stringField(body, 'findingId');
        const status = stringField(body, 'status');
        if (status !== 'confirmed' && status !== 'rejected') {
          return respondError(response, 400, 'ValidationFailed', "field status must be 'confirmed' or 'rejected'", false);
        }
        const finding = service.updateFindingStatus(operator, { findingId, next: status });
        return respondJson(response, 200, { finding });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/tools/decode') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        // decoder は状態を持たない工具。権限は route と同じ case.read (design/02 §3)。
        if (!operator.permissions.includes('case.read')) {
          return respondError(response, 403, 'PermissionDenied', 'decoder requires case.read', false);
        }
        const inputText = stringField(body, 'inputText');
        const codecs = stringArrayField(body, 'codecs');
        if (codecs.length === 0) {
          return respondError(response, 400, 'ValidationFailed', 'codecs must not be empty', false);
        }
        const registry = new CodecRegistry();
        for (const name of codecs) {
          if (!registry.has(name)) {
            return respondError(response, 400, 'ValidationFailed', `unknown codec: ${name}`, false);
          }
        }
        const output = transformPipeline(registry, Buffer.from(inputText, 'utf8'), codecs);
        let outputText: string | undefined;
        try {
          outputText = new TextDecoder('utf-8', { fatal: true }).decode(output);
        } catch {
          // 有効な UTF-8 でない場合は base64 のみ返す (壊れた文字列を出さない)。
        }
        return respondJson(response, 200, {
          ...(outputText === undefined ? {} : { outputText }),
          outputBase64: output.toString('base64'),
          outputBytes: output.length,
        });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/tools/compare-text') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        if (!operator.permissions.includes('case.read')) {
          return respondError(response, 403, 'PermissionDenied', 'comparer requires case.read', false);
        }
        const left = stringField(body, 'left');
        const right = stringField(body, 'right');
        const options: CompareOptions = body.normalizeNewlines === true ? { normalizeNewlines: true } : {};
        const diff = compareText(left, right, options);
        const provenance = provenanceOf(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'), options);
        return respondJson(response, 200, { ...diff, provenance });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/proxy/intercept') {
      return respondJson(response, 200, { items: service.listBreakItems(), events: service.breakQueueEvents() });
    }
    if (route === 'POST /api/proxy/intercept/intake') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const direction = stringField(body, 'direction');
        if (direction !== 'request' && direction !== 'response') {
          return respondError(response, 400, 'ValidationFailed', "field direction must be 'request' or 'response'", false);
        }
        const holdMs = body.holdMs === undefined ? undefined : numberField(body, 'holdMs');
        const item = service.enqueueBreakItem(operator, {
          direction,
          messageReference: stringField(body, 'messageReference'),
          ...(holdMs === undefined ? {} : { holdMs }),
        });
        return respondJson(response, 201, { item });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/proxy/intercept/forward') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const itemId = stringField(body, 'itemId');
        const targetUrl = stringField(body, 'targetUrl');
        // 編集後要求 hash は、指定がなければ編集先 URL から決定的に作る。
        const requestHash =
          body.requestHash === undefined ? requireHash(targetUrl) : stringField(body, 'requestHash');
        const decision = service.decideBreakItem(operator, itemId, { requestHash, targetUrl });
        return respondJson(response, 200, { decision });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/proxy/intercept/drop') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const item = service.dropBreakItem(operator, stringField(body, 'itemId'));
        return respondJson(response, 200, { item });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/runs/interrupted') {
      if (runRepository === undefined) {
        return respondError(response, 501, 'Unsupported', 'run persistence is not configured for this server', false);
      }
      // design/22 §6: 実行中のまま残った run を Interrupted へ。自動再開は行わない。
      const interrupted = runRepository.markInterrupted();
      return respondJson(response, 200, { interrupted });
    }
    if (route === 'GET /api/events') {
      const accept = request.headers.accept ?? '';
      const lastEventIdHeader = Number(request.headers['last-event-id'] ?? '0');
      const sinceQuery = url.searchParams.get('since');
      const since = sinceQuery !== null ? Number(sinceQuery) : Number.isFinite(lastEventIdHeader) ? lastEventIdHeader : 0;
      if (!Number.isInteger(since) || since < 0) {
        return respondError(response, 400, 'ValidationFailed', 'since must be a non-negative integer', false);
      }
      const events = service.events();
      // cursor は監査 event の連番。以後の event だけを返す (F20-UT-004 と同じ意味論)。
      if (accept.includes('text/event-stream')) {
        // SSE 形式 (design/18): Last-Event-ID (または ?since) 以降を再送する。
        const sseLines = events
          .slice(since)
          .map((event, index) => {
            const eventId = since + index + 1;
            const body = JSON.stringify({ eventId, ...event });
            return `id: ${eventId}\nevent: ${event.type}\ndata: ${body}\n\n`;
          });
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(sseLines.join(''));
        return;
      }
      const lines = events
        .slice(since)
        .map((event, index) => JSON.stringify({ eventId: since + index + 1, ...event }));
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      response.end(`${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`);
      return;
    }
    if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      return respondError(response, 404, 'NotFound', `unknown route: ${route}`, false);
    }
    return respondError(response, 405, 'MethodNotAllowed', `method not allowed: ${method}`, false);
  }

  return server;
}

async function readJsonBody(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      respondError(response, 400, 'ValidationFailed', `request body exceeds ${MAX_BODY_BYTES} bytes`, false);
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    respondError(response, 400, 'ValidationFailed', 'request body is required', false);
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      respondError(response, 400, 'ValidationFailed', 'request body must be a JSON object', false);
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    respondError(response, 400, 'ValidationFailed', 'request body is not valid JSON', false);
    return undefined;
  }
}

function respondDomainError(response: ServerResponse, cause: unknown): void {
  if (cause instanceof DomainError) {
    const status = HTTP_STATUS_BY_CODE[cause.code];
    respondError(response, status, cause.code, cause.message, cause.retryable);
    return;
  }
  respondError(response, 500, 'InternalError', String(cause), false);
}

function respondError(response: ServerResponse, status: number, code: string, message: string, retryable: boolean): void {
  respondJson(response, status, { code, message, retryable, schemaVersion: 'scopepilot2.api.v1' });
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function requireHash(targetUrl: string): string {
  return hashStable('scopepilot2.request.edited', targetUrl);
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new DomainError('ValidationFailed', `field ${field} must be a string`);
  }
  return value;
}

function numberField(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DomainError('ValidationFailed', `field ${field} must be an integer`);
  }
  return value;
}

function stringArrayField(body: Record<string, unknown>, field: string): readonly string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new DomainError('ValidationFailed', `field ${field} must be an array of strings`);
  }
  return value as readonly string[];
}

/** 計画 API の任意上限指定。未指定なら service 既定。指定時は正の整数 3 点のみ許す。 */
function optionalLimitsField(body: Record<string, unknown>): { maxRequests: number; maxPages: number; maxDurationMinutes: number } | undefined {
  if (body.limits === undefined) {
    return undefined;
  }
  return limitsField(body);
}

function limitsField(body: Record<string, unknown>): { maxRequests: number; maxPages: number; maxDurationMinutes: number } {
  const limits = body.limits;
  if (typeof limits !== 'object' || limits === null) {
    throw new DomainError('ValidationFailed', 'field limits must be an object');
  }
  const record = limits as Record<string, unknown>;
  return {
    maxRequests: expectPositiveInteger(record.maxRequests, 'limits.maxRequests'),
    maxPages: expectPositiveInteger(record.maxPages, 'limits.maxPages'),
    maxDurationMinutes: expectPositiveInteger(record.maxDurationMinutes, 'limits.maxDurationMinutes'),
  };
}

function planField(body: Record<string, unknown>): import('@scopepilot2/contracts').ExecutionPlan {
  return structField(body, 'plan') as unknown as import('@scopepilot2/contracts').ExecutionPlan;
}

function confirmationField(body: Record<string, unknown>): import('@scopepilot2/contracts').PlanConfirmation {
  return structField(body, 'confirmation') as unknown as import('@scopepilot2/contracts').PlanConfirmation;
}

function adoptedField(body: Record<string, unknown>): readonly import('@scopepilot2/contracts').ScanCandidate[] {
  const value = body.adopted;
  if (!Array.isArray(value)) {
    throw new DomainError('ValidationFailed', 'field adopted must be an array of candidates');
  }
  return value as readonly import('@scopepilot2/contracts').ScanCandidate[];
}

function candidateArrayField(body: Record<string, unknown>, field: string): readonly import('@scopepilot2/contracts').ScanCandidate[] {
  const value = body[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'object' || entry === null || Array.isArray(entry))) {
    throw new DomainError('ValidationFailed', `field ${field} must be an array of candidates`);
  }
  return value as readonly import('@scopepilot2/contracts').ScanCandidate[];
}

function structField(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = body[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('ValidationFailed', `field ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveIntegerField(body: Record<string, unknown>, field: string): number {
  return expectPositiveInteger(body[field], field);
}

function expectPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new DomainError('ValidationFailed', `field ${field} must be a positive integer`);
  }
  return value;
}
