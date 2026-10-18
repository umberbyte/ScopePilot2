import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DomainError, ScanCandidate } from '@scopepilot2/contracts';
import { bootstrapFlow } from '../support/test-flow.ts';

const adoptedCandidate: ScanCandidate = {
  candidateId: 'cand-0001',
  url: 'http://fixture.target.test/',
  method: 'GET',
  category: 'page',
  guidelineBasis: ['provisional:page'],
  confidence: 0.7,
  observationUrl: 'http://fixture.target.test/',
};

describe('evidence publisher / capability gate (BaselineFlowService)', () => {
  test('[SYS-UT-005] 証拠保存が失敗した場合、取込 event を公開しない', async () => {
    const { service, operator } = await bootstrapFlow({ evidenceFailure: true });
    const { plan } = service.buildActiveScanPlan(operator, ['http://fixture.target.test/']);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);

    await assert.rejects(
      service.runActiveScan(operator, plan, confirmation, [adoptedCandidate]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // 保存失敗は engine 起動後の失敗として扱うが、取込 (FindingsImported) は出さない。
        assert.equal((error as DomainError).code, 'EngineFailure');
        assert.match((error as DomainError).message, /evidence/);
        return true;
      },
    );
    assert.ok(!service.events().some((event) => event.type === 'FindingsImported'));
    assert.ok(service.events().some((event) => event.type === 'RunStarted'));
  });

  test('[SYS-UT-006] 保証不足 (Unsupported) の step は計画検証で拒否される', async () => {
    const { service, operator } = await bootstrapFlow();
    const { plan } = service.buildActiveScanPlan(operator, ['http://fixture.target.test/']);
    const unsupportedPlan = {
      ...plan,
      steps: plan.steps.map((step) => ({ ...step, guarantee: 'Unsupported' as const })),
    };
    assert.throws(
      () => service.authorizePlan(unsupportedPlan),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'CapabilityUnavailable');
        return true;
      },
    );
  });

  test('[SYS-UT-006] 能力表の版が engine と不一致なら実行前に CapabilityUnavailable', async () => {
    const { service, operator, scanEngine } = await bootstrapFlow({ zapCapabilityVersion: 'fake-zap-9' });
    const { plan } = service.buildActiveScanPlan(operator, ['http://fixture.target.test/']);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);

    await assert.rejects(
      service.runActiveScan(operator, plan, confirmation, [adoptedCandidate]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'CapabilityUnavailable');
        return true;
      },
    );
    assert.equal(scanEngine.startCalls.length, 0);
  });
});
