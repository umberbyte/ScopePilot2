import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

describe('ExplorationPlanner budget (BaselineFlowService.runExploration)', () => {
  test('[F08-UT-002] page 上限と depth 上限で新規候補の走査を停止する', async () => {
    // page 上限: 観測が 2 ページに達した時点で budget-exhausted として停止し、
    // adapter は上限を超えて呼ばれない。
    const limited = await bootstrapFlow({
      allowedOrigins: ['http://budget.test'],
      caseLimits: { maxRequests: 5000, maxPages: 2, maxDurationMinutes: 60 },
    });
    const { plan: limitedPlan } = limited.service.buildExplorationPlan(limited.operator, ['http://budget.test/']);
    limited.service.authorizePlan(limitedPlan);
    const confirmation = limited.service.confirmPlan(limitedPlan, limited.operator);
    const limitedRun = await limited.service.runExploration(limited.operator, limitedPlan, confirmation, { maxDepth: 5 });
    assert.equal(limitedRun.runRecord.stopReason, 'budget-exhausted');
    assert.equal(limitedRun.observations.length, 2);
    assert.equal(limited.explorer.calls().length, 2);

    // depth 上限: depth 1 までしか巡回せず、それ以上の候補を frontier へ追加しない。
    const deep = await bootstrapFlow({ allowedOrigins: ['http://depth.test'] });
    const { plan: deepPlan } = deep.service.buildExplorationPlan(deep.operator, ['http://depth.test/']);
    deep.service.authorizePlan(deepPlan);
    const deepConfirmation = deep.service.confirmPlan(deepPlan, deep.operator);
    const deepRun = await deep.service.runExploration(deep.operator, deepPlan, deepConfirmation, { maxDepth: 1 });
    assert.equal(deepRun.runRecord.stopReason, 'completed');
    assert.deepEqual(
      deepRun.observations.map((observation) => observation.url),
      ['http://depth.test/', 'http://depth.test/child/'],
    );
    assert.deepEqual(
      deepRun.observations.map((observation) => observation.depth),
      [0, 1],
    );
  });
});
