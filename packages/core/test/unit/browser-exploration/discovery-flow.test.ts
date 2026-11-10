import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PageObservation } from '@scopepilot2/contracts';
import type { ExplorationPort } from '../../../src/ports/engines.ts';
import { bootstrapFlow } from '../support/test-flow.ts';
import { analyzeClientAsset } from '../../../src/domain/client-review.ts';
import { planHashOf } from '../../../src/domain/plan-service.ts';

const origin = 'http://fixture.target.test';
function page(url: string, extra: Partial<PageObservation> = {}): PageObservation {
  return { url, status: 200, contentType: 'text/html', discoveredFrom: null, depth: 0, originType: 'crawl', links: [], forms: [], ...extra };
}
test('discovery is opt-in, ActiveCrawl-gated, bound to confirmation hash and negative controls', async () => {
  const ordinary = await bootstrapFlow();
  assert.throws(() => ordinary.service.buildExplorationPlan(ordinary.operator, [origin], undefined, { discoverySources: ['robots'] }), /ActiveCrawl/);
  const hits: string[] = [];
  const explorer: ExplorationPort = { engineVersion: 'owned-discovery', observe: async (url) => {
    hits.push(url);
    const path = new URL(url).pathname;
    if (path.includes('scopepilot-missing') || path === '/backup/' || path === '/admin/') return page(url, { contentFingerprint: 'wildcard-page' });
    if (path === '/robots.txt') return page(url, { contentType: 'text/plain', discoveryLinks: [{ url: `${origin}/hidden`, source: 'robots' }, { url: 'http://outside.test/', source: 'robots' }, { url: `${origin}/logout`, source: 'robots' }] });
    return page(url);
  } };
  const flow = await bootstrapFlow({ explorer, allowedOperationClasses: ['Browse', 'ActiveCrawl'] });
  const { plan } = flow.service.buildExplorationPlan(flow.operator, [origin], undefined, { discoverySources: ['robots', 'wordlist'] });
  assert.equal(plan.steps[0]?.operationClass, 'ActiveCrawl');
  const changed = { ...plan, steps: plan.steps.map((step) => ({ ...step, discoverySources: ['sitemap' as const] })) };
  assert.notEqual(planHashOf(changed), planHashOf(plan));
  flow.service.authorizePlan(plan);
  const result = await flow.service.runExploration(flow.operator, plan, flow.service.confirmPlan(plan, flow.operator), { maxDepth: 2 });
  assert.ok(result.observations.some((entry) => entry.url === `${origin}/hidden`));
  assert.equal(result.candidates.some((entry) => /\/(?:backup|admin)\//.test(entry.url)), false);
  assert.equal(hits.some((url) => url.includes('outside.test') || url.endsWith('/logout')), false);
  assert.ok(result.candidates.every((entry) => entry.score !== undefined && entry.provenance?.length));
});
test('cancel and browser subrequest budgets stop before another adapter operation', async () => {
  let hits = 0, sends = 0;
  const explorer: ExplorationPort = { engineVersion: 'owned-budget', observe: async (url, control) => {
    hits++;
    for (let i = 0; i < 20; i++) if (control?.consumeRequest()) sends++;
    return page(url, { links: [`${origin}/next`] });
  } };
  const flow = await bootstrapFlow({ explorer, caseLimits: { maxRequests: 3, maxPages: 10, maxDurationMinutes: 1 } });
  const { plan } = flow.service.buildExplorationPlan(flow.operator, [origin]);
  const confirmation = flow.service.confirmPlan(plan, flow.operator);
  const cancelled = new AbortController(); cancelled.abort();
  const stopped = await flow.service.runExploration(flow.operator, plan, confirmation, { maxDepth: 2, signal: cancelled.signal });
  assert.equal(stopped.runRecord.stopReason, 'user-request');
  assert.equal(hits, 0);
  const result = await flow.service.runExploration(flow.operator, plan, confirmation, { maxDepth: 2 });
  assert.equal(result.runRecord.stopReason, 'budget-exhausted');
  assert.equal(hits, 1); assert.equal(sends, 3);
});
test('asset signals become unverified findings with masked evidence; repeated assets dedupe', async () => {
  const asset = analyzeClientAsset({ url: `${origin}/main.js`, sourceUrl: origin, contentType: 'application/javascript', body: ('ghp_' + '0123456789abcdefghijklmnopqrstuvwxyz') })!;
  const explorer: ExplorationPort = { engineVersion: 'owned-asset', observe: async (url) => page(url, { assets: [asset], links: url.endsWith('/next') ? [] : [`${origin}/next`] }) };
  const flow = await bootstrapFlow({ explorer });
  const { plan } = flow.service.buildExplorationPlan(flow.operator, [origin]);
  await flow.service.runExploration(flow.operator, plan, flow.service.confirmPlan(plan, flow.operator), { maxDepth: 2 });
  assert.equal(flow.service.listAssetObservations().length, 1);
  const findings = flow.service.listFindings();
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.source.unverified, true);
  assert.equal(findings[0]?.status, 'candidate');
  assert.ok(findings[0]?.evidenceRefs.length);
  assert.equal(JSON.stringify(findings).includes('0123456789abcdefghijklmnopqrstuvwxyz'), false);
});
test('reviewed interactive workflow routes and requests are merged into future exploration candidates', async () => {
  const flow = await bootstrapFlow({ explorer: { engineVersion: 'owned', observe: async (url) => page(url) }, interactiveBrowser: {
    engineVersion: 'owned-workflow', execute: async (input) => ({ finalUrl: input.targetUrl, status: 200, bodyHash: 'owned', bodyText: '', headers: [], elapsedMs: 1, assertions: [], clientRoutes: [{ url: `${origin}/#/dialog/42`, source: 'history' }], observedRequests: [{ requestId: 'owned-workflow-1', url: `${origin}/api/items/42`, sourceUrl: input.targetUrl, method: 'POST', resourceType: 'fetch', inputPoints: [{ name: 'label', location: 'body', type: 'json' }] }] }),
  } });
  await flow.service.runInteractiveDiagnostics(flow.operator, { confirmed: true, files: [], apiDocuments: [], items: [{ itemId: 'owned', track: 'workflow-state', targetUrl: origin, role: 'unauthenticated', roles: [], summary: 'owned interaction', steps: [{ kind: 'navigate', target: origin }], samples: 1, tokenSource: 'body', tokenName: '', expectation: 'different', requiredInputs: [] }] });
  const { plan } = flow.service.buildExplorationPlan(flow.operator, [origin]);
  const result = await flow.service.runExploration(flow.operator, plan, flow.service.confirmPlan(plan, flow.operator), { maxDepth: 1 });
  assert.ok(result.candidates.some((candidate) => candidate.url === `${origin}/api/items/42` && candidate.requestId === 'owned-workflow-1'));
  assert.ok(result.candidates.some((candidate) => candidate.url === `${origin}/#/dialog/42` && candidate.diagnosticTracks?.includes('browser-dom')));
});

test('login JWT review is passive, exposed as redacted signals and kept separate from acceptance', async () => {
  const token = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"private-subject"}').toString('base64url')}.`;
  const flow = await bootstrapFlow({ loginExecutor: { engineVersion: 'owned-login', execute: async () => ({ authenticated: true, finalUrl: `${origin}/account`, cookies: [{ name: 'session', value: token, domain: 'fixture.target.test', path: '/' }] }) } });
  flow.service.registerLoginFlow(flow.operator, { role: 'user', flowVersion: 'v1', steps: [{ kind: 'navigate', target: `${origin}/login` }, { kind: 'assert', target: 'Owned dashboard' }] });
  await flow.service.runLogin(flow.operator, { role: 'user', baseUrl: origin, expectedUrlPrefix: origin, secretValues: {} });
  const { plan } = flow.service.buildExplorationPlan(flow.operator, [origin]);
  const result = await flow.service.runExploration(flow.operator, plan, flow.service.confirmPlan(plan, flow.operator), { maxDepth: 1 });
  assert.ok(result.authenticationReview?.some((signal) => signal.ruleId === 'jwt-none'));
  assert.ok(flow.service.listFindings().some((finding) => finding.title.includes('acceptance untested') && finding.source.unverified));
  assert.equal(JSON.stringify({ result, findings: flow.service.listFindings() }).includes(token), false);
  assert.equal(JSON.stringify(result).includes('private-subject'), false);
});
