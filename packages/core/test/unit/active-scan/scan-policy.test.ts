import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DomainError, GenericHttpCheckIds } from '@scopepilot2/contracts';
import { bootstrapFlow } from '../support/test-flow.ts';

describe('A40/A43 scan policy', () => {
  test('標準ポリシーは経路単位・ZAP全体設定・汎用HTTP 9観点・Nuclei条件だけを持つ', async () => {
    const { service, operator } = await bootstrapFlow();
    const policies = service.listScanPolicies(operator);
    assert.equal(policies.length, 1);
    const standard = policies[0]!;
    assert.equal(standard.policyId, 'standard');
    assert.equal(standard.routes.zap.attackStrength, 'Medium');
    assert.equal(standard.routes.zap.alertThreshold, 'Medium');
    assert.deepEqual(standard.routes.genericHttp.checkIds, GenericHttpCheckIds);
    assert.deepEqual(standard.routes.nuclei.templateIds, []);
    assert.equal(JSON.stringify(standard).includes('ruleId'), false);
    assert.match(standard.policyHash, /^[0-9a-f]{64}$/u);
  });

  test('ポリシー hash は active scan plan hash に入り、内容変更で確認を失効する', async () => {
    const { service, operator, scanEngine } = await bootstrapFlow();
    const standard = service.listScanPolicies(operator)[0]!;
    const target = 'http://fixture.target.test/';
    const built = service.buildActiveScanPlan(operator, [target], undefined, {
      scanPolicyId: standard.policyId,
      scanPolicyHash: standard.policyHash,
      routeOverrides: { genericHttp: false, nuclei: false },
    });
    assert.equal(built.plan.scanPolicyHash, standard.policyHash);
    service.authorizePlan(built.plan);
    const confirmation = service.confirmPlan(built.plan, operator);

    const saved = service.saveScanPolicy(operator, {
      expectedRevision: standard.revision,
      policyId: standard.policyId,
      name: standard.name,
      isDefault: true,
      routes: {
        ...standard.routes,
        zap: { ...standard.routes.zap, attackStrength: 'High', alertThreshold: 'High' },
      },
    });
    assert.equal(saved.changed, true);
    assert.deepEqual(saved.invalidatedConfirmationIds, [confirmation.confirmationId]);
    assert.notEqual(saved.policy.policyHash, standard.policyHash);

    await assert.rejects(
      service.runActiveScan(operator, built.plan, confirmation, []),
      (error: unknown) => error instanceof DomainError && error.code === 'ConfirmationRequired',
    );
    assert.equal(scanEngine.startCalls.length, 0);
  });

  test('表示後にポリシーが変わると旧 hash では計画を再構築できない', async () => {
    const { service, operator } = await bootstrapFlow();
    const standard = service.listScanPolicies(operator)[0]!;
    service.saveScanPolicy(operator, {
      expectedRevision: standard.revision,
      policyId: standard.policyId,
      name: standard.name,
      isDefault: true,
      routes: { ...standard.routes, genericHttp: { enabled: false, checkIds: standard.routes.genericHttp.checkIds } },
    });
    assert.throws(
      () => service.buildActiveScanPlan(operator, ['http://fixture.target.test/'], undefined, {
        scanPolicyId: standard.policyId,
        scanPolicyHash: standard.policyHash,
      }),
      (error: unknown) => error instanceof DomainError && error.code === 'Conflict',
    );
  });

  test('選択した ZAP 全体の strength/threshold を engine 入力へ渡す', async () => {
    const { service, operator, scanEngine } = await bootstrapFlow();
    const standard = service.listScanPolicies(operator)[0]!;
    const saved = service.saveScanPolicy(operator, {
      expectedRevision: standard.revision,
      policyId: standard.policyId,
      name: standard.name,
      isDefault: true,
      routes: {
        ...standard.routes,
        zap: { enabled: true, attackStrength: 'High', alertThreshold: 'Low' },
      },
    });
    const built = service.buildActiveScanPlan(operator, ['http://fixture.target.test/'], undefined, {
      scanPolicyId: saved.policy.policyId,
      scanPolicyHash: saved.policy.policyHash,
      routeOverrides: { genericHttp: false, nuclei: false },
    });
    service.authorizePlan(built.plan);
    const confirmation = service.confirmPlan(built.plan, operator);
    await service.runActiveScan(operator, built.plan, confirmation, []);

    assert.equal(scanEngine.startCalls.length, 1);
    assert.equal(scanEngine.startCalls[0]?.attackStrength, 'High');
    assert.equal(scanEngine.startCalls[0]?.alertThreshold, 'Low');
  });

  test('revision guard と no-op 保存を区別する', async () => {
    const { service, operator } = await bootstrapFlow();
    const standard = service.listScanPolicies(operator)[0]!;
    const input = {
      expectedRevision: standard.revision,
      policyId: standard.policyId,
      name: standard.name,
      isDefault: standard.isDefault,
      routes: standard.routes,
    } as const;
    const noOp = service.saveScanPolicy(operator, input);
    assert.equal(noOp.changed, false);
    assert.deepEqual(noOp.invalidatedConfirmationIds, []);
    assert.throws(
      () => service.saveScanPolicy(operator, { ...input, expectedRevision: 0 }),
      (error: unknown) => error instanceof DomainError && error.code === 'Conflict',
    );
  });
});
