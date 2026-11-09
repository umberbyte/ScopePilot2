import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryEvidenceStore } from '@scopepilot2/core';
import type { PageObservation } from '@scopepilot2/contracts';
import { passiveObservationCandidates } from '../../../src/domain/passive-observation.ts';
import { bootstrapFlow } from '../support/test-flow.ts';

export const observation: PageObservation = {
  url: 'http://fixture.target.test/login', status: 200, contentType: 'text/html',
  discoveredFrom: null, depth: 0, originType: 'crawl', links: [],
  forms: [{ actionUrl: 'http://fixture.target.test/login', method: 'GET', classification: 'login', fields: [{ name: 'password', type: 'password' }] }],
};

async function explore(service: Awaited<ReturnType<typeof bootstrapFlow>>['service'], operator: Awaited<ReturnType<typeof bootstrapFlow>>['operator']) {
  const { plan } = service.buildExplorationPlan(operator, [observation.url]);
  service.authorizePlan(plan);
  return service.runExploration(operator, plan, service.confirmPlan(plan, operator), { maxDepth: 1 });
}

test('passive rules inspect observed metadata; safe forms, missing forms and invalid actions do not invent alerts', () => {
  assert.equal(passiveObservationCandidates(observation).length, 2);
  assert.equal(passiveObservationCandidates({ ...observation, forms: [] }).length, 0);
  assert.equal(passiveObservationCandidates({ ...observation, url: 'https://fixture.target.test/login', forms: [{ ...observation.forms[0]!, method: 'POST', actionUrl: 'https://fixture.target.test/login' }] }).length, 0);
  assert.equal(passiveObservationCandidates({ ...observation, forms: [{ ...observation.forms[0]!, actionUrl: 'http://[' }] }).length, 0);
});

test('exploration imports into the common ledger, reobserves evidence and preserves human review', async () => {
  const calls: string[] = [];
  const evidence = new InMemoryEvidenceStore();
  const { service, operator } = await bootstrapFlow({ evidenceStore: evidence, explorer: { engineVersion: 'fake-explorer-1', observe: async (url) => { calls.push(url); return observation; } } });
  assert.equal(service.passiveStatus(operator).processed, 0);
  await explore(service, operator);
  const alerts = service.listPassiveAlerts(operator);
  assert.equal(alerts.length, 2);
  assert.deepEqual(service.listFindings(), alerts);
  assert.equal(alerts[0]?.status, 'candidate');
  assert.equal(alerts[0]?.source.unverified, true);
  const id = alerts[0]!.findingId;
  service.updateFindingStatus(operator, { findingId: id, next: 'confirmed', reproduction: 'reproduced', notes: 'Observed form confirmed in fixture', severityRationale: 'Password form uses HTTP'  });
  await explore(service, operator);
  const updated = service.listPassiveAlerts(operator).find((finding) => finding.findingId === id)!;
  assert.equal(updated.status, 'confirmed');
  assert.equal(updated.occurrences, 2);
  assert.equal(updated.evidenceRefs.length, 2);
  assert.equal(service.passiveStatus(operator).processed, 2);
  assert.equal(service.passiveStatus(operator).queued, 0);
  assert.equal(service.passiveStatus(operator).failed, 0);
  assert.equal(calls.length, 2); // no passive transport calls
  assert.equal(evidence.list().filter((entry) => entry.label === 'passive-observation').length, 2);
  for (const read of [() => service.listPassiveAlerts({ ...operator, permissions: [] }), () => service.listPassiveRules({ ...operator, permissions: [] }), () => service.passiveStatus({ ...operator, permissions: [] })]) assert.throws(read, /permission/);
});

test('pending evidence is queued; evidence failure creates no finding and does not stop exploration', async () => {
  let rejectEvidence: (error: Error) => void = () => {};
  let entered: () => void = () => {};
  const pending = new Promise<void>((resolve) => { entered = resolve; });
  class FailingPassiveStore extends InMemoryEvidenceStore {
    override async saveText(label: string, content: string) {
      if (label === 'passive-observation') { entered(); await new Promise<void>((_, reject) => { rejectEvidence = reject; }); }
      return super.saveText(label, content);
    }
  }
  const { service, operator } = await bootstrapFlow({ evidenceStore: new FailingPassiveStore(), explorer: { engineVersion: 'fake-explorer-1', observe: async () => observation } });
  const running = explore(service, operator);
  await pending;
  assert.equal(service.passiveStatus(operator).queued, 1);
  rejectEvidence(new Error('disk full'));
  await running;
  assert.equal(service.passiveStatus(operator).queued, 0);
  assert.equal(service.passiveStatus(operator).failed, 1);
  assert.equal(service.listFindings().length, 0);
});
