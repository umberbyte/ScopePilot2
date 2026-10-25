import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

/** site map 台帳 (design/02 A04)。再探索では URL 単位に更新し、行を増やさない。 */
describe('observation ledger (site map)', () => {
  test('再探索しても観測 URL は重複せず、初回観測順で一覧できる', async () => {
    const { service, operator } = await bootstrapFlow();
    const runExplore = async (): Promise<void> => {
      const { plan } = service.buildExplorationPlan(operator, ['http://fixture.target.test/']);
      service.authorizePlan(plan);
      const confirmation = service.confirmPlan(plan, operator);
      await service.runExploration(operator, plan, confirmation, { maxDepth: 1 });
    };
    await runExplore();
    const first = service.listObservations();
    assert.ok(first.length > 0, '探索で観測がある');
    const firstUrls = first.map((observation) => observation.url);
    assert.equal(new Set(firstUrls).size, firstUrls.length, '1 回の探索で重複なし');

    await runExplore();
    const second = service.listObservations();
    assert.equal(
      new Set(second.map((observation) => observation.url)).size,
      second.length,
      '再探索しても URL 単位で一意',
    );
    // 初回観測順は維持される (site map の安定表示)。
    assert.deepEqual(second.map((observation) => observation.url).slice(0, firstUrls.length), firstUrls);
  });
});
