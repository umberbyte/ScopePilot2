import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { DomainError, type EngineCapabilitySnapshot, type RuntimeProfile } from '@scopepilot2/contracts';
import { BaselineFlowService, FixedClock, InMemoryEvidenceStore, SequentialIdGenerator, UnavailableCapability, createCoreApiServer, type BaselineFlowDeps } from '../../src/index.ts';
import { FakeExplorer, FakeScanEngine, TEST_NOW, TEST_OPERATOR } from '../unit/support/test-flow.ts';
import { createFixtureToolAdapters } from '../../../../tools/simulation/src/adapters/fixture-tools.ts';

const targetUrl = 'http://fixture.target.test/api';
const requests = {
  repeaterTransport: ['/api/repeater/send', { draftId: 'draft-unused', confirmedPlanHash: 'hash-unused' }],
  fuzzTransport: ['/api/fuzzer/runs', { targetUrl, positions: [{ name: 'q', values: ['one'] }] }],
  sequencerTransport: ['/api/tools/sequencer/runs', { targetUrl, samples: 30 }],
  oastProvider: ['/api/oast/attempts', { targetUrl, protocol: 'http' }],
  webSocketTransport: ['/api/websocket/send', { targetUrl, messages: ['hello'] }],
  advancedTransport: ['/api/tools/transport/negotiate', { targetUrl, allowFallback: false }],
} as const;
type Tool = keyof typeof requests;

async function setup(profile?: RuntimeProfile, configure?: (deps: BaselineFlowDeps) => void) {
  let calls = 0;
  const tools = createFixtureToolAdapters();
  // Spies model a configured real port without making external requests.
  const realTools = Object.fromEntries(Object.entries(tools).map(([name, port]) => [name,
    Object.fromEntries(Object.entries(port).map(([key, value]) => [key, key === 'adapterKind' ? 'real' : typeof value === 'function'
      ? (...args: unknown[]) => { calls++; return Reflect.apply(value, port, args); } : value])),
  ]));
  const evidence = new InMemoryEvidenceStore();
  const deps: BaselineFlowDeps = {
    ...(profile === undefined ? {} : { runtimeProfile: profile }),
    clock: new FixedClock([TEST_NOW]), ids: new SequentialIdGenerator(), evidence,
    explorer: new FakeExplorer(), scanEngine: new FakeScanEngine(), capabilities: [], runtimeBundleHash: 'runtime-test',
    ...realTools,
  };
  configure?.(deps);
  const service = new BaselineFlowService(deps);
  service.createCase(TEST_OPERATOR, { name: 'runtime test', allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [], limits: { maxRequests: 100, maxPages: 50, maxDurationMinutes: 10 } });
  const server = createCoreApiServer({ service, operator: TEST_OPERATOR });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    service, evidence, calls: () => calls,
    async post(tool: Tool) {
      const path = requests[tool][0];
      let body: unknown = requests[tool][1];
      if (tool === 'repeaterTransport') {
        const draft = service.createRepeaterDraft(TEST_OPERATOR, { targetUrl, protocol: 'http/1.1' });
        body = { draftId: draft.draftId, confirmedPlanHash: draft.planHash };
      }
      return fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    },
    capabilities: async () => (await fetch(`${base}/api/capabilities`)).json(),
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

for (const tool of Object.keys(requests) as Tool[]) {
  test(`production: missing ${tool} returns 503 before any send or ledger write`, async () => {
    const flow = await setup(undefined, (deps) => { delete deps[tool]; });
    try {
      const events = flow.service.events();
      const response = await flow.post(tool);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'CapabilityUnavailable');
      assert.equal(flow.calls(), 0);
      assert.deepEqual(flow.service.events(), events);
      assert.deepEqual(flow.evidence.list(), []);
      assert.deepEqual(flow.service.listFindings(), []);
      assert.deepEqual(flow.service.listFuzzRuns(), []);
      assert.deepEqual(flow.service.listSequencerSessions(), []);
      assert.deepEqual(flow.service.listOastAttempts(), []);
      assert.deepEqual(flow.service.repeaterAttemptLog(), []);
      const body = await flow.capabilities();
      assert.equal(body.runtimeProfile, 'production');
      assert.equal(body.adapters.find((a: { capability: string }) => a.capability === tool).adapterKind, 'unavailable');
    } finally { await flow.close(); }
  });

  test(`production rejects an explicitly injected fixture ${tool}`, async () => {
    const flow = await setup('production', (deps) => Object.assign(deps, { [tool]: createFixtureToolAdapters()[tool] }));
    try {
      const response = await flow.post(tool);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'CapabilityUnavailable');
      assert.equal(flow.calls(), 0);
      assert.deepEqual(flow.service.listFindings(), []);
      const capability = (await flow.capabilities()).adapters.find((a: { capability: string }) => a.capability === tool);
      assert.equal(capability.adapterKind, 'fixture');
      assert.equal(capability.available, false);
    } finally { await flow.close(); }
  });

  test(`production rejects unmarked ${tool}`, async () => {
    const flow = await setup('production', (deps) => {
      const port = deps[tool];
      Object.assign(deps, { [tool]: Object.fromEntries(Object.entries(port!).filter(([key]) => key !== 'adapterKind')) });
    });
    try { assert.equal((await flow.post(tool)).status, 503); assert.equal(flow.calls(), 0); }
    finally { await flow.close(); }
  });

  for (const profile of ['simulation', 'test'] as const) {
    test(`${profile}: explicit fixture ${tool} runs and preserves provenance`, async () => {
      const flow = await setup(profile, (deps) => Object.assign(deps, createFixtureToolAdapters()));
      try {
        const response = await flow.post(tool);
        assert.equal(response.status, tool === 'oastProvider' ? 201 : 200, await response.clone().text());
        assert.equal((await response.json()).adapterKind, 'fixture');
        const body = await flow.capabilities();
        const capability = body.adapters.find((a: { capability: string }) => a.capability === tool);
        assert.equal(body.runtimeProfile, profile);
        assert.equal(capability.adapterKind, 'fixture');
        assert.ok(capability.fixtureHash);
        assert.ok(capability.version);
        assert.equal(capability.configuredAt, TEST_NOW);
        assert.equal(body.runtimeBundle.adapters.find((a: { capability: string }) => a.capability === tool).adapterKind, 'fixture');
        assert.ok(body.runtimeBundle.manifestHash);
      } finally { await flow.close(); }
    });

    test(`${profile}: missing ${tool} never constructs a fixture`, async () => {
      const flow = await setup(profile, (deps) => { delete deps[tool]; });
      try { assert.equal((await flow.post(tool)).status, 503); assert.equal(flow.calls(), 0); }
      finally { await flow.close(); }
    });
  }

  test(`production: real ${tool} succeeds with real provenance`, async () => {
    const flow = await setup('production');
    try {
      const response = await flow.post(tool);
      assert.equal(response.status, tool === 'oastProvider' ? 201 : 200, await response.clone().text());
      assert.equal((await response.json()).adapterKind, 'real');
      assert.ok(flow.calls() > 0);
    } finally { await flow.close(); }
  });
}

test('OAST configured absence is shared UnavailableCapability', async () => {
  const flow = await setup('production', (deps) => Object.assign(deps, { oastProvider: new UnavailableCapability('configure an OAST provider') }));
  try {
    assert.equal((await flow.post('oastProvider')).status, 503);
    const body = await flow.capabilities();
    const capability = body.adapters.find((a: { capability: string }) => a.capability === 'oastProvider');
    assert.equal(capability.adapterKind, 'unavailable');
    assert.deepEqual(capability.constraints, ['configure an OAST provider']);
    assert.equal(flow.calls(), 0);
  } finally { await flow.close(); }
});

const fixtureEngine: EngineCapabilitySnapshot = {
  engineKind: 'playwright', engineVersion: 'fake-explorer-1', source: 'fixture',
  guaranteeLevels: { preSendScopeEnforcement: 'Enforced', stopControl: 'Enforced', budgetLease: 'Enforced', rateLimit: 'Enforced' },
  maxOvershootRatio: 0, measuredAt: TEST_NOW,
};

async function grant(service: BaselineFlowService) {
  await service.grantAuthorization(TEST_OPERATOR, {
    allowedOperationClasses: ['Browse'], targetRoles: ['unauthenticated'],
    validFrom: '2026-10-18T00:00:00.000Z', validUntil: '2026-10-19T00:00:00.000Z',
    evidence: { label: 'authorization', content: 'authorized test fixture' },
  });
}

test('production rejects fixture engine plans during validation, confirmation, and execution', async () => {
  const flow = await setup('production', (deps) => Object.assign(deps, { capabilities: [fixtureEngine] }));
  try {
    await grant(flow.service);
    const { plan } = flow.service.buildExplorationPlan(TEST_OPERATOR, [targetUrl]);
    const before = flow.service.events();
    const unavailable = (error: unknown) => error instanceof DomainError && error.code === 'CapabilityUnavailable';
    assert.throws(() => flow.service.authorizePlan(plan), unavailable);
    assert.throws(() => flow.service.confirmPlan(plan, TEST_OPERATOR), unavailable);
    await assert.rejects(flow.service.runExploration(TEST_OPERATOR, plan, {
      confirmationId: 'untrusted', planHash: 'untrusted', confirmedAt: TEST_NOW,
      confirmedBy: TEST_OPERATOR.operatorId, guidelineIds: [], confirmedView: [],
    }, { maxDepth: 1 }), unavailable);
    assert.deepEqual(flow.service.events(), before);
    assert.equal(flow.evidence.list().length, 1, 'only authorization evidence was saved');
  } finally { await flow.close(); }
});

test('run saves the runtime adapter manifest as evidence', async () => {
  const saved: { label: string; content: string }[] = [];
  const evidence = new InMemoryEvidenceStore();
  const flow = await setup('test', (deps) => Object.assign(deps, {
    capabilities: [fixtureEngine], ...createFixtureToolAdapters(),
    evidence: { saveText: async (label: string, content: string) => {
      saved.push({ label, content });
      return evidence.saveText(label, content);
    } },
  }));
  try {
    await grant(flow.service);
    const { plan } = flow.service.buildExplorationPlan(TEST_OPERATOR, [targetUrl]);
    flow.service.authorizePlan(plan);
    const confirmation = flow.service.confirmPlan(plan, TEST_OPERATOR);
    const run = await flow.service.runExploration(TEST_OPERATOR, plan, confirmation, { maxDepth: 1 });
    const manifest = saved.find((record) => record.label === `runtime-bundle:${run.runRecord.runId}`);
    assert.ok(manifest);
    assert.deepEqual(JSON.parse(manifest.content), flow.service.runtimeBundleManifest());
    const body = JSON.parse(manifest.content);
    assert.equal(body.runtimeProfile, 'test');
    assert.ok(body.adapters.every((adapter: { adapterKind: string; fixtureHash?: string }) => adapter.adapterKind === 'fixture' && adapter.fixtureHash));
  } finally { await flow.close(); }
});
