import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DomainError, type ScanCandidate } from '@scopepilot2/contracts';
import { bootstrapFlow } from '../support/test-flow.ts';

describe('ScanStartPolicy (BaselineFlowService.runActiveScan)', () => {
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
});
