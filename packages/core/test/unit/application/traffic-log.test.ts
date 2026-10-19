import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

/** HTTP 通信 log と endpoint 集約の service 経路 (design/f03)。 */
describe('traffic log (service)', () => {
  test('探索の観測が通信 log に入り、endpoint 集約は query 差を同一視する', async () => {
    const { service, operator } = await bootstrapFlow();
    const { plan } = service.buildExplorationPlan(operator, ['http://fixture.target.test/']);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);
    await service.runExploration(operator, plan, confirmation, { maxDepth: 2 });

    const traffic = service.listTraffic(500);
    assert.equal(traffic.mode, 'list');
    assert.ok(traffic.total > 0, '観測通信が記録される');
    assert.ok((traffic.entries ?? []).every((entry) => entry.source === 'explore'));
    assert.ok((traffic.entries ?? []).every((entry) => entry.url.startsWith('http://fixture.target.test')));

    // endpoint 集約: path 単位にまとまり、observedUrls は観測 URL 数を数える。
    const endpoints = service.listSiteMapEndpoints();
    assert.ok(endpoints.length > 0);
    const home = endpoints.find((endpoint) => endpoint.path === '/');
    assert.notEqual(home, undefined, 'home の endpoint がある');
    assert.ok(endpoints.every((endpoint) => endpoint.origin === 'http://fixture.target.test'));
  });

  test('Repeater の送信も通信 log に入る (source 区分付き)', async () => {
    const { service, operator } = await bootstrapFlow();
    const draft = service.createRepeaterDraft(operator, { targetUrl: 'http://fixture.target.test/repeat', protocol: 'http/1.1' });
    await service.sendRepeaterDraft(operator, draft.draftId, draft.planHash);
    const traffic = service.listTraffic(10);
    const repeaterEntry = (traffic.entries ?? []).find((entry) => entry.source === 'repeater');
    assert.notEqual(repeaterEntry, undefined);
    assert.equal(repeaterEntry?.url, 'http://fixture.target.test/repeat');
    assert.equal(repeaterEntry?.status, 200);
  });

  test('limit 検証は domain 規則 (1〜500) に従う', async () => {
    const { service } = await bootstrapFlow();
    assert.throws(() => service.listTraffic(501), /traffic query limit/);
    assert.throws(() => service.listTraffic(0), /traffic query limit/);
    assert.equal(service.listTraffic(500).mode, 'list');
  });
});
