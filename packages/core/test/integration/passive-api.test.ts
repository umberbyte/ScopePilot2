import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PassiveAlertsResponse, PassiveStatus } from '@scopepilot2/contracts';
import { createCoreApiServer } from '../../src/application/api-server.ts';
import { bootstrapFlow } from '../unit/support/test-flow.ts';

test('passive API exposes rules, status, shared alerts and bounded evidence; denies missing read permission', async () => {
  const { service, operator } = await bootstrapFlow({ explorer: { engineVersion: 'fake-explorer-1', observe: async (url) => ({ url, status: 200, contentType: 'text/html', discoveredFrom: null, depth: 0, originType: 'crawl', links: [], forms: [{ actionUrl: 'http://fixture.target.test/login', method: 'POST', classification: 'login', fields: [{ name: 'password', type: 'password' }] }] }) } });
  const { plan } = service.buildExplorationPlan(operator, ['http://fixture.target.test/']);
  service.authorizePlan(plan);
  await service.runExploration(operator, plan, service.confirmPlan(plan, operator), { maxDepth: 1 });
  for (const allowed of [true, false]) {
    const server = createCoreApiServer({ service, operator: { ...operator, permissions: allowed ? ['case.read'] : [] } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP address required');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (const path of ['rules', 'status', 'alerts', 'evidence?findingId=missing']) {
        const response = await fetch(`${base}/api/passive/${path}`);
        assert.equal(response.status, allowed ? path.startsWith('evidence') ? 404 : 200 : 403);
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
      if (!allowed) continue;
      const status = await (await fetch(`${base}/api/passive/status`)).json() as PassiveStatus;
      assert.equal(status.processed, 1);
      const { alerts } = await (await fetch(`${base}/api/passive/alerts`)).json() as PassiveAlertsResponse;
      assert.equal(alerts.length, 1);
      assert.deepEqual(alerts, service.listFindings());
      const evidence = await (await fetch(`${base}/api/passive/evidence?findingId=${alerts[0]!.findingId}`)).json() as { evidenceRefs: string[]; observation: { ruleId: string }; reproduction: { method: string } };
      assert.equal(evidence.observation.ruleId, 'passive-password-http');
      assert.equal(evidence.evidenceRefs.length, 1);
      assert.equal(evidence.reproduction.method, 'GET');
      assert.equal('content' in evidence, false);
    } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
  }
});
