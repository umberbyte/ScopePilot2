import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ACTIVE_SCAN_DEFAULTS, describeStepGuarantee, runManagedTemplate, scanPlanLimits, selectScanTargets, validateScanUrlCount } from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

const scope = { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] };

describe('ActiveScanPlanner / TargetSelector / Coverage / TemplateRunner', () => {
  test('[F11-UT-001] 既定値は固定した安全既定となる', () => {
    assert.deepEqual(ACTIVE_SCAN_DEFAULTS, {
      spiderDepth: 5,
      concurrency: 2,
      requestsPerSecond: 2,
      maxDurationMinutes: 30,
      maxUrls: 5000,
      attackStrength: 'Low',
    });
    const { limits } = scanPlanLimits();
    assert.deepEqual(limits, {
      maxRequests: 5000,
      maxPages: 5000,
      maxDurationMinutes: 30,
      maxConcurrency: 2,
      requestsPerSecond: 2,
    });
  });

  test('[F11-UT-002] 5,001 URL は plan validation を失敗させる', () => {
    assert.doesNotThrow(() => validateScanUrlCount(5000));
    assert.throws(() => validateScanUrlCount(5001), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'ValidationFailed');
      assert.match((error as DomainError).message, /exceeds the fixed limit 5000/);
      return true;
    });
  });

  test('[F11-UT-003] scope 外候補は target snapshot から除外する', () => {
    const result = selectScanTargets(
      ['http://fixture.target.test/a?x=1', 'http://fixture.target.test/a?x=2', 'http://elsewhere.example/b'],
      scope,
    );
    assert.deepEqual(result.selected, ['http://fixture.target.test/a?x=1', 'http://fixture.target.test/a?x=2']);
    assert.equal(result.excluded.length, 1);
  });

  test('[F11-UT-007] delegated step を強制保証と誤表示しない', () => {
    const delegated = describeStepGuarantee({ engineKind: 'zap', guarantee: 'Delegated' });
    assert.equal(delegated.preSendGuaranteed, false);
    assert.match(delegated.label, /送信前拒否は保証しない/);
    const enforced = describeStepGuarantee({ engineKind: 'playwright', guarantee: 'Enforced' });
    assert.equal(enforced.preSendGuaranteed, true);
  });

  test('[F11-UT-008] 管理テンプレートが scope 外へ変形されたら送信前拒否する', async () => {
    const sent: string[] = [];
    const rejected = await runManagedTemplate(
      {
        name: 'template-1',
        requests: [
          { url: 'http://fixture.target.test/ok', method: 'GET' },
          { url: 'http://elsewhere.example/leak', method: 'GET' },
        ],
      },
      scope,
      { send: async (url: string) => { sent.push(url); } },
    );
    assert.deepEqual(rejected, { sent: 0, rejected: { url: 'http://elsewhere.example/leak', reason: 'origin http://elsewhere.example is not in allowed origins' } });
    assert.equal(sent.length, 0, '1 件も送信しない (送信前拒否)');

    const allowed = await runManagedTemplate(
      { name: 'template-1', requests: [{ url: 'http://fixture.target.test/ok', method: 'GET' }] },
      scope,
      { send: async (url: string) => { sent.push(url); } },
    );
    assert.deepEqual(allowed, { sent: 1 });
    assert.deepEqual(sent, ['http://fixture.target.test/ok']);
  });
});
