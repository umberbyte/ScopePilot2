import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { NucleiScanPort } from '@scopepilot2/core';
import { bootstrapFlow } from '../support/test-flow.ts';

describe('confirmed active scan plan with Nuclei', () => {
  test('計画にNucleiを開示し、確認済み対象だけを実行して結果を所見へ取り込む', async () => {
    const calls: Parameters<NucleiScanPort['run']>[0][] = [];
    const nucleiRunner: NucleiScanPort = {
      engineVersion: 'nuclei v3.4.0-test',
      run: async (input) => {
        calls.push(input);
        input.onLog?.('stderr: [0:00:02] | Templates: 42 | Hosts: 1 | RPS: 5');
        return {
          lines: [
            '{"template-id":"header-test","matched-at":"http://fixture.target.test/","info":{"severity":"medium","name":"Header test"}}',
          ],
        };
      },
    };
    const { service, operator } = await bootstrapFlow({ nucleiRunner, allowedOperationClasses: ['Browse', 'ActiveScan', 'NucleiScan'] });
    const target = 'http://fixture.target.test/';
    const { plan } = service.buildActiveScanPlan(operator, [target], undefined, { includeNuclei: true });
    assert.deepEqual(plan.steps.map((step) => step.kind), ['active-scan', 'nuclei-scan']);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);
    const executionMessages: string[] = [];
    const result = await service.runActiveScan(operator, plan, confirmation, [{
      candidateId: 'candidate-real-1',
      url: target,
      method: 'GET',
      category: 'page',
      guidelineBasis: ['OWASP WSTG'],
      confidence: 0.9,
      observationUrl: target,
    }], undefined, {
      onEvent: (event) => executionMessages.push(event.message),
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.targets, [target]);
    assert.equal(calls[0]?.limits.requestsPerSecond, plan.steps[1]?.limits.requestsPerSecond);
    assert.equal(result.nuclei?.engineVersion, nucleiRunner.engineVersion);
    assert.equal(result.nuclei?.status, 'completed');
    assert.equal(result.nuclei?.importedCount, 1);
    assert.ok(result.findings.some((finding) => finding.source.kind === 'nuclei-match'));
    assert.ok(executionMessages.some((message) => message.includes('Templates: 42')));
  });

  test('Nuclei is off by default and, when selected, receives only the confirmed S04 targets', async () => {
    const nucleiRunner: NucleiScanPort = {
      engineVersion: 'nuclei v3.4.0-test',
      run: async () => ({ lines: [] }),
    };
    const { service, operator } = await bootstrapFlow({
      nucleiRunner,
      allowedOrigins: ['http://fixture.target.test', 'https://other.target.test'],
      allowedOperationClasses: ['Browse', 'ActiveScan', 'NucleiScan'],
    });
    const targets = [
      'http://fixture.target.test/app/login.php',
      'http://fixture.target.test/app/users/list.php?page=1',
      'http://fixture.target.test/app/api/items?id=2',
    ];
    const defaultPlan = service.buildActiveScanPlan(operator, targets);
    assert.deepEqual(defaultPlan.plan.steps.map((step) => step.kind), ['active-scan']);
    const { plan } = service.buildActiveScanPlan(operator, targets, undefined, { includeNuclei: true });

    assert.deepEqual(plan.steps[0]?.targetSnapshot, [...targets].sort());
    assert.equal(plan.steps[1]?.operationClass, 'NucleiScan');
    assert.deepEqual(plan.steps[1]?.targetSnapshot, [...targets].sort());
  });

  test('Nuclei failure does not discard a completed ZAP result', async () => {
    const nucleiRunner: NucleiScanPort = {
      engineVersion: 'nuclei v3.4.0-test',
      run: async () => { throw new Error('template process failed'); },
    };
    const { service, operator } = await bootstrapFlow({ nucleiRunner, allowedOperationClasses: ['Browse', 'ActiveScan', 'NucleiScan'] });
    const target = 'http://fixture.target.test/';
    const { plan } = service.buildActiveScanPlan(operator, [target], undefined, { includeNuclei: true });
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);
    const result = await service.runActiveScan(operator, plan, confirmation, [{
      candidateId: 'candidate-real-2', url: target, method: 'GET', category: 'page', guidelineBasis: ['OWASP WSTG'], confidence: 0.9, observationUrl: target,
    }]);
    assert.equal(result.runRecord.state, 'Failed');
    assert.equal(result.runRecord.stopReason, 'engine-failure');
    assert.equal(result.nuclei?.status, 'failed');
    assert.match(result.nuclei?.error ?? '', /template process failed/);
  });

  test('NucleiScan認可がない案件ではNuclei付き計画を認可しない', async () => {
    const nucleiRunner: NucleiScanPort = { engineVersion: 'nuclei test', run: async () => ({ lines: [] }) };
    const { service, operator } = await bootstrapFlow({ nucleiRunner, allowedOperationClasses: ['Browse', 'ActiveScan'] });
    const { plan } = service.buildActiveScanPlan(operator, ['http://fixture.target.test/'], undefined, { includeNuclei: true });
    assert.throws(() => service.authorizePlan(plan), /NucleiScan/);
  });
});

test('GO-26: real Nuclei failure remains Failed when a stop is concurrently requested', async () => {
  const controller = new AbortController();
  const nucleiRunner: NucleiScanPort = { engineVersion: 'nuclei-test', run: async () => {
    controller.abort();
    throw new Error('engine process failed');
  } };
  const { service, operator } = await bootstrapFlow({ nucleiRunner, allowedOperationClasses: ['Browse', 'ActiveScan', 'NucleiScan'] });
  const target = 'http://fixture.target.test/';
  const { plan } = service.buildActiveScanPlan(operator, [target], undefined, { includeNuclei: true });
  service.authorizePlan(plan);
  const result = await service.runActiveScan(operator, plan, service.confirmPlan(plan, operator), [{
    candidateId: 'candidate', url: target, method: 'GET', category: 'page', guidelineBasis: [], confidence: 1, observationUrl: target,
  }], undefined, { signal: controller.signal });
  assert.equal(result.runRecord.state, 'Failed');
  assert.equal(result.runRecord.stopReason, 'engine-failure');
});
