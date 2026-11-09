import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DomainError, type ScanCandidate } from '@scopepilot2/contracts';
import type { RepeaterTransportPort } from '@scopepilot2/core';
import { bootstrapFlow } from '../support/test-flow.ts';

describe('ScanStartPolicy (BaselineFlowService.runActiveScan)', () => {
  test('ガイドライン選択を変更すると確認済み計画を再利用できない', async () => {
    const { service, operator, scanEngine } = await bootstrapFlow();
    const target = 'http://fixture.target.test/';
    const { plan: asvsPlan } = service.buildActiveScanPlan(operator, [target], undefined, { guidelines: ['OWASP ASVS 5.0'] });
    service.authorizePlan(asvsPlan);
    const asvsConfirmation = service.confirmPlan(asvsPlan, operator);
    const { plan: ds221Plan } = service.buildActiveScanPlan(operator, [target], undefined, { guidelines: ['デジタル庁 DS-221'] });
    service.authorizePlan(ds221Plan);
    assert.notEqual(asvsConfirmation.planHash, service.confirmPlan(ds221Plan, operator).planHash);
    await assert.rejects(
      service.runActiveScan(operator, ds221Plan, asvsConfirmation, []),
      (error: unknown) => error instanceof DomainError && error.code === 'ConfirmationRequired',
    );
    assert.equal(scanEngine.startCalls.length, 0);
  });

  test('[F11-UT-004] 確認 hash が現在の計画と不一致なら engine を起動しない', async () => {
    const { service, operator, scanEngine } = await bootstrapFlow();
    const { plan: confirmedPlan } = service.buildActiveScanPlan(operator, ['http://fixture.target.test/']);
    service.authorizePlan(confirmedPlan);
    const staleConfirmation = service.confirmPlan(confirmedPlan, operator);

    // 対象が変わった別の計画 (hash が異なる) に古い確認を使う。
    const { plan: changedPlan } = service.buildActiveScanPlan(operator, [
      'http://fixture.target.test/',
      'http://fixture.target.test/login.php',
    ]);
    service.authorizePlan(changedPlan);
    const adopted: readonly ScanCandidate[] = [
      {
        candidateId: 'cand-0001',
        url: 'http://fixture.target.test/',
        method: 'GET',
        category: 'page',
        guidelineBasis: ['provisional:page'],
        confidence: 0.7,
        observationUrl: 'http://fixture.target.test/',
      },
    ];
    await assert.rejects(
      service.runActiveScan(operator, changedPlan, staleConfirmation, adopted),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'ConfirmationRequired');
        return true;
      },
    );
    assert.equal(scanEngine.startCalls.length, 0, 'engine は起動しない');
  });

  test('ASVS選択は安全なHTTP観測テーマを実行関数へ接続し、送信数をZAP leaseから予約する', async () => {
    const sent: string[] = [];
    const repeaterTransport: RepeaterTransportPort = {
      send: async (input) => {
        sent.push(input.targetUrl);
        return {
          status: 200,
          headers: [['Server', 'Apache/2.4.65 (Debian)'], ['Content-Type', 'text/html; charset=UTF-8']],
          body: Buffer.from('<html>DVWA</html>', 'utf8'),
          redirectLocations: [],
        };
      },
    };
    const { service, operator, scanEngine } = await bootstrapFlow({ repeaterTransport });
    const target = 'http://fixture.target.test/';
    const { plan } = service.buildActiveScanPlan(operator, [target], undefined, { guidelines: ['OWASP ASVS 5.0'] });
    service.authorizePlan(plan);
    const result = await service.runActiveScan(operator, plan, service.confirmPlan(plan, operator), [{
      candidateId: 'cand-guideline-1',
      url: target,
      method: 'GET',
      category: 'page',
      guidelineBasis: ['OWASP ASVS 5.0'],
      confidence: 1,
      observationUrl: target,
    }]);

    const smuggling = result.guidelineRoutes.find((route) => route.themeNo === '17');
    assert.equal(smuggling?.status, 'unavailable');
    assert.equal(smuggling?.automationClass, 'unsupported');
    assert.ok(smuggling?.limitationCodes?.includes('smuggling-send-prohibited'));
    assert.equal(smuggling?.checkId, undefined);
    assert.equal(smuggling?.checkStatus, undefined);
    assert.deepEqual(result.unsupportedAssessments.map((entry) => entry.routeId), ['theme:17:unsupported', 'asvs:10.2.3:unsupported']);
    const artifact = service.generateReport(operator, { guidelines: ['OWASP ASVS 5.0'] });
    assert.deepEqual(artifact.model.coverage.unsupportedAssessments, result.unsupportedAssessments);
    assert.match(artifact.content, /検査不能・スキップ/u);
    assert.match(artifact.content, /ASVS 10.2.3/u);
    assert.match(artifact.content, /RAW_TRANSPORT_AND_DUAL_PARSER_ORACLE_MISSING/u);
    assert.match(artifact.content, /not-assessed/u);
    const conditional = result.guidelineRoutes.find((route) => route.themeNo === '26');
    assert.equal(conditional?.status, 'needs-input');
    assert.equal(conditional?.automationClass, 'conditional-automatic');
    assert.ok(conditional?.missingInputCodes?.includes('normal-query'));
    assert.ok(conditional?.detail.includes('正常query'));
    assert.equal(conditional?.checkStatus, undefined);
    assert.equal(sent.length, 12);
    assert.ok(sent.every((url) => url === target));
    for (const themeNo of ['13', '24', '25', '30']) {
      assert.equal(result.guidelineRoutes.find((candidate) => candidate.routeId === `zap-unsupported:${themeNo}`)?.status, 'executed');
    }
    const route = result.guidelineRoutes.find((candidate) => candidate.routeId === 'zap-unsupported:30');
    assert.equal(route?.status, 'executed');
    assert.equal(route?.checkStatus, 'fail');
    assert.ok(route?.checkId?.startsWith('themecheck-'));
    assert.ok(result.guidelineRoutes.some((candidate) => candidate.status === 'needs-input'));
    const activeStep = plan.steps.find((step) => step.kind === 'active-scan')!;
    assert.equal(scanEngine.startCalls[0]?.leasedMaxRequests, activeStep.limits.maxRequests - result.overshootReservation - 12);
  });
});
