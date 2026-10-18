import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  checkFlowDeadline,
  detectAuthState,
  RoleSessionRegistry,
  SessionCoordinator,
  validateLoginFlow,
  vaultEvidenceProjection,
  requireMtlsBinding,
} from '@scopepilot2/core';
import type { LoginFlowStep } from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

const step = (kind: LoginFlowStep['kind']): LoginFlowStep =>
  kind === 'fill' ? { kind, secretReference: 'os-keychain:diagnostic-account/password' } : { kind };

describe('LoginFlow', () => {
  test('[F09-UT-001] 11 step は validation error になる', () => {
    const eleven: LoginFlowStep[] = Array.from({ length: 11 }, () => step('navigate'));
    assert.throws(() => validateLoginFlow(eleven), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'ValidationFailed');
      assert.match((error as DomainError).message, /exceeds 10 steps/);
      return true;
    });
    assert.deepEqual(validateLoginFlow([step('navigate'), step('fill'), step('click')]), { stepCount: 3 });
    assert.throws(() => validateLoginFlow([{ kind: 'execScript' } as unknown as LoginFlowStep]), /not allowed/);
  });

  test('[F09-UT-002] URL 一致でも assert 不一致なら未認証と判定する', () => {
    assert.equal(detectAuthState({ expectedUrlPrefix: 'http://x.test/home', finalUrl: 'http://x.test/home', assertResult: true }), 'authenticated');
    assert.equal(detectAuthState({ expectedUrlPrefix: 'http://x.test/home', finalUrl: 'http://x.test/home', assertResult: false }), 'unauthenticated');
    assert.equal(detectAuthState({ expectedUrlPrefix: 'http://x.test/home', finalUrl: 'http://x.test/login', assertResult: true }), 'unauthenticated');
  });
});

describe('SessionCoordinator', () => {
  test('[F09-UT-003] 同時 refresh は single-flight で adapter を 1 回だけ呼ぶ', async () => {
    const coordinator = new SessionCoordinator({ refresh: async () => { await Promise.resolve(); return 'ok'; } });
    const [first, second] = await Promise.all([coordinator.refresh('general'), coordinator.refresh('general')]);
    assert.equal(coordinator.adapterCalls, 1);
    assert.equal(first.outcome, 'refreshed');
    assert.equal(second.outcome, 'refreshed');
    assert.equal(second.sessionRevision, 1);
  });

  test('[F09-UT-004] retry 上限 (1) 到達後は lockout 回避のため停止する', async () => {
    const coordinator = new SessionCoordinator({ refresh: async () => { throw new Error('401'); } });
    await assert.rejects(() => coordinator.refresh('general'), /401/);
    const stopped = await coordinator.refresh('general');
    assert.equal(stopped.outcome, 'stopped-lockout-guard');
    assert.equal(coordinator.adapterCalls, 1, '2 回目は adapter を呼ばない');
  });
});

describe('RoleSessionRegistry / vault / mTLS / deadline', () => {
  test('[F09-UT-005] role A/B の cookie jar は共有しない', () => {
    const registry = new RoleSessionRegistry();
    const a = registry.assignJar('admin', ['ADMIN_SID']);
    const b = registry.assignJar('general', ['GENERAL_SID']);
    assert.equal(a.shared, false);
    assert.equal(b.shared, false);
    assert.notEqual(registry.jarOf('admin'), registry.jarOf('general'));
    const conflicting = registry.assignJar('auditor', ['ADMIN_SID']);
    assert.equal(conflicting.shared, true, '既存 jar と同じ cookie を使う組合せは共有と検出');
  });

  test('[F09-UT-006] evidence projection に secret 値を含めない', () => {
    const projection = vaultEvidenceProjection({ flowVersion: 'login-v2', secretReference: 'os-keychain:acct/pw', secretValue: 'hunter2' });
    assert.deepEqual(projection, { flowVersion: 'login-v2', secretReference: 'os-keychain:acct/pw' });
    assert.ok(!JSON.stringify(projection).includes('hunter2'));
  });

  test('[F09-UT-007] client certificate 不在は NeedsInput', () => {
    assert.throws(() => requireMtlsBinding({ certificateAvailable: false }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'NeedsInput');
      return true;
    });
    assert.deepEqual(requireMtlsBinding({ certificateAvailable: true, certAlias: 'diag-client' }), { bound: true });
  });

  test('[F09-UT-008] virtual 60 秒超は timeout になる', () => {
    assert.deepEqual(checkFlowDeadline(60_000), { timedOut: false });
    assert.throws(() => checkFlowDeadline(60_001), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'EngineFailure');
      assert.match((error as DomainError).message, /deadline/);
      return true;
    });
  });
});
