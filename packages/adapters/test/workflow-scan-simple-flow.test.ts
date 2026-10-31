import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ActiveScanEnginePort, EvidenceStorePort, ExplorationPort, LoginExecutorPort, StoredEvidence } from '@scopepilot2/core';
import { BaselineFlowService, FixedClock, SequentialIdGenerator, WORKFLOW_SCAN_PAYLOAD_SET } from '@scopepilot2/core';
import type { EngineCapabilitySnapshot, OperatorProfile } from '@scopepilot2/contracts';
import { NodeWorkflowScanTransport } from '../src/workflow-scan-transport.ts';
import { startFakeDvwaServer, type FakeDvwaServer } from './fake-dvwa-server.ts';

const NOW = '2026-10-26T00:00:00.000Z';
const OPERATOR: OperatorProfile = {
  operatorId: 'simple-user',
  displayName: 'Simple User',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

class CapturingEvidenceStore implements EvidenceStorePort {
  readonly contents: string[] = [];
  private sequence = 0;

  async saveText(label: string, content: string, metadata?: Readonly<Record<string, string>>): Promise<StoredEvidence> {
    this.contents.push(content);
    this.sequence += 1;
    return {
      evidenceId: `evidence-${String(this.sequence)}`,
      sha256: `sha256-${String(this.sequence)}`,
      label,
      savedAt: NOW,
      ...(metadata === undefined ? {} : { metadata }),
    };
  }
}

const explorer: ExplorationPort = {
  engineVersion: 'fixture-explorer',
  observe: async () => null,
};

const scanEngine: ActiveScanEnginePort = {
  engineVersion: 'fixture-zap',
  start: async () => 'fixture-zap-run',
  progress: async () => ({ status: 'complete', progress: 100, lastActivityAt: NOW, messageCount: 0 }),
  alerts: async (_runId, cursor) => ({ alerts: [], nextCursor: cursor }),
  stop: async () => undefined,
};

const loginExecutor: LoginExecutorPort = {
  engineVersion: 'fixture-login',
  execute: async (input) => ({ authenticated: true, finalUrl: `${input.baseUrl}/index.php`, cookies: [] }),
};

const capabilities: readonly EngineCapabilitySnapshot[] = [
  {
    engineKind: 'zap',
    engineVersion: scanEngine.engineVersion,
    source: 'fixture',
    guaranteeLevels: { preSendScopeEnforcement: 'Delegated', stopControl: 'Delegated', budgetLease: 'Delegated', rateLimit: 'Delegated' },
    maxOvershootRatio: 0.05,
    measuredAt: NOW,
  },
  {
    engineKind: 'node-http',
    engineVersion: 'scopepilot-workflow-transport-v1',
    source: 'fixture',
    guaranteeLevels: { preSendScopeEnforcement: 'Enforced', stopControl: 'Enforced', budgetLease: 'Enforced', rateLimit: 'Enforced' },
    maxOvershootRatio: 0,
    measuredAt: NOW,
  },
];

describe('Simple mode workflow scan integration', () => {
  let server: (FakeDvwaServer & { currentPassword: string }) | undefined;

  before(async () => {
    server = await startFakeDvwaServer('admin', 'SecretPass123') as FakeDvwaServer & { currentPassword: string };
  });

  after(async () => {
    await server?.close();
  });

  test('confirmed 21-check step runs, imports findings, updates routes, and redacts credentials', async () => {
    assert.ok(server !== undefined);
    const evidence = new CapturingEvidenceStore();
    const factoryCalls: { baseUrl: string; maxRequests: number; redactionValues: readonly string[] }[] = [];
    const service = new BaselineFlowService({
      clock: new FixedClock([NOW]),
      ids: new SequentialIdGenerator(),
      evidence,
      explorer,
      scanEngine,
      loginExecutor,
      capabilities,
      runtimeBundleHash: 'simple-workflow-fixture',
      workflowScanTransportFactory: (options) => {
        factoryCalls.push(options);
        return new NodeWorkflowScanTransport(options);
      },
    });
    service.createCase(OPERATOR, {
      name: 'DVWA simple mode',
      allowedOrigins: [server.baseUrl],
      deniedOrigins: [],
      limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 30 },
    });
    await service.grantAuthorization(OPERATOR, {
      allowedOperationClasses: ['Browse', 'ActiveScan'],
      targetRoles: ['member'],
      validFrom: '2026-10-25T00:00:00.000Z',
      validUntil: '2026-10-27T00:00:00.000Z',
      evidence: { label: 'test authorization', content: 'authorized fixture' },
    });
    service.registerLoginFlow(OPERATOR, {
      role: 'member',
      flowVersion: 'simple-test',
      steps: [
        { kind: 'fill', target: '#username', secretReference: 'simple:member:username' },
        { kind: 'fill', target: '#password', secretReference: 'simple:member:password' },
        { kind: 'assert', target: 'Logout' },
      ],
    });
    await service.runLogin(OPERATOR, {
      role: 'member',
      baseUrl: server.baseUrl,
      expectedUrlPrefix: server.baseUrl,
      secretValues: {
        'simple:member:username': 'admin',
        'simple:member:password': 'SecretPass123',
      },
    });

    const target = `${server.baseUrl}/vulnerabilities/sqli/`;
    const { plan } = service.buildActiveScanPlan(OPERATOR, [target], undefined, {
      includeWorkflowScan: true,
      guidelines: ['OWASP ASVS 5.0'],
    });
    assert.deepEqual(plan.guidelineIds, ['OWASP ASVS 5.0']);
    assert.deepEqual(plan.steps.map((step) => step.kind), ['active-scan', 'workflow-scan']);
    assert.equal(plan.steps.reduce((total, step) => total + step.limits.maxRequests, 0), plan.limits.maxRequests);
    assert.deepEqual(plan.steps[1]?.targetSnapshot, [new URL(server.baseUrl).origin + '/']);
    assert.equal(plan.steps[1]?.engineVersion, WORKFLOW_SCAN_PAYLOAD_SET);
    assert.match(WORKFLOW_SCAN_PAYLOAD_SET, /^scopepilot-workflow-payloads\/v2\.0\.0 sha256:[a-f0-9]{64}$/);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, OPERATOR);
    const result = await service.runActiveScan(OPERATOR, plan, confirmation, [{
      candidateId: 'dvwa-workflow',
      url: target,
      method: 'GET',
      category: 'form',
      guidelineBasis: ['OWASP WSTG'],
      confidence: 1,
      observationUrl: target,
      diagnosticTracks: ['workflow-state', 'session-analysis', 'authorization-differential', 'upload-workflow', 'api-schema', 'cryptography-review'],
    }], 'member');

    assert.equal(result.workflow?.status, 'completed');
    assert.equal(result.workflow?.payloadSet, WORKFLOW_SCAN_PAYLOAD_SET);
    assert.equal(result.workflow?.checkKindCount, 21);
    assert.ok((result.workflow?.checkCount ?? 0) >= 21);
    assert.equal(result.workflow?.importedCount, result.workflow?.checkCount);
    assert.ok((result.workflow?.requestCount ?? 0) <= (plan.steps[1]?.limits.maxRequests ?? 0));
    assert.ok(result.diagnosticRoutes.filter((route) => route.track !== 'zap-active').every((route) => route.status === 'executed'));
    assert.ok(result.findings.some((finding) => finding.enginePluginId?.startsWith('workflow-scan:')));
    assert.ok(factoryCalls.every((call) => call.redactionValues.includes('SecretPass123')));
    assert.ok(!evidence.contents.join('\n').includes('SecretPass123'));
    assert.ok(!evidence.contents.join('\n').includes('Sp-sp'));
    const workflowEvidenceText = evidence.contents.find((content) => content.includes('"totalRequestCount"'));
    assert.ok(workflowEvidenceText !== undefined);
    assert.ok(workflowEvidenceText.includes(`"payloadSet":"${WORKFLOW_SCAN_PAYLOAD_SET}"`));
    const workflowEvidence = JSON.parse(workflowEvidenceText) as {
      alerts: readonly { request: string; response: string }[];
    };
    assert.equal(workflowEvidence.alerts.length, result.workflow?.checkCount);
    assert.ok(workflowEvidence.alerts.every((entry) => /^[A-Z]+\s+\S+\s+HTTP\/1\.1/m.test(entry.request)));
    assert.ok(workflowEvidence.alerts.every((entry) => /^HTTP\/1\.1\s+\d{3}/m.test(entry.response)));
    assert.equal(server.currentPassword, 'SecretPass123');
    assert.equal(server.securityLevel, 'low');
  });
});
