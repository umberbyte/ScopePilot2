import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mayBuildCommand, resolveRoute } from '../../../src/app/mode-policy.ts';

const fullPermissions = ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'] as const;

describe('UiModePolicy', () => {
  test('[UI-UT-001] Simple で raw 編集 route を要求すると拒否して wizard へ戻す', () => {
    for (const route of ['repeater', 'fuzzer', 'proxy.intercept', 'decoder', 'adv.manual.websocket', 'adv.manual.oast'] as const) {
      const decision = resolveRoute('simple', route, fullPermissions);
      assert.equal(decision.allowed, false, `${route} は Simple で拒否`);
      assert.equal(decision.fallback, 'wizard.guideline');
      assert.match(decision.reason ?? '', /not available in Simple mode/);
    }
    // Simple の wizard 構成 route は許可される。
    assert.deepEqual(resolveRoute('simple', 'wizard.explore', fullPermissions), { allowed: true });
    // Advanced では権限内有効。
    assert.deepEqual(resolveRoute('advanced', 'repeater', fullPermissions), { allowed: true });
  });

  test('[UI-UT-002] Advanced でも権限不足なら操作を隠し command も生成しない', () => {
    const readonlyOperator = ['case.read'] as const;
    const decision = resolveRoute('advanced', 'fuzzer', readonlyOperator);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', /lacks permission run.manage/);
    assert.equal(mayBuildCommand('advanced', 'fuzzer', readonlyOperator), false, 'API 用 command を生成しない');
    assert.equal(mayBuildCommand('advanced', 'decoder', readonlyOperator), true, 'case.read なら decoder は可');
  });
});
