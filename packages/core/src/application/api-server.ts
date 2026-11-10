/**
 * Core API (ローカル REST) の seed。`docs/design/18-extension-api.md`、design/19 §3。
 * UI と CLI が共有するローカル契約の実体。node:http のみで実装し、依存を追加しない。
 *
 * - 変更系は原則 JSON body を 1 MiB 上限で受ける。Sequencer再送bodyを含む経路だけは、
 *   JSON escapeの膨張を含めて8 MiBの専用envelope上限を使う。
 * - wildcard CORS は許可しない (loopback 既定・F20 §5)。
 * - /api/events は cursor (since) 以降の監査 event を NDJSON で返す (SSE 実装への土台)。
 */
import type { Server } from 'node:http';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { JobEvent, ScanExecutionStatus, SequencerJobParams } from '@scopepilot2/contracts';
import { DomainError, DocumentAuthMethods, JobEventCategories, JobKinds, JobStates, hashStable, type AuthenticationMethod, type DocumentAuthMethod, type DomainErrorCode, type OperatorProfile } from '@scopepilot2/contracts';
import type { BaselineFlowService } from './baseline-flow.ts';
import { CodecRegistry, compareText, compareBinaryRows, fingerprintBytes, parseComparisonHex, provenanceOf, transformPipeline, type CompareOptions } from '../domain/decoder-comparer.ts';
import type { LoginFlowStep } from '../domain/authentication-session.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SEQUENCER_ENVELOPE_BYTES = 8 * 1024 * 1024;
const MAX_INTERACTIVE_ENVELOPE_BYTES = 16 * 1024 * 1024;
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
        if (body.enableNuclei !== undefined && typeof body.enableNuclei !== 'boolean') {
          throw new DomainError('ValidationFailed', 'enableNuclei must be boolean');
        }
        if (body.enableWorkflowScan !== undefined && typeof body.enableWorkflowScan !== 'boolean') {
          throw new DomainError('ValidationFailed', 'enableWorkflowScan must be boolean');
        }
        const routeOverridesValue = body.routeOverrides;
        if (routeOverridesValue !== undefined && (typeof routeOverridesValue !== 'object' || routeOverridesValue === null || Array.isArray(routeOverridesValue))) {
          throw new DomainError('ValidationFailed', 'routeOverrides must be an object');
        }
        const routeOverrides = routeOverridesValue as Record<string, unknown> | undefined;
        for (const [name, value] of Object.entries(routeOverrides ?? {})) {
          if (!['zap', 'genericHttp', 'nuclei'].includes(name) || typeof value !== 'boolean') {
            throw new DomainError('ValidationFailed', `invalid route override: ${name}`);
          }
        }
        const result = service.buildActiveScanPlan(
          operator,
          stringArrayField(body, 'targets'),
          optionalLimitsField(body),
          {
            includeNuclei: body.enableNuclei === true,
            includeWorkflowScan: body.enableWorkflowScan === true,
            guidelines: body.guidelines === undefined ? [] : stringArrayField(body, 'guidelines'),
            ...(typeof body.scanPolicyId === 'string' ? { scanPolicyId: stringField(body, 'scanPolicyId') } : {}),
            ...(typeof body.scanPolicyHash === 'string' ? { scanPolicyHash: stringField(body, 'scanPolicyHash') } : {}),
            ...(routeOverrides === undefined ? {} : {
              routeOverrides: {
                ...(typeof routeOverrides.zap === 'boolean' ? { zap: routeOverrides.zap } : {}),
                ...(typeof routeOverrides.genericHttp === 'boolean' ? { genericHttp: routeOverrides.genericHttp } : {}),
                ...(typeof routeOverrides.nuclei === 'boolean' ? { nuclei: routeOverrides.nuclei } : {}),
              },
            }),
            ...(typeof body.targetRole === 'string' ? { targetRole: stringField(body, 'targetRole') } : {}),
          },
        );
        service.authorizePlan(result.plan);
        return respondJson(response, 200, { plan: result.plan, planHash: result.planHash });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/candidates') {
      return respondJson(response, 200, { candidates: service.listScanCandidates(operator) });
    }
    if (route === 'GET /api/scan-policies') {
      try {
        return respondJson(response, 200, { policies: service.listScanPolicies(operator) });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/scan-policies') {
      const body = await readJsonBody(request, response);
      if (body === undefined) return;
      try {
        const routesValue = body.routes;
        if (typeof routesValue !== 'object' || routesValue === null || Array.isArray(routesValue)) {
          throw new DomainError('ValidationFailed', 'routes must be an object');
        }
        const routes = routesValue as Record<string, unknown>;
        const zap = structField(routes, 'zap');
        const genericHttp = structField(routes, 'genericHttp');
        const nuclei = structField(routes, 'nuclei');
        if ('ruleIds' in zap || 'rules' in zap || 'pluginIds' in zap) {
          throw new DomainError('ValidationFailed', 'ZAP per-rule-ID strength/threshold is not supported');
        }
        const attackStrength = stringField(zap, 'attackStrength');
        if (attackStrength !== 'Low' && attackStrength !== 'Medium' && attackStrength !== 'High') {
          throw new DomainError('ValidationFailed', 'invalid ZAP attackStrength');
        }
        const alertThreshold = stringField(zap, 'alertThreshold');
        if (!['Off', 'Default', 'Low', 'Medium', 'High'].includes(alertThreshold)) {
          throw new DomainError('ValidationFailed', 'invalid ZAP alertThreshold');
        }
        const result = service.saveScanPolicy(operator, {
          expectedRevision: numberField(body, 'expectedRevision'),
          ...(typeof body.policyId === 'string' ? { policyId: stringField(body, 'policyId') } : {}),
          name: stringField(body, 'name'),
          isDefault: body.isDefault === true,
          routes: {
            zap: { enabled: zap.enabled === true, attackStrength, alertThreshold: alertThreshold as import('@scopepilot2/contracts').ScanAlertThreshold },
            genericHttp: { enabled: genericHttp.enabled === true, checkIds: stringArrayField(genericHttp, 'checkIds') as import('@scopepilot2/contracts').GenericHttpCheckId[] },
            nuclei: { enabled: nuclei.enabled === true, templateIds: stringArrayField(nuclei, 'templateIds') },
          },
        });
        return respondJson(response, 200, result);
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
        if (body.excludeLowAndInfo !== undefined && typeof body.excludeLowAndInfo !== 'boolean') {
          throw new DomainError('ValidationFailed', 'field excludeLowAndInfo must be a boolean');
        }
        const artifact = service.generateReport(operator, {
          guidelines: stringArrayField(body, 'guidelines'),
          ...(body.excludeLowAndInfo === undefined ? {} : { excludeLowAndInfo: body.excludeLowAndInfo }),
        });
        return respondJson(response, 200, artifact);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/capabilities') {
      return respondJson(response, 200, { capabilities: service.capabilities(), runtimeProfile: service.runtimeProfile, adapters: service.toolCapabilities(), runtimeBundle: service.runtimeBundleManifest() });
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
          // role 指定時は runLogin 済み session で観測する (design/f09)。
          ...(typeof body.role === 'string' ? { role: stringField(body, 'role') } : {}),
        });
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/run/scan/start' || route === 'POST /api/jobs') {
      const body = await readJsonBody(request, response, route === 'POST /api/jobs' ? MAX_SEQUENCER_ENVELOPE_BYTES : MAX_BODY_BYTES);
      if (body === undefined) return;
      try {
        if (route === 'POST /api/jobs' && body.kind === 'sequencer') {
          const jobId = service.startSequencerJob(operator, sequencerParamsField(objectField(body, 'params')));
          return respondJson(response, 202, { jobId });
        }
        if (route === 'POST /api/jobs' && body.kind !== 'active-scan') throw new DomainError('Unsupported', 'unsupported job kind');
        const input = route === 'POST /api/jobs' ? { ...body, ...objectField(body, 'params') } : body;
        const plan = planField(input);
        const confirmation = confirmationField(input);
        const adopted = adoptedField(input);
        const role = typeof input.role === 'string' ? stringField(input, 'role') : undefined;
        // Fail confirmation/permission/scope checks before accepting the job.
        service.validateJobScan(operator, plan, confirmation);
        const registry = service.jobs;
        const jobId = registry.create({ kind: 'active-scan', label: 'Active scan', planHash: confirmation.planHash,
          ...(role === undefined ? {} : { role }), guarantee: 'Mixed', transport: service.scanTransport(), budgetLimit: plan.limits.maxRequests });
        void registry.execute(jobId, signal => service.runActiveScan(operator, plan, confirmation, adopted, role, {
          signal,
          onEvent: event => registry.recordScanEvent(jobId, event),
        })).catch(cause => server.emit('core-api-error', cause));
        return respondJson(response, 202, route === 'POST /api/jobs' ? { jobId } : { executionId: jobId });
      } catch (cause) { return respondDomainError(response, cause); }
    }
    if (route === 'GET /api/run/scan/status') {
      const executionId = url.searchParams.get('executionId') ?? '';
      const job = service.jobs.get(executionId);
      if (job === undefined || job.summary.kind !== 'active-scan') return respondError(response, 404, 'ValidationFailed', 'scan execution was not found', false);
      const events = service.jobs.events().filter(e => e.jobId === executionId);
      const latest = events.findLast(e => e.category === 'phase');
      const command = events.findLast(e => e.refs?.command !== undefined)?.refs?.command ?? '';
      const runState = job.summary.state;
      const dispatchState = job.summary.state === 'Queued' ? 'queued' : 'dispatched';
      const status = {
        executionId,
        state: runState,
        runState,
        dispatchState,
        ...(job.summary.stopReason === undefined ? {} : { stopReason: job.summary.stopReason }),
        currentEngine: latest?.source === 'zap' || latest?.source === 'nuclei' ? latest.source : 'scopepilot',
        currentCommand: command,
        progress: job.summary.state === 'Completed' ? 100 : job.summary.counters.progress?.done ?? 0,
        logs: events.slice(-500).map(e => `${e.at} [${e.source.toUpperCase()}] ${e.message}${e.refs?.command === undefined ? '' : `\n  $ ${e.refs.command}`}`),
        ...(job.result === undefined ? {} : { result: job.result }),
        ...(job.error === undefined ? {} : { error: job.error }),
      };
      return respondJson(response, 200, status);
    }
    if (route === 'POST /api/run/scan/stop') {
      const body = await readJsonBody(request, response);
      if (body === undefined) return;
      try {
        const id = stringField(body, 'executionId');
        if (service.jobs.get(id) === undefined) return respondError(response, 404, 'ValidationFailed', 'scan execution was not found', false);
        requireJobPermission(operator, 'run.manage');
        const job = service.jobs.stop(id);
        const runState = job.state; const dispatchState = job.state === 'Queued' ? 'queued' : 'dispatched'; return respondJson(response, 202, { executionId: id, state: runState, runState, dispatchState, ...(job.stopReason === undefined ? {} : { stopReason: job.stopReason }) });
      } catch (cause) { return respondDomainError(response, cause); }
    }
    // GET /api/jobs/{jobId}, GET /api/jobs/{jobId}/events, POST /api/jobs/{jobId}/stop
    if (url.pathname === '/api/jobs' || url.pathname.startsWith('/api/jobs/')) {
      try {
        requireJobPermission(operator, 'case.read');
        const match = /^\/api\/jobs\/([^/]+)(?:\/(events|stop))?$/.exec(url.pathname);
        const id = match?.[1] === 'events' ? undefined : match?.[1];
        if (id !== undefined && service.jobs.get(id) === undefined) return respondError(response, 404, 'NotFound', 'job was not found', false);
        if (method === 'GET' && (url.pathname === '/api/jobs/events' || match?.[2] === 'events')) {
          const since = cursorField(url.searchParams.get('since') ?? request.headers['last-event-id'] ?? '0');
          const before = cursorField(url.searchParams.get('before') ?? String(Number.MAX_SAFE_INTEGER));
          const limit = Math.min(5000, cursorField(url.searchParams.get('limit') ?? '500'));
          if (limit === 0) throw new DomainError('ValidationFailed', 'limit must be positive');
          const category = url.searchParams.get('category');
          const level = url.searchParams.get('level');
          if (category !== null && !JobEventCategories.some(c => c === category)) throw new DomainError('ValidationFailed', 'unknown job event category');
          if (level !== null && !['debug', 'info', 'warn', 'error'].includes(level)) throw new DomainError('ValidationFailed', 'unknown job event level');
          const accepts = (e: JobEvent): boolean => e.seq > since && e.seq < before && (id === undefined || e.jobId === id)
            && (!url.searchParams.has('category') || e.category === url.searchParams.get('category'))
            && (!url.searchParams.has('level') || e.level === url.searchParams.get('level'));
          if (!(request.headers.accept ?? '').includes('application/x-ndjson')) {
            streamEvents(response, service.jobs.events().filter(accepts), listener => service.jobs.subscribe(e => { if (accepts(e)) listener(e); }), e => e.seq, () => 'job.event');
          } else {
            const events = service.jobs.events().filter(accepts);
            const page = url.searchParams.has('before') ? events.slice(-limit) : events.slice(0, limit);
            respondNdjson(response, page);
          }
          return;
        }
        if (method === 'GET' && url.pathname === '/api/jobs') {
          const state = url.searchParams.get('state');
          const kind = url.searchParams.get('kind');
          if (state !== null && state !== 'active' && !JobStates.some(s => s === state)) throw new DomainError('ValidationFailed', 'unknown job state');
          if (kind !== null && !JobKinds.some(k => k === kind)) throw new DomainError('ValidationFailed', 'unknown job kind');
          const offset = cursorField(url.searchParams.get('cursor') ?? '0');
          const limit = Math.min(500, cursorField(url.searchParams.get('limit') ?? '100'));
          if (limit === 0) throw new DomainError('ValidationFailed', 'limit must be positive');
          const jobs = service.jobs.list().filter(j => (!state || (state === 'active' ? service.jobs.active(j.state) : j.state === state)) && (!kind || j.kind === kind));
          return respondJson(response, 200, { jobs: jobs.slice(offset, offset + limit), ...(offset + limit < jobs.length ? { cursor: String(offset + limit) } : {}) });
        }
        if (method === 'GET' && match && !match[2]) return respondJson(response, 200, service.jobs.get(id!));
        if (method === 'POST' && match?.[2] === 'stop') {
          requireJobPermission(operator, 'run.manage');
          return respondJson(response, 202, service.jobs.stop(id!));
        }
      } catch (cause) { return respondDomainError(response, cause); }
    }
    if (route === 'POST /api/run/scan') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        // role 指定時はその role の session cookie 適用を診断へ指示する (design/08)。
        const role = typeof body.role === 'string' ? stringField(body, 'role') : undefined;
        const result = await service.runActiveScan(operator, planField(body), confirmationField(body), adoptedField(body), role);
        return respondJson(response, 200, {
          runRecord: result.runRecord,
          planHash: result.planHash,
          scanRequest: result.scanRequest,
          overshootReservation: result.overshootReservation,
          engineVersion: result.engineVersion,
          requestCorpusEvidenceRef: result.requestCorpusEvidenceRef,
          findings: result.findings,
          diagnosticRoutes: result.diagnosticRoutes,
          guidelineRoutes: result.guidelineRoutes,
          ...(result.workflow === undefined ? {} : { workflow: result.workflow }),
          ...(result.nuclei === undefined ? {} : { nuclei: result.nuclei }),
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
    if (method === 'GET' && url.pathname.startsWith('/api/passive/')) {
      try {
        if (route === 'GET /api/passive/rules') return respondJson(response, 200, { rules: service.listPassiveRules(operator) });
        if (route === 'GET /api/passive/status') return respondJson(response, 200, service.passiveStatus(operator));
        if (route === 'GET /api/passive/alerts') return respondJson(response, 200, { alerts: service.listPassiveAlerts(operator) });
        if (route === 'GET /api/passive/evidence') {
          const finding = service.listPassiveAlerts(operator).find((entry) => entry.findingId === url.searchParams.get('findingId'));
          if (finding === undefined) return respondError(response, 404, 'NotFound', 'passive finding not found', false);
          // Sanitised observation summary only. Never expose stored raw evidence or secrets.
          return respondJson(response, 200, { findingId: finding.findingId, evidenceRefs: finding.evidenceRefs,
            observation: finding.passive, reproduction: { method: finding.method ?? 'GET', url: finding.url } });
        }
      } catch (cause) { return respondDomainError(response, cause); }
    }
    if (route === 'GET /api/evidence') {
      try {
        return respondJson(response, 200, { evidence: await service.listEvidence(operator, url.searchParams.get('evidenceId') ?? undefined) });
      } catch (cause) { return respondDomainError(response, cause); }
    }
    if (route === 'GET /api/findings') {
      return respondJson(response, 200, { findings: service.listFindings() });
    }
    if (route === 'GET /api/observations') {
      // site map の素材 (design/02 A04)。観測 URL と scope 拒否を開示する。
      return respondJson(response, 200, { observations: service.listObservations(), deniedUrls: service.listDeniedUrls() });
    }
    if (route === 'GET /api/tools/sequencer/runs') {
      return respondJson(response, 200, { sessions: service.listSequencerSessions() });
    }
    if (route === 'POST /api/tools/sequencer/runs') {
      const body = await readJsonBody(request, response, MAX_SEQUENCER_ENVELOPE_BYTES);
      if (body === undefined) {
        return;
      }
      const cancellation = new AbortController();
      const cancelOnDisconnect = (): void => {
        if (!response.writableEnded) {
          cancellation.abort();
        }
      };
      request.once('aborted', cancelOnDisconnect);
      response.once('close', cancelOnDisconnect);
      try {
        const result = await service.runSequencerSession(operator, {
          ...sequencerParamsField(body),
          signal: cancellation.signal,
        });
        return respondJson(response, 200, result);
      } catch (cause) {
        if (cancellation.signal.aborted) {
          return;
        }
        return respondDomainError(response, cause);
      } finally {
        request.off('aborted', cancelOnDisconnect);
        response.off('close', cancelOnDisconnect);
      }
    }
    if (route === 'GET /api/import/api-spec') {
      return respondJson(response, 200, { imports: service.listApiSpecImports() });
    }
    if (route === 'POST /api/import/api-spec') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const result = service.importApiSpec(operator, {
          documentLabel: stringField(body, 'documentLabel'),
          document: body.document,
        });
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/diagnostics/interactive') {
      const body = await readJsonBody(request, response, MAX_INTERACTIVE_ENVELOPE_BYTES);
      if (body === undefined) return;
      try {
        const result = await service.runInteractiveDiagnostics(operator, interactiveDiagnosticInputField(body));
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/oast/attempts') {
      return respondJson(response, 200, {
        ...service.oastTransport(),
        attempts: service.listOastAttempts(),
        callbacks: service.listOastCallbacks(),
      });
    }
    if (route === 'POST /api/oast/attempts') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const protocol = stringField(body, 'protocol');
        if (protocol !== 'http' && protocol !== 'dns' && protocol !== 'smtp' && protocol !== 'icmp') {
          return respondError(response, 400, 'ValidationFailed', 'field protocol must be one of http/dns/smtp/icmp', false);
        }
        const result = await service.startOastAttempt(operator, { targetUrl: stringField(body, 'targetUrl'), protocol });
        return respondJson(response, 201, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/oast/callbacks') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const eventsValue = body.events;
        if (!Array.isArray(eventsValue)) {
          return respondError(response, 400, 'ValidationFailed', 'field events must be an array', false);
        }
        const events = eventsValue.map((event, index) => {
          if (typeof event !== 'object' || event === null) {
            throw new DomainError('ValidationFailed', `events[${index}] must be an object`);
          }
          const record = event as Record<string, unknown>;
          return { eventId: stringField(record, 'eventId'), token: stringField(record, 'token'), payload: stringField(record, 'payload') };
        });
        const result = service.recordOastCallbacks(operator, { events });
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/websocket/frames') {
      return respondJson(response, 200, {
        ...service.webSocketTransport(),
        connections: service.listWsConnections(),
        frames: service.listWsFrames(),
      });
    }
    if (route === 'POST /api/websocket/frames') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const framesValue = body.frames;
        if (!Array.isArray(framesValue)) {
          return respondError(response, 400, 'ValidationFailed', 'field frames must be an array', false);
        }
        const frames = framesValue.map((frame, index) => {
          if (typeof frame !== 'object' || frame === null) {
            throw new DomainError('ValidationFailed', `frames[${index}] must be an object`);
          }
          const record = frame as Record<string, unknown>;
          const direction = stringField(record, 'direction');
          if (direction !== 'sent' && direction !== 'received') {
            throw new DomainError('ValidationFailed', `frames[${index}]: direction must be sent or received`);
          }
          return { direction: direction as 'sent' | 'received', payload: stringField(record, 'payload') };
        });
        const result = service.importWsFrames(operator, { targetUrl: stringField(body, 'targetUrl'), frames });
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/websocket/send') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const messages = stringArrayField(body, 'messages');
        const result = await service.sendWsMessages(operator, {
          targetUrl: stringField(body, 'targetUrl'),
          messages,
          ...(typeof body.role === 'string' ? { role: stringField(body, 'role') } : {}),
          ...(body.subprotocols === undefined ? {} : { subprotocols: stringArrayField(body, 'subprotocols') }),
        });
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/tools/transport/negotiate') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const requested = typeof body.requested === 'string' ? stringField(body, 'requested') : undefined;
        if (requested !== undefined && requested !== 'h2' && requested !== 'http/1.1' && requested !== 'h3') {
          return respondError(response, 400, 'ValidationFailed', 'field requested must be one of h2/http/1.1/h3', false);
        }
        const result = await service.negotiateTransportFor(operator, {
          targetUrl: stringField(body, 'targetUrl'),
          allowFallback: body.allowFallback === true,
          ...(requested === undefined ? {} : { requested: requested as 'h2' | 'http/1.1' | 'h3' }),
        });
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/tools/transport/validate-headers') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const headersValue = body.headers;
        if (!Array.isArray(headersValue) || headersValue.some((entry) => !Array.isArray(entry) || entry.length !== 2 || entry.some((value) => typeof value !== 'string'))) {
          return respondError(response, 400, 'ValidationFailed', 'field headers must be an array of [name, value] string pairs', false);
        }
        const result = service.validateTransportHeaders(operator, {
          headers: headersValue as readonly (readonly [string, string])[],
          scheme: stringField(body, 'scheme'),
        });
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/tools/dom-flows') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const observationsValue = body.observations;
        if (!Array.isArray(observationsValue)) {
          return respondError(response, 400, 'ValidationFailed', 'field observations must be an array', false);
        }
        const observations = observationsValue.map((observation, index) => {
          if (typeof observation !== 'object' || observation === null) {
            throw new DomainError('ValidationFailed', `observations[${index}] must be an object`);
          }
          const record = observation as Record<string, unknown>;
          return { api: stringField(record, 'api'), marker: stringField(record, 'marker') };
        });
        const nodesValue = body.nodes;
        const nodes = nodesValue === undefined || !Array.isArray(nodesValue) ? undefined : nodesValue.map((node: unknown, index: number) => {
          if (typeof node !== 'object' || node === null) {
            throw new DomainError('ValidationFailed', `nodes[${index}] must be an object`);
          }
          const record = node as Record<string, unknown>;
          return { text: stringField(record, 'text'), looksLikePii: record.looksLikePii === true };
        });
        const result = await service.analyzeDomFlows(operator, {
          targetUrl: stringField(body, 'targetUrl'),
          observations,
          ...(nodes === undefined ? {} : { nodes }),
          live: body.live === true,
          ...(typeof body.role === 'string' ? { role: stringField(body, 'role') } : {}),
        });
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/extensions') {
      return respondJson(response, 200, { extensions: service.listExtensions() });
    }
    if (route === 'POST /api/extensions') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const result = service.installExtension(operator, {
          extensionId: stringField(body, 'extensionId'),
          version: stringField(body, 'version'),
          signature: stringField(body, 'signature'),
          publisherTrusted: body.publisherTrusted === true,
          permissions: stringArrayField(body, 'permissions'),
          apiRange: stringArrayField(body, 'apiRange'),
        });
        return respondJson(response, 201, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/certificates/ca') {
      return respondJson(response, 200, { profiles: service.listCaProfiles() });
    }
    if (route === 'POST /api/certificates/ca/trust') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const result = service.setCaProfileTrust(operator, stringField(body, 'profileId'), body.trusted === true);
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/documents/hints') {
      return respondJson(response, 200, { hints: service.listDocumentHints() });
    }
    if (route === 'POST /api/documents/hints') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const result = service.registerDocumentHints(operator, {
          documentLabel: stringField(body, 'documentLabel'),
          urls: stringArrayField(body, 'urls'),
        });
        return respondJson(response, 201, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/documents/priority-hints') {
      return respondJson(response, 200, { rules: service.listDocumentPriorityRules() });
    }
    if (route === 'POST /api/documents/priority-hints') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const rulesValue = body.rules;
        if (!Array.isArray(rulesValue)) {
          return respondError(response, 400, 'ValidationFailed', 'field rules must be an array', false);
        }
        const rules = rulesValue.map((rule: unknown, index: number) => {
          if (typeof rule !== 'object' || rule === null) {
            throw new DomainError('ValidationFailed', `rules[${index}] must be an object`);
          }
          const record = rule as Record<string, unknown>;
          const category = stringField(record, 'category');
          if (category !== 'pii' && category !== 'payment') {
            throw new DomainError('ValidationFailed', `rules[${index}]: category must be pii or payment`);
          }
          return { urlIncludes: stringField(record, 'urlIncludes'), category: category as 'pii' | 'payment' };
        });
        const result = service.registerDocumentPriorityHints(operator, {
          documentLabel: stringField(body, 'documentLabel'),
          rules,
        });
        return respondJson(response, 201, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/documents/parameter-hints') {
      return respondJson(response, 200, { hints: service.listDocumentParameterHints() });
    }
    if (route === 'POST /api/documents/parameter-hints') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const parametersValue = body.parameters;
        if (!Array.isArray(parametersValue)) {
          return respondError(response, 400, 'ValidationFailed', 'field parameters must be an array', false);
        }
        const parameters = parametersValue.map((parameter: unknown, index: number) => {
          if (typeof parameter !== 'object' || parameter === null) {
            throw new DomainError('ValidationFailed', `parameters[${index}] must be an object`);
          }
          const record = parameter as Record<string, unknown>;
          return { name: stringField(record, 'name'), values: stringArrayField(record, 'values') };
        });
        const result = service.registerDocumentParameterHints(operator, {
          documentLabel: stringField(body, 'documentLabel'),
          parameters,
        });
        return respondJson(response, 201, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/documents/auth-hints') {
      return respondJson(response, 200, { hints: service.listDocumentAuthHints() });
    }
    if (route === 'POST /api/documents/auth-hints') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const entriesValue = body.entries;
        if (!Array.isArray(entriesValue)) {
          return respondError(response, 400, 'ValidationFailed', 'field entries must be an array', false);
        }
        const entries = entriesValue.map((entry, index) => {
          if (typeof entry !== 'object' || entry === null) {
            throw new DomainError('ValidationFailed', `entries[${index}] must be an object`);
          }
          const record = entry as Record<string, unknown>;
          if (record.secretValue !== undefined || record.secret !== undefined) {
            throw new DomainError('ValidationFailed', `entries[${index}]: secret values are not accepted; document location only`);
          }
          const authMethod = stringField(record, 'authMethod');
          if (!DocumentAuthMethods.includes(authMethod as DocumentAuthMethod)) {
            throw new DomainError('ValidationFailed', `entries[${index}]: authMethod not allowed: ${authMethod}`);
          }
          return {
            role: stringField(record, 'role'),
            authMethod: authMethod as DocumentAuthMethod,
            documentLocation: stringField(record, 'documentLocation'),
          };
        });
        const result = service.registerDocumentAuthHints(operator, {
          documentLabel: stringField(body, 'documentLabel'),
          entries,
        });
        return respondJson(response, 201, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/findings/merge') {
      const body = await readJsonBody(request, response);
      if (body === undefined) return;
      try {
        return respondJson(response, 200, { findings: service.mergeFindings(operator, stringField(body, 'findingId'), stringField(body, 'intoFindingId'), stringField(body, 'reason')) });
      } catch (cause) { return respondDomainError(response, cause); }
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
        const reproduction = stringField(body, 'reproduction');
        if (reproduction !== 'reproduced' && reproduction !== 'not-reproduced') {
          return respondError(response, 400, 'ValidationFailed', "field reproduction must be 'reproduced' or 'not-reproduced'", false);
        }
        const cvssVersion = stringField(body, 'cvssVersion');
        const cvssVector = stringField(body, 'cvssVector');
        const rawCvssScore = body.cvssScore;
        const cvssScore = typeof rawCvssScore === 'number' ? rawCvssScore : Number.NaN;
        const hasCvss = cvssVersion !== '' || cvssVector !== '' || Number.isFinite(cvssScore);
        if (hasCvss && ((cvssVersion !== '3.1' && cvssVersion !== '4.0') || cvssVector === '' || !Number.isFinite(cvssScore))) {
          return respondError(response, 400, 'ValidationFailed', 'CVSS version, vector and numeric score must be supplied together', false);
        }
        const finding = service.updateFindingStatus(operator, {
          findingId,
          next: status,
          reproduction,
          notes: stringField(body, 'notes'),
          severityRationale: stringField(body, 'severityRationale'),
          ...(hasCvss ? { cvss: { version: cvssVersion as '3.1' | '4.0', vector: cvssVector, score: cvssScore } } : {}),
        });
        return respondJson(response, 200, { finding });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/tools/hash' || route === 'POST /api/tools/compare-binary') {
      const body = await readJsonBody(request, response, 5 * 1024 * 1024);
      if (body === undefined) return;
      try {
        if (!operator.permissions.includes('case.read')) {
          return respondError(response, 403, 'PermissionDenied', 'analysis tools require case.read', false);
        }
        if (route === 'POST /api/tools/hash') {
          const input = Buffer.from(stringField(body, 'inputText'), 'utf8');
          if (input.length > 1024 * 1024) throw new DomainError('ValidationFailed', 'hash input exceeds 1 MiB');
          return respondJson(response, 200, fingerprintBytes(input));
        }
        return respondJson(response, 200, compareBinaryRows(parseComparisonHex(stringField(body, 'left')), parseComparisonHex(stringField(body, 'right')), body.offset === undefined ? 0 : numberField(body, 'offset')));
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
    if (route === 'GET /api/repeater') {
      return respondJson(response, 200, { drafts: service.listRepeaterDrafts(), attempts: service.repeaterAttemptLog() });
    }
    if (route === 'POST /api/repeater/drafts') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const protocol = stringField(body, 'protocol');
        if (protocol !== 'http/1.1' && protocol !== 'http/2') {
          return respondError(response, 400, 'ValidationFailed', "field protocol must be 'http/1.1' or 'http/2'", false);
        }
        const draft = service.createRepeaterDraft(operator, { targetUrl: stringField(body, 'targetUrl'), protocol });
        return respondJson(response, 201, { draft });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/repeater/edit') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const headers = headerPairsField(body);
        const draft = service.editRepeaterDraft(operator, stringField(body, 'draftId'), { headers, body: stringBodyField(body) });
        return respondJson(response, 200, { draft });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/repeater/send') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        // role 指定時はその role の session cookie を適用する (design/08)。
        const role = typeof body.role === 'string' ? stringField(body, 'role') : undefined;
        const result = await service.sendRepeaterDraft(operator, stringField(body, 'draftId'), stringField(body, 'confirmedPlanHash'), role);
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/fuzzer/payload-sets') {
      return respondJson(response, 200, { sets: service.listPayloadSets() });
    }
    if (route === 'POST /api/fuzzer/payload-sets') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const result = service.registerPayloadSet(operator, {
          name: stringField(body, 'name'),
          source: stringField(body, 'source'),
          version: stringField(body, 'version'),
          license: stringField(body, 'license'),
          sha256: stringField(body, 'sha256'),
          values: stringArrayField(body, 'values'),
        });
        return respondJson(response, 201, { set: result });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/fuzzer/status') return respondJson(response, 200, service.fuzzerStatus());
    if (route === 'GET /api/fuzzer/jobs') {
      try { return respondJson(response, 200, service.getFuzzJob(url.searchParams.get('runId') ?? '')); }
      catch (cause) { return respondDomainError(response, cause); }
    }
    if (route === 'POST /api/fuzzer/stop') {
      const body = await readJsonBody(request, response);
      if (body === undefined) return;
      try { return respondJson(response, 200, service.stopFuzzJob(operator, stringField(body, 'runId'))); }
      catch (cause) { return respondDomainError(response, cause); }
    }
    if (route === 'GET /api/fuzzer/runs') {
      return respondJson(response, 200, { runs: service.listFuzzRuns() });
    }
    if (route === 'POST /api/fuzzer/runs' || route === 'POST /api/fuzzer/jobs') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const positionsValue = body.positions;
        if (!Array.isArray(positionsValue)) {
          return respondError(response, 400, 'ValidationFailed', 'field positions must be an array', false);
        }
        const positions = positionsValue.map((position, index) => {
          if (typeof position !== 'object' || position === null) {
            throw new DomainError('ValidationFailed', `positions[${index}] must be an object`);
          }
          const record = position as Record<string, unknown>;
          return { name: stringField(record, 'name'), values: record.values === undefined ? [] : stringArrayField(record, 'values'), ...(record.payloadSet === undefined ? {} : { payloadSet: stringField(record, 'payloadSet') }) };
        });
        let replay: import('@scopepilot2/contracts').FuzzInput['request'];
        if (body.request !== undefined) {
          if (typeof body.request !== 'object' || body.request === null || Array.isArray(body.request)) throw new DomainError('ValidationFailed', 'invalid request');
          const record = body.request as Record<string, unknown>;
          replay = { method: stringField(record, 'method') as NonNullable<typeof replay>['method'], bodyTemplate: stringField(record, 'bodyTemplate'), contentType: stringField(record, 'contentType') };
        }
        const input = {
          ...(replay === undefined ? {} : { request: replay }),
          ...(body.attack === undefined ? {} : { attack: stringField(body, 'attack') as import('@scopepilot2/contracts').FuzzAttack }),
          ...(body.requestsPerSecond === undefined ? {} : { requestsPerSecond: numberField(body, 'requestsPerSecond') }),
          targetUrl: stringField(body, 'targetUrl'),
          positions,
          ...(body.maxRequests === undefined ? {} : { maxRequests: numberField(body, 'maxRequests') }),
          // role 指定時はその role の session cookie を適用する (design/08)。
          ...(typeof body.role === 'string' ? { role: stringField(body, 'role') } : {}),
        };
        const result = route === 'POST /api/fuzzer/jobs' ? service.startFuzzJob(operator, input) : await service.runFuzzSession(operator, input);
        return respondJson(response, route === 'POST /api/fuzzer/jobs' ? 202 : 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/authentication') {
      return respondJson(response, 200, service.authenticationConfiguration());
    }
    if (route === 'POST /api/authentication/users') {
      const body = await readJsonBody(request, response);
      if (body === undefined) return;
      try {
        if (Object.keys(body).some((key) => !['role', 'displayName', 'authorizationRole', 'method', 'enabled'].includes(key)) || typeof body.enabled !== 'boolean') {
          throw new DomainError('ValidationFailed', 'only user metadata and an enabled boolean are accepted; never send credentials');
        }
        const user = service.saveAuthenticationUser(operator, { role: stringField(body, 'role'), displayName: stringField(body, 'displayName'), authorizationRole: stringField(body, 'authorizationRole'), method: stringField(body, 'method') as AuthenticationMethod, enabled: body.enabled });
        return respondJson(response, 200, { user });
      } catch (cause) { return respondDomainError(response, cause); }
    }
    if (route === 'POST /api/sessions/verify') {
      const body = await readJsonBody(request, response);
      if (body === undefined) return;
      try { return respondJson(response, 200, await service.verifySession(operator, stringField(body, 'role'))); }
      catch (cause) { return respondDomainError(response, cause); }
    }
    if (route === 'GET /api/sessions') {
      return respondJson(response, 200, { sessions: service.listSessions() });
    }
    if (route === 'POST /api/sessions/flows') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const stepsValue = body.steps;
        if (!Array.isArray(stepsValue)) {
          return respondError(response, 400, 'ValidationFailed', 'field steps must be an array', false);
        }
        const steps = stepsValue.map((step, index) => {
          if (typeof step !== 'object' || step === null) {
            throw new DomainError('ValidationFailed', `steps[${index}] must be an object`);
          }
          const record = step as Record<string, unknown>;
          if (record.secretValue !== undefined) {
            throw new DomainError('ValidationFailed', `steps[${index}]: inline secret values are not accepted; use secretReference`);
          }
          const kind = stringField(record, 'kind') as LoginFlowStep['kind'];
          const built: { kind: LoginFlowStep['kind']; target?: string; secretReference?: string; value?: string } = { kind };
          if (record.target !== undefined) {
            built.target = stringField(record, 'target');
          }
          if (record.secretReference !== undefined) {
            built.secretReference = stringField(record, 'secretReference');
          }
          if (record.value !== undefined) {
            built.value = stringField(record, 'value');
          }
          return built;
        });
        const result = service.registerLoginFlow(operator, {
          role: stringField(body, 'role'),
          flowVersion: stringField(body, 'flowVersion'),
          steps,
        });
        return respondJson(response, 201, { flow: result });
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/sessions/login') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const secretValuesValue = body.secretValues;
        if (typeof secretValuesValue !== 'object' || secretValuesValue === null || Array.isArray(secretValuesValue)) {
          return respondError(response, 400, 'ValidationFailed', 'field secretValues must be an object of strings', false);
        }
        const secretValues: Record<string, string> = {};
        for (const [name, value] of Object.entries(secretValuesValue)) {
          if (typeof value !== 'string') {
            throw new DomainError('ValidationFailed', `secretValues['${name}'] must be a string`);
          }
          secretValues[name] = value;
        }
        const result = await service.runLogin(operator, {
          role: stringField(body, 'role'),
          baseUrl: stringField(body, 'baseUrl'),
          expectedUrlPrefix: stringField(body, 'expectedUrlPrefix'),
          secretValues,
          ...(typeof body.proxyServer === 'string' ? { proxyServer: stringField(body, 'proxyServer') } : {}),
        });
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/sessions/refresh') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const result = await service.refreshSession(operator, stringField(body, 'role'));
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'POST /api/sessions/cookies') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const result = service.assignRoleCookies(operator, stringField(body, 'role'), stringArrayField(body, 'cookieNames'));
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/business-logic/checks') {
      return respondJson(response, 200, { checks: service.listBusinessLogicChecks() });
    }
    if (route === 'POST /api/business-logic/checks') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const expectationValue = body.expectation;
        if (typeof expectationValue !== 'object' || expectationValue === null) {
          return respondError(response, 400, 'ValidationFailed', 'field expectation must be an object', false);
        }
        const expectationRecord = expectationValue as Record<string, unknown>;
        const argsValue = expectationRecord.args;
        if (!Array.isArray(argsValue)) {
          return respondError(response, 400, 'ValidationFailed', 'field expectation.args must be an array', false);
        }
        const result = await service.runBusinessLogicCheck(operator, {
          roles: stringArrayField(body, 'roles'),
          targetUrl: stringField(body, 'targetUrl'),
          expectation: { expression: stringField(expectationRecord, 'expression'), args: argsValue },
        });
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/auth-bypass/checks') {
      return respondJson(response, 200, { checks: service.listAuthBypassChecks() });
    }
    if (route === 'POST /api/auth-bypass/checks') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const secretValuesValue = body.secretValues;
        if (secretValuesValue !== undefined && (typeof secretValuesValue !== 'object' || secretValuesValue === null || Array.isArray(secretValuesValue))) {
          return respondError(response, 400, 'ValidationFailed', 'field secretValues must be an object of strings', false);
        }
        const secretValues: Record<string, string> = {};
        if (secretValuesValue !== undefined) {
          for (const [name, value] of Object.entries(secretValuesValue as Record<string, unknown>)) {
            if (typeof value !== 'string') {
              throw new DomainError('ValidationFailed', `secretValues['${name}'] must be a string`);
            }
            secretValues[name] = value;
          }
        }
        const result = await service.runAuthBypassCheck(operator, {
          role: stringField(body, 'role'),
          ...(Array.isArray(body.targetUrls) ? { targetUrls: stringArrayField(body, 'targetUrls') } : {}),
          ...(Array.isArray(body.authCookieNames) ? { authCookieNames: stringArrayField(body, 'authCookieNames') } : {}),
          ...(body.includeLoginVariants === undefined ? {} : { includeLoginVariants: body.includeLoginVariants === true }),
          ...(Object.keys(secretValues).length === 0 ? {} : { secretValues }),
          ...(typeof body.loginBaseUrl === 'string' ? { loginBaseUrl: stringField(body, 'loginBaseUrl') } : {}),
        });
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/zap-unsupported/checks') {
      return respondJson(response, 200, { checks: service.listZapUnsupportedChecks() });
    }
    if (route === 'POST /api/zap-unsupported/checks') {
      const body = await readJsonBody(request, response);
      if (body === undefined) {
        return;
      }
      try {
        const paramsValue = body.params;
        if (paramsValue !== undefined && (typeof paramsValue !== 'object' || paramsValue === null || Array.isArray(paramsValue))) {
          return respondError(response, 400, 'ValidationFailed', 'field params must be an object of strings', false);
        }
        const params: Record<string, string> = {};
        if (paramsValue !== undefined) {
          for (const [name, value] of Object.entries(paramsValue as Record<string, unknown>)) {
            if (typeof value !== 'string') {
              throw new DomainError('ValidationFailed', `params['${name}'] must be a string`);
            }
            params[name] = value;
          }
        }
        const secretValuesValue = body.secretValues;
        if (secretValuesValue !== undefined && (typeof secretValuesValue !== 'object' || secretValuesValue === null || Array.isArray(secretValuesValue))) {
          return respondError(response, 400, 'ValidationFailed', 'field secretValues must be an object of strings', false);
        }
        const secretValues: Record<string, string> = {};
        if (secretValuesValue !== undefined) {
          for (const [name, value] of Object.entries(secretValuesValue as Record<string, unknown>)) {
            if (typeof value !== 'string') {
              throw new DomainError('ValidationFailed', `secretValues['${name}'] must be a string`);
            }
            secretValues[name] = value;
          }
        }
        const result = await service.runZapUnsupportedCheck(operator, {
          themeNo: stringField(body, 'themeNo'),
          ...(typeof body.role === 'string' && body.role !== '' ? { role: stringField(body, 'role') } : {}),
          ...(Array.isArray(body.targetUrls) ? { targetUrls: stringArrayField(body, 'targetUrls') } : {}),
          ...(Object.keys(params).length === 0 ? {} : { params }),
          ...(Object.keys(secretValues).length === 0 ? {} : { secretValues }),
        });
        return respondJson(response, 200, result);
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/traffic') {
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam === null ? 100 : Number(limitParam);
      if (!Number.isInteger(limit)) {
        return respondError(response, 400, 'ValidationFailed', 'limit must be an integer', false);
      }
      try {
        return respondJson(response, 200, service.listTraffic(limit));
      } catch (cause) {
        return respondDomainError(response, cause);
      }
    }
    if (route === 'GET /api/traffic/site-map') {
      return respondJson(response, 200, { endpoints: service.listSiteMapEndpoints() });
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
      try {
        const since = cursorField(url.searchParams.get('since') ?? request.headers['last-event-id'] ?? '0');
        const matches = (e: { jobId?: string }): boolean => !url.searchParams.has('jobId') || e.jobId === url.searchParams.get('jobId');
        const events = service.events().map((e, index) => ({ ...e, eventId: index + 1 })).filter(e => e.eventId > since && matches(e));
        if ((request.headers.accept ?? '').includes('text/event-stream')) {
          streamEvents(response, events, listener => service.subscribeAudit((e, seq) => { if (seq > since && matches(e)) listener({ ...e, eventId: seq }); }), e => e.eventId, e => e.type);
        } else respondNdjson(response, events);
        return;
      } catch (cause) { return respondDomainError(response, cause); }
    }
    if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      return respondError(response, 404, 'NotFound', `unknown route: ${route}`, false);
    }
    return respondError(response, 405, 'MethodNotAllowed', `method not allowed: ${method}`, false);
  }

  return server;
}

async function readJsonBody(request: IncomingMessage, response: ServerResponse, maximumBytes = MAX_BODY_BYTES): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maximumBytes) {
      respondError(response, 400, 'ValidationFailed', `request body exceeds ${maximumBytes} bytes`, false);
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

/** headers は [name, value] の pair 配列として受ける (改行入りは domain が拒否)。 */
function headerPairsField(body: Record<string, unknown>): readonly (readonly [string, string])[] {
  const value = body.headers;
  if (!Array.isArray(value) || value.some((entry) => !Array.isArray(entry) || entry.length !== 2 || entry.some((part) => typeof part !== 'string'))) {
    throw new DomainError('ValidationFailed', 'field headers must be an array of [name, value] string pairs');
  }
  return value as readonly (readonly [string, string])[];
}

function stringBodyField(body: Record<string, unknown>): string {
  const value = body.body;
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new DomainError('ValidationFailed', 'field body must be a string');
  }
  return value;
}

function sequencerReplayRequestField(body: Record<string, unknown>): { method?: string; headers?: readonly (readonly [string, string])[]; body?: string } {
  const replay = structField(body, 'replayRequest');
  const result: { method?: string; headers?: readonly (readonly [string, string])[]; body?: string } = {};
  if (replay.method !== undefined) result.method = stringField(replay, 'method');
  if (replay.headers !== undefined) result.headers = headerPairsField(replay);
  if (replay.body !== undefined) result.body = stringField(replay, 'body');
  return result;
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

function interactiveDiagnosticInputField(body: Record<string, unknown>): import('./baseline-flow.ts').InteractiveDiagnosticRunInput {
  if (body.confirmed !== true) throw new DomainError('ValidationFailed', 'field confirmed must be true');
  if (!Array.isArray(body.items) || !Array.isArray(body.files) || !Array.isArray(body.apiDocuments)) {
    throw new DomainError('ValidationFailed', 'interactive diagnostic items, files, and apiDocuments must be arrays');
  }
  const tracks = new Set(['workflow-state', 'session-analysis', 'authorization-differential', 'upload-workflow', 'api-schema', 'cryptography-review']);
  const tokenSources = new Set(['body', 'cookie', 'hidden', 'bearer', 'custom']);
  const requiredInputs = new Set(['upload-file', 'api-spec', 'additional-role-session']);
  const stepKinds = new Set(['navigate', 'fill', 'select', 'click', 'wait', 'assert', 'assertValue', 'upload']);
  const items = body.items.map((entry, itemIndex) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new DomainError('ValidationFailed', `items[${itemIndex}] must be an object`);
    const item = entry as Record<string, unknown>;
    const track = stringField(item, 'track');
    const tokenSource = stringField(item, 'tokenSource');
    const expectation = stringField(item, 'expectation');
    if (!tracks.has(track) || !tokenSources.has(tokenSource) || !['same', 'different'].includes(expectation)) {
      throw new DomainError('ValidationFailed', `items[${itemIndex}] contains an unsupported enum value`);
    }
    if (!Array.isArray(item.steps)) throw new DomainError('ValidationFailed', `items[${itemIndex}].steps must be an array`);
    const steps = item.steps.map((entryStep, stepIndex) => {
      if (typeof entryStep !== 'object' || entryStep === null || Array.isArray(entryStep)) throw new DomainError('ValidationFailed', `items[${itemIndex}].steps[${stepIndex}] must be an object`);
      const step = entryStep as Record<string, unknown>;
      const kind = stringField(step, 'kind');
      const target = stringField(step, 'target');
      if (!stepKinds.has(kind)) throw new DomainError('ValidationFailed', `unsupported browser step kind: ${kind}`);
      if (kind === 'fill' || kind === 'select' || kind === 'assertValue') return { kind, target, value: stringField(step, 'value') };
      if (kind === 'upload') return { kind, target, inputRef: stringField(step, 'inputRef') };
      return { kind, target };
    });
    const required = stringArrayField(item, 'requiredInputs');
    if (required.some((value) => !requiredInputs.has(value))) throw new DomainError('ValidationFailed', `items[${itemIndex}].requiredInputs contains an unsupported value`);
    return {
      itemId: stringField(item, 'itemId'),
      track: track as import('./baseline-flow.ts').InteractiveDiagnosticTrack,
      targetUrl: stringField(item, 'targetUrl'),
      role: stringField(item, 'role'),
      roles: stringArrayField(item, 'roles'),
      summary: stringField(item, 'summary'),
      steps: steps as import('../ports/engines.ts').InteractiveBrowserStep[],
      samples: numberField(item, 'samples'),
      tokenSource: tokenSource as 'body' | 'cookie' | 'hidden' | 'bearer' | 'custom',
      tokenName: stringField(item, 'tokenName'),
      expectation: expectation as 'same' | 'different',
      requiredInputs: required as ('upload-file' | 'api-spec' | 'additional-role-session')[],
    };
  });
  const files = body.files.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new DomainError('ValidationFailed', `files[${index}] must be an object`);
    const file = entry as Record<string, unknown>;
    return { inputRef: stringField(file, 'inputRef'), name: stringField(file, 'name'), mimeType: stringField(file, 'mimeType'), dataBase64: stringField(file, 'dataBase64') };
  });
  const apiDocuments = body.apiDocuments.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new DomainError('ValidationFailed', `apiDocuments[${index}] must be an object`);
    const document = entry as Record<string, unknown>;
    return { inputRef: stringField(document, 'inputRef'), name: stringField(document, 'name'), document: document.document };
  });
  return { confirmed: true, items, files, apiDocuments };
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

function requireJobPermission(operator: OperatorProfile, permission: 'case.read' | 'run.manage'): void {
  if (!operator.permissions.includes(permission)) throw new DomainError('PermissionDenied', `missing permission: ${permission}`);
}
function cursorField(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new DomainError('ValidationFailed', 'cursor must be a non-negative safe integer');
  return Number(value);
}
function respondNdjson(response: ServerResponse, events: readonly unknown[]): void {
  response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
  response.end(events.map(e => JSON.stringify(e) + '\n').join(''));
}
function streamEvents<T>(response: ServerResponse, replay: readonly T[], subscribe: (listener: (e: T) => void) => () => void, seq: (e: T) => number, name: (e: T) => string): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  response.flushHeaders();
  // Snapshot, replay and subscribe run synchronously: no asynchronous gap can lose events.
  const send = (e: T): void => {
    if (response.destroyed) return;
    // A slow consumer reconnects using its last received ID; never grow an unbounded queue.
    if (response.writableLength > 1024 * 1024) { response.destroy(); return; }
    response.write(`id: ${seq(e)}\nevent: ${name(e)}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  for (const e of replay) send(e);
  const unsubscribe = subscribe(send);
  const timer = setInterval(() => { response.write(': keep-alive\n\n'); }, 15_000);
  timer.unref();
  response.once('close', () => { clearInterval(timer); unsubscribe(); });
}

function objectField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DomainError('ValidationFailed', `${key} must be an object`);
  return value as Record<string, unknown>;
}

function sequencerParamsField(body: Record<string, unknown>): SequencerJobParams {
  const tokenSource = body.tokenSource ?? 'body';
  if (typeof tokenSource !== 'string' || !['body', 'cookie', 'hidden', 'bearer', 'custom'].includes(tokenSource)) throw new DomainError('ValidationFailed', 'unknown tokenSource');
  return {
    targetUrl: stringField(body, 'targetUrl'),
    samples: numberField(body, 'samples'),
    ...(typeof body.role === 'string' ? { role: stringField(body, 'role') } : {}),
    tokenSource: tokenSource as NonNullable<SequencerJobParams['tokenSource']>,
    ...(body.tokenCookieName === undefined ? {} : { tokenCookieName: stringField(body, 'tokenCookieName') }),
    ...(body.tokenFieldName === undefined ? {} : { tokenFieldName: stringField(body, 'tokenFieldName') }),
    ...(body.tokenStartDelimiter === undefined ? {} : { tokenStartDelimiter: stringField(body, 'tokenStartDelimiter') }),
    ...(body.tokenEndDelimiter === undefined ? {} : { tokenEndDelimiter: stringField(body, 'tokenEndDelimiter') }),
    ...(body.replayRequest === undefined ? {} : { replayRequest: sequencerReplayRequestField(body) }),
  };
}
