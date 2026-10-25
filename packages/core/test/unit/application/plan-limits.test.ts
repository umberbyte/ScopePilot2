import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

/** 上限の狭め指定 (Advanced モードの上限編集)。既定・案件上限の内側だけを許す。 */
describe('plan limits request (narrowing)', () => {
  test('指定した上限は計画 step に反映され、案件上限・既定を超えられない', async () => {
    const { service, operator } = await bootstrapFlow();

    // 狭め指定はそのまま反映される。
    const narrowed = service.buildExplorationPlan(operator, ['http://fixture.target.test/'], {
      maxRequests: 300,
      maxPages: 50,
      maxDurationMinutes: 10,
    });
    const narrowedStep = narrowed.plan.steps[0];
    assert.deepEqual(
      { maxRequests: narrowedStep?.limits.maxRequests, maxPages: narrowedStep?.limits.maxPages, maxDurationMinutes: narrowedStep?.limits.maxDurationMinutes },
      { maxRequests: 300, maxPages: 50, maxDurationMinutes: 10 },
    );

    // 案件上限 (5000/500/60) を超える指定は案件上限へクランプされる。
    // (3 点の上限は案件との契約が天井。既定 30 分を超えても案件が許す 60 分までは指定できる)
    const clamped = service.buildActiveScanPlan(operator, ['http://fixture.target.test/page'], {
      maxRequests: 999_999,
      maxPages: 999_999,
      maxDurationMinutes: 999_999,
    });
    const clampedStep = clamped.plan.steps[0];
    assert.deepEqual(
      { maxRequests: clampedStep?.limits.maxRequests, maxPages: clampedStep?.limits.maxPages, maxDurationMinutes: clampedStep?.limits.maxDurationMinutes },
      { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      '案件上限の内側に収まる',
    );

    // 並列度・rate は UI 指定なく常に既定 (安全天井)。
    assert.equal(clampedStep?.limits.maxConcurrency, 2);
    assert.equal(clampedStep?.limits.requestsPerSecond, 2);
  });

  test('非正の上限指定は ValidationFailed', async () => {
    const { service, operator } = await bootstrapFlow();
    assert.throws(
      () => service.buildExplorationPlan(operator, ['http://fixture.target.test/'], { maxRequests: 0, maxPages: 50, maxDurationMinutes: 10 }),
      /plan.explore limit/,
    );
  });
});
