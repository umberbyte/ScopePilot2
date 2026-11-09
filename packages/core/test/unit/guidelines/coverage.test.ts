import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { hashStable, type ExecutionPlan, type GuidelineCoverageRoute, type GuidelineItemExecution } from '@scopepilot2/contracts';
import { GuidelineCoverageService, aggregateGuidelineAssessment, snapshotGuidelineRoute } from '../../../src/domain/guideline-coverage.ts';
import { planHashOf } from '../../../src/domain/plan-service.ts';
import { buildReportModel, renderMarkdown } from '../../../src/domain/report-builder.ts';
import { createCoreApiServer } from '../../../src/application/api-server.ts';
import { bootstrapFlow, createTestService, TEST_OPERATOR } from '../support/test-flow.ts';

const routes = (JSON.parse(readFileSync(new URL('../../../../../docs/generated/guideline-catalog.json', import.meta.url), 'utf8')) as { coverageRoutes: GuidelineCoverageRoute[] }).coverageRoutes;
const route = routes.find((r) => r.itemId === 'WSTG-SESS-02')!;
const capability = { engineKind: 'node-http', engineVersion: '1', source: 'measured', guaranteeLevels: { preSendScopeEnforcement: 'Enforced', stopControl: 'Enforced', budgetLease: 'Enforced', rateLimit: 'Enforced' }, maxOvershootRatio: 0, measuredAt: '2026-11-10T00:00:00Z' } as const;
function setup() {
  const service = new GuidelineCoverageService(routes);
  const plan = service.planForObservedTargets([route.guidelineId], ['observed-target:1'], [capability]);
  const coverage = service.startRun('run-1', plan);
  const execution = coverage.executions.find((e) => e.routeId === route.routeId)!;
  return { service, plan, coverage, execution };
}

test('route snapshots are immutable copies and route changes invalidate them', () => {
  const mutable = structuredClone(route);
  const snapshot = snapshotGuidelineRoute(mutable, 'cookie check');
  (mutable.assertionIds as string[]).push('changed');
  assert.deepEqual(snapshot.assertionIds, route.assertionIds);
  assert.ok(Object.isFrozen(snapshot.catalog));
  assert.throws(() => (snapshot.assertionIds as string[]).push('tampered'));
  const { plan } = setup();
  const updated = new GuidelineCoverageService(routes.map((r) => r.routeId === route.routeId ? { ...r, reviewedAt: '2026-11-11T00:00:00Z' } : r));
  assert.throws(() => updated.startRun('old-plan', plan), /changed/);
});

test('plan hashes bind selection, snapshots, resolution, and capability, including old plan compatibility', () => {
  const { plan } = setup();
  const executionPlan: ExecutionPlan = {
    planId: 'p', caseId: 'c', authorizationId: 'a', operatorId: 'o', targetRole: 'guest', guidelineIds: [], steps: [],
    limits: { maxRequests: 1, maxPages: 1, maxDurationMinutes: 1, maxConcurrency: 1, requestsPerSecond: 1 },
    runtimeBundleHash: 'runtime', inputEvidenceHash: 'input', createdAt: 'now', guidelineCoverage: plan,
  };
  for (const changed of [
    { ...plan, selectedItems: [] }, { ...plan, snapshots: [] }, { ...plan, inputResolution: [] }, { ...plan, capabilities: [] },
  ]) assert.notEqual(planHashOf(executionPlan), planHashOf({ ...executionPlan, guidelineCoverage: changed }));
  assert.equal(planHashOf(executionPlan), planHashOf({ ...executionPlan, planId: 'other', createdAt: 'later' }));
});

test('execution/assessment validation, no input and missing capability never become pass', () => {
  const { service, execution, coverage } = setup();
  assert.equal(execution.executionStatus, 'queued');
  assert.equal(execution.assessment, 'not-assessed');
  assert.throws(() => service.startRun('run-1', setup().plan), /already exists/);
  assert.throws(() => service.recordExecution({ ...execution, executionStatus: 'needs-input', assessment: 'pass' }), /Incomplete/);
  assert.throws(() => service.recordExecution({ ...execution, executionStatus: 'completed', assessment: 'pass' }), /evidence/);
  const finished = service.recordExecution({ ...execution, executionStatus: 'completed', assessment: 'inconclusive', evidenceRefs: ['ev-1'] });
  assert.equal(coverage.executions.find((e) => e.routeId === route.routeId)!.executionStatus, 'queued');
  assert.deepEqual(finished.snapshots, coverage.snapshots);
});

test('forecast exposes missing inputs, unavailable capabilities, and explicit unsupported routes', () => {
  const service = new GuidelineCoverageService(routes);
  const plan = service.plan({ selectedItems: [{ guidelineId: route.guidelineId, itemId: route.itemId }], inputResolution: [], capabilities: [capability] });
  const forecast = service.forecast(route.guidelineId, plan);
  assert.equal(forecast.items.find((i) => i.itemId === route.itemId)!.executionStatus, 'needs-input');
  assert.equal(service.forecast(route.guidelineId).items.find((i) => i.itemId === route.itemId)!.executionStatus, 'unavailable');
  const unsupported = routes.find((r) => r.itemId === '10.2.3' && r.guidelineId.includes('ASVS 5'))!;
  assert.equal(unsupported.guarantee, 'Unsupported');
  assert.ok(unsupported.limitationCodes.includes('RAW_TRANSPORT_AND_DUAL_PARSER_ORACLE_MISSING'));
  assert.throws(() => service.plan({ selectedItems: [{ guidelineId: 'unknown', itemId: 'x' }], inputResolution: [], capabilities: [] }), /Unknown/);
});

test('aggregation never equates no finding or unfinished required routes with pass', () => {
  const { execution } = setup();
  const pass: GuidelineItemExecution = { ...execution, executionStatus: 'completed', assessment: 'pass', evidenceRefs: ['ev'] };
  const pending = { ...execution, executionStatus: 'needs-input' as const };
  assert.equal(aggregateGuidelineAssessment('all', [pass, pending]), 'inconclusive');
  assert.equal(aggregateGuidelineAssessment('all', [pass], 2), 'inconclusive');
  assert.equal(aggregateGuidelineAssessment('all', [pending]), 'not-assessed');
  assert.equal(aggregateGuidelineAssessment('any', [pass, pending]), 'pass');
  assert.equal(aggregateGuidelineAssessment('any', [pass, { ...pass, assessment: 'fail' }]), 'fail');
  assert.equal(aggregateGuidelineAssessment('all', []), 'not-assessed');
});

test('GET APIs and report share exactly the saved run projection', async () => {
  const { service } = createTestService();
  const plan = service.guidelineCoverage.planForObservedTargets([route.guidelineId], ['observed-target:1'], [capability]);
  const saved = service.guidelineCoverage.startRun('run-api', plan);
  const server = createCoreApiServer({ service, operator: TEST_OPERATOR });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/api/runs/run-api/guideline-coverage`);
    assert.equal(response.status, 200); const api = await response.json(); assert.deepEqual(api, saved);
    const forecast = await fetch(`${base}/api/guidelines/coverage?guidelineId=${encodeURIComponent(route.guidelineId)}`);
    assert.equal(forecast.status, 200); assert.ok((await forecast.json()).items.length > 0);
    assert.equal((await fetch(`${base}/api/guidelines/coverage`)).status, 400);
    assert.equal((await fetch(`${base}/api/runs/missing/guideline-coverage`)).status, 400);
    const model = buildReportModel({ caseId: 'case', generatedAt: 'now', guidelines: [route.guidelineId], findings: [],
      coverage: { exploredUrlCount: 100, scannedUrlCount: 100, delegatedSteps: [], limitations: [], guidelineCoverage: saved },
      assessmentScope: { caseName: 'test', allowedOrigins: [], deniedOrigins: [], limits: { maxRequests: 10, maxPages: 10, maxDurationMinutes: 10 } },
    });
    assert.equal(hashStable('projection', model.coverage.guidelineCoverage), hashStable('projection', api));
    assert.match(renderMarkdown(model, 'report').content, /not-assessed/);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('confirmed baseline scan binds immutable coverage and report uses that run', async () => {
  const { service, operator } = await bootstrapFlow();
  const target = 'http://fixture.target.test/page';
  const { plan } = service.buildActiveScanPlan(operator, [target], undefined, { guidelines: [route.guidelineId] });
  assert.ok(plan.guidelineCoverage!.selectedItems.some((i) => i.itemId === route.itemId));
  service.authorizePlan(plan);
  const confirmation = service.confirmPlan(plan, operator);
  const result = await service.runActiveScan(operator, plan, confirmation, []);
  const saved = service.guidelineCoverage.getRun(result.runRecord.runId);
  assert.ok(saved.executions.every((e) => e.assessment === 'not-assessed'));
  assert.ok(saved.executions.every((e) => e.executionStatus === 'unavailable'));
  assert.deepEqual(service.generateReport(operator, { guidelines: [route.guidelineId] }).model.coverage.guidelineCoverage, saved);
});

test('multiple routes per item and shared assertions preserve distinct guarantees; one failure dominates', () => {
  const delegated = { ...route, routeId: 'delegated', routeKind: 'zap-rule' as const, guarantee: 'Delegated' as const };
  const service = new GuidelineCoverageService([route, delegated]);
  const zapCapability = { ...capability, engineKind: 'zap' as const, guaranteeLevels: { ...capability.guaranteeLevels, preSendScopeEnforcement: 'Delegated' as const } };
  const plan = service.planForObservedTargets([route.guidelineId], ['target-ref'], [capability, zapCapability]);
  const run = service.startRun('multi', plan);
  assert.deepEqual(new Set(run.snapshots.map((s) => s.guarantee)), new Set(['Enforced', 'Delegated']));
  const first = run.executions.find((e) => e.routeId === route.routeId)!;
  const second = run.executions.find((e) => e.routeId === 'delegated')!;
  assert.equal(service.recordExecution({ ...first, executionStatus: 'completed', assessment: 'pass', evidenceRefs: ['ev-enforced'] }).items[0]!.assessment, 'inconclusive');
  assert.equal(service.recordExecution({ ...second, executionStatus: 'completed', assessment: 'fail', evidenceRefs: ['ev-delegated'] }).items[0]!.assessment, 'fail');
  assert.deepEqual(service.getRun('multi').snapshots, run.snapshots);
});

test('a baseline HTTP response alone never marks an input-dependent item assertion as executed', async () => {
  const { service, operator } = await bootstrapFlow({ workflowScanTransportFactory: ({ baseUrl }) => {
    const logs: import('../../../src/domain/workflow-scan.ts').WorkflowScanRequestLogEntry[] = [];
    return {
      baseUrl, get requestCount() { return logs.length; },
      async request(spec) {
        logs.push({ method: spec.method, url: new URL(spec.path, baseUrl).href, status: 200, location: '', requestPreview: '', responsePreview: '' });
        return { status: 200, body: '<html>ordinary response</html>', location: '', contentType: 'text/html', contentSecurityPolicy: '', setCookies: [], headers: {} };
      },
      takeRequestLog() { return logs.splice(0); },
    };
  } });
  const target = 'http://fixture.target.test/page';
  const guideline = 'OWASP ASVS 5.0';
  const { plan } = service.buildActiveScanPlan(operator, [target], undefined, { guidelines: [guideline], includeWorkflowScan: true });
  service.authorizePlan(plan);
  const confirmation = service.confirmPlan(plan, operator);
  const result = await service.runActiveScan(operator, plan, confirmation, [{ candidateId: 'page', url: target, method: 'GET', category: 'page', guidelineBasis: [guideline], confidence: 1, observationUrl: target }]);
  const sqlItem = service.guidelineCoverage.getRun(result.runRecord.runId).executions.find((e) => e.itemId === '1.2.4')!;
  assert.equal(sqlItem.executionStatus, 'unavailable');
  assert.equal(sqlItem.assessment, 'not-assessed');
  assert.ok(sqlItem.limitationCodes.includes('ASSERTION_EXECUTION_RECORD_MISSING'));
});
