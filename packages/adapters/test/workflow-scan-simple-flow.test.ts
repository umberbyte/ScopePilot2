import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import type { ActiveScanEnginePort, EvidenceStorePort, ExplorationPort, LoginExecutorPort, StoredEvidence } from '@scopepilot2/core';
import { BaselineFlowService, FixedClock, SequentialIdGenerator, WORKFLOW_SCAN_CHECK_IDS, WORKFLOW_SCAN_PAYLOAD_SET } from '@scopepilot2/core';
import type { EngineCapabilitySnapshot, OperatorProfile } from '@scopepilot2/contracts';
import { NodeWorkflowScanTransport } from '../src/workflow-scan-transport.ts';

const NOW = '2026-11-01T00:00:00.000Z';
const OPERATOR: OperatorProfile = {
  operatorId: 'simple-user', displayName: 'Simple User',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

class CapturingEvidenceStore implements EvidenceStorePort {
  readonly contents: string[] = [];
  private sequence = 0;
  async saveText(label: string, content: string, metadata?: Readonly<Record<string, string>>): Promise<StoredEvidence> {
    this.contents.push(content);
    this.sequence += 1;
    return { evidenceId: `evidence-${String(this.sequence)}`, sha256: `sha256-${String(this.sequence)}`, label, savedAt: NOW, ...(metadata === undefined ? {} : { metadata }) };
  }
}

const explorer: ExplorationPort = { engineVersion: 'fixture-explorer', observe: async () => null };
const scanEngine: ActiveScanEnginePort = {
  engineVersion: 'fixture-zap',
  start: async () => 'fixture-zap-run',
  progress: async () => ({ status: 'complete', progress: 100, lastActivityAt: NOW, messageCount: 0 }),
  alerts: async (_runId, cursor) => ({ alerts: [], nextCursor: cursor }),
  stop: async () => undefined,
};

const capabilities: readonly EngineCapabilitySnapshot[] = [
  {
    engineKind: 'zap', engineVersion: scanEngine.engineVersion, source: 'fixture',
    guaranteeLevels: { preSendScopeEnforcement: 'Delegated', stopControl: 'Delegated', budgetLease: 'Delegated', rateLimit: 'Delegated' },
    maxOvershootRatio: 0.05, measuredAt: NOW,
  },
  {
    engineKind: 'node-http', engineVersion: 'scopepilot-http-diagnostic-v1', source: 'fixture',
    guaranteeLevels: { preSendScopeEnforcement: 'Enforced', stopControl: 'Enforced', budgetLease: 'Enforced', rateLimit: 'Enforced' },
    maxOvershootRatio: 0, measuredAt: NOW,
  },
];

describe('Simple mode generic HTTP diagnostics integration', () => {
  let server: Server | undefined;
  let baseUrl = '';

  before(async () => {
    server = createServer((request, response) => {
      const target = new URL(request.url ?? '/', 'http://fixture.invalid');
      const origin = request.headers.origin;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Set-Cookie', 'app_session=opaque');
      if (typeof origin === 'string') {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      const next = target.searchParams.get('next');
      if (next?.startsWith('https://') === true) {
        response.statusCode = 302;
        response.setHeader('Location', next);
        response.end('redirect');
        return;
      }
      if (target.searchParams.get('file')?.includes('../') === true) {
        response.end('root:x:0:0:root:/root:/bin/bash');
        return;
      }
      const query = target.searchParams.get('q') ?? '';
      if (query === "'") {
        response.statusCode = 500;
        response.end('SQL syntax error near quotation');
        return;
      }
      response.end(`<html><body>${query}</body></html>`);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fixture server did not bind');
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server?.close((error) => error === undefined ? resolve() : reject(error)) ?? resolve());
  });

  test('confirmed plan runs against an arbitrary observed route and reuses the role session', async () => {
    const evidence = new CapturingEvidenceStore();
    const sessionSecret = 'role-session-secret';
    const loginExecutor: LoginExecutorPort = {
      engineVersion: 'fixture-login',
      execute: async (input) => ({
        authenticated: true,
        finalUrl: `${input.baseUrl}/account`,
        cookies: [{ name: 'app_auth', value: sessionSecret, domain: '127.0.0.1', path: '/' }],
      }),
    };
    const factoryCalls: { baseUrl: string; redactionValues: readonly string[]; sessionCookies?: readonly { name: string; value: string }[] }[] = [];
    const service = new BaselineFlowService({
      runtimeProfile: 'test',
      clock: new FixedClock([NOW]), ids: new SequentialIdGenerator(), evidence, explorer, scanEngine, loginExecutor,
      capabilities, runtimeBundleHash: 'generic-http-fixture',
      workflowScanTransportFactory: (options) => {
        factoryCalls.push(options);
        return new NodeWorkflowScanTransport(options);
      },
    });
    service.createCase(OPERATOR, {
      name: 'Generic web application', allowedOrigins: [baseUrl], deniedOrigins: [],
      limits: { maxRequests: 500, maxPages: 100, maxDurationMinutes: 30 },
    });
    await service.grantAuthorization(OPERATOR, {
      allowedOperationClasses: ['Browse', 'ActiveScan'], targetRoles: ['member'],
      validFrom: '2026-10-31T00:00:00.000Z', validUntil: '2026-11-02T00:00:00.000Z',
      evidence: { label: 'test authorization', content: 'authorized fixture' },
    });
    service.registerLoginFlow(OPERATOR, {
      role: 'member', flowVersion: 'generic-login',
      steps: [{ kind: 'fill', target: '#username', secretReference: 'username' }, { kind: 'fill', target: '#password', secretReference: 'password' }, { kind: 'assert', target: 'Account' }],
    });
    await service.runLogin(OPERATOR, {
      role: 'member', baseUrl, expectedUrlPrefix: baseUrl,
      secretValues: { username: 'test-user', password: 'test-password' },
    });

    const target = `${baseUrl}/catalog?q=shirt&next=%2Fhome&file=manual.pdf`;
    const { plan } = service.buildActiveScanPlan(OPERATOR, [target], undefined, {
      includeWorkflowScan: true, guidelines: ['OWASP ASVS 5.0'],
    });
    assert.deepEqual(plan.steps.map((step) => step.kind), ['active-scan', 'workflow-scan']);
    assert.deepEqual(plan.steps[1]?.targetSnapshot, [target]);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, OPERATOR);
    const result = await service.runActiveScan(OPERATOR, plan, confirmation, [{
      candidateId: 'generic-catalog', url: target, method: 'GET', category: 'page',
      guidelineBasis: ['OWASP WSTG'], confidence: 1, observationUrl: target,
      inputPoints: [
        { name: 'q', location: 'query', type: 'string' },
        { name: 'next', location: 'query', type: 'string' },
        { name: 'file', location: 'query', type: 'string' },
      ],
      diagnosticTracks: ['zap-active'],
    }], 'member');

    assert.equal(result.workflow?.status, 'completed');
    assert.equal(result.workflow?.payloadSet, WORKFLOW_SCAN_PAYLOAD_SET);
    assert.ok((result.workflow?.checkKindCount ?? 0) >= 7);
    assert.ok((result.workflow?.checkKindCount ?? 0) <= WORKFLOW_SCAN_CHECK_IDS.length);
    assert.equal(result.workflow?.importedCount, result.workflow?.checkCount);
    assert.ok(factoryCalls.some((call) => call.sessionCookies?.some((cookie) => cookie.name === 'app_auth') === true));
    assert.ok(factoryCalls.every((call) => call.redactionValues.includes(sessionSecret)));
    assert.ok(!evidence.contents.join('\n').includes(sessionSecret));
    assert.ok(result.findings.some((finding) => finding.enginePluginId?.startsWith('workflow-scan:')));
    const workflowEvidenceText = evidence.contents.find((content) => content.includes('"totalRequestCount"'));
    assert.ok(workflowEvidenceText !== undefined);
    const workflowEvidence = JSON.parse(workflowEvidenceText) as { alerts: readonly { request: string; response: string }[] };
    assert.equal(workflowEvidence.alerts.length, result.workflow?.checkCount);
    assert.ok(workflowEvidence.alerts.every((entry) => /^[A-Z]+\s+\S+\s+HTTP\/1\.1/m.test(entry.request)));
  });
});
