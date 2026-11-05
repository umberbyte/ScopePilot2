import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PageObservation } from '@scopepilot2/contracts';
import type { ExplorationPort } from '../../../src/ports/engines.ts';
import { bootstrapFlow } from '../support/test-flow.ts';

/**
 * 動的ルートの具体化 (F08): スクリプト由来の :param テンプレートは
 * 観測済み識別子 (API 応答・URL セグメント由来) だけで具体化して巡回する。
 * テンプレート自体は巡回しない。識別子の推測・補完は行わない。
 */

interface ScriptedObservation {
  readonly links?: readonly string[];
  readonly routeTemplates?: readonly string[];
  readonly observedResourceIds?: readonly string[];
}

class ScriptedExplorer implements ExplorationPort {
  readonly engineVersion = 'scripted-explorer-1';
  readonly observeCalls: string[] = [];
  private readonly scripts = new Map<string, ScriptedObservation>();

  script(url: string, observation: ScriptedObservation): this {
    this.scripts.set(url, observation);
    return this;
  }

  async observe(url: string): Promise<PageObservation | null> {
    this.observeCalls.push(url);
    const scripted = this.scripts.get(url);
    return {
      url,
      status: 200,
      contentType: 'text/html',
      discoveredFrom: null,
      depth: 0,
      originType: 'crawl',
      links: scripted?.links ?? [],
      forms: [],
      ...(scripted?.routeTemplates === undefined ? {} : { routeTemplates: scripted.routeTemplates }),
      ...(scripted?.observedResourceIds === undefined ? {} : { observedResourceIds: scripted.observedResourceIds }),
    };
  }
}

async function runWithExplorer(explorer: ExplorationPort, seed: string, maxDepth = 3) {
  const flow = await bootstrapFlow({ allowedOrigins: ['http://fixture.target.test'], explorer });
  const { plan } = flow.service.buildExplorationPlan(flow.operator, [seed]);
  flow.service.authorizePlan(plan);
  const confirmation = flow.service.confirmPlan(plan, flow.operator);
  const run = await flow.service.runExploration(flow.operator, plan, confirmation, { maxDepth });
  return run;
}

describe('探索: 動的ルートテンプレートの観測識別子による具体化', () => {
  test('テンプレートと識別子が揃うと具体化 URL を巡回し、テンプレート自体は巡回しない', async () => {
    const explorer = new ScriptedExplorer()
      .script('http://fixture.target.test/', {
        routeTemplates: ['http://fixture.target.test/item/:id'],
        observedResourceIds: ['7'],
      })
      .script('http://fixture.target.test/item/7', {});
    const run = await runWithExplorer(explorer, 'http://fixture.target.test/');

    assert.ok(explorer.observeCalls.includes('http://fixture.target.test/item/7'), `具体化 URL が巡回されていない: ${explorer.observeCalls.join(' ')}`);
    assert.ok(!explorer.observeCalls.some((url) => url.includes(':id')), 'テンプレート自体が巡回された');
    assert.ok(run.observations.some((observation) => observation.url === 'http://fixture.target.test/item/7'));
  });

  test('識別子が観測されるまでテンプレートは巡回しない (推測した ID を送信しない)', async () => {
    const explorer = new ScriptedExplorer()
      .script('http://fixture.target.test/', { routeTemplates: ['http://fixture.target.test/item/:id'] });
    await runWithExplorer(explorer, 'http://fixture.target.test/');

    assert.deepEqual(explorer.observeCalls, ['http://fixture.target.test/']);
  });

  test('テンプレートより後に観測した識別子でも具体化する (蓄積は順非依存)', async () => {
    const explorer = new ScriptedExplorer()
      .script('http://fixture.target.test/', {
        links: ['http://fixture.target.test/api/items'],
        observedResourceIds: ['12'],
      })
      .script('http://fixture.target.test/api/items', {
        routeTemplates: ['http://fixture.target.test/item/:id'],
      })
      .script('http://fixture.target.test/item/12', {});
    const run = await runWithExplorer(explorer, 'http://fixture.target.test/');

    assert.ok(explorer.observeCalls.includes('http://fixture.target.test/item/12'), `具体化 URL が巡回されていない: ${explorer.observeCalls.join(' ')}`);
    assert.ok(run.observations.some((observation) => observation.url === 'http://fixture.target.test/item/12'));
  });

  test('1テンプレートあたりの具体化上限 (8) と識別子の順序を守る', async () => {
    const explorer = new ScriptedExplorer()
      .script('http://fixture.target.test/', {
        routeTemplates: ['http://fixture.target.test/item/:id'],
        observedResourceIds: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
      });
    await runWithExplorer(explorer, 'http://fixture.target.test/');

    const instantiated = explorer.observeCalls.filter((url) => /^http:\/\/fixture\.target\.test\/item\/\d+$/.test(url));
    assert.deepEqual(instantiated, ['http://fixture.target.test/item/1', 'http://fixture.target.test/item/2', 'http://fixture.target.test/item/3', 'http://fixture.target.test/item/4', 'http://fixture.target.test/item/5', 'http://fixture.target.test/item/6', 'http://fixture.target.test/item/7', 'http://fixture.target.test/item/8']);
  });

  test('複数ページで観測された識別子を優先して具体化する', async () => {
    // テンプレートは 2 ページ目で発見される (識別子の観測頻度が蓄積した後)。
    const explorer = new ScriptedExplorer()
      .script('http://fixture.target.test/', {
        links: ['http://fixture.target.test/detail'],
        observedResourceIds: ['1', '2', '9', '3', '4', '5', '6', '7', '8'],
      })
      .script('http://fixture.target.test/detail', {
        routeTemplates: ['http://fixture.target.test/item/:id'],
        // id 9 は 2 ページで観測される (中心的なエンティティ)。
        observedResourceIds: ['9'],
      });
    await runWithExplorer(explorer, 'http://fixture.target.test/');

    const instantiated = explorer.observeCalls.filter((url) => /^http:\/\/fixture\.target\.test\/item\/\d+$/.test(url));
    assert.equal(instantiated[0], 'http://fixture.target.test/item/9', '高頻度の id を最優先する');
    assert.equal(instantiated.length, 8, 'テンプレートあたり上限');
    assert.deepEqual(instantiated.slice(1), ['http://fixture.target.test/item/1', 'http://fixture.target.test/item/2', 'http://fixture.target.test/item/3', 'http://fixture.target.test/item/4', 'http://fixture.target.test/item/5', 'http://fixture.target.test/item/6', 'http://fixture.target.test/item/7'], '残りは観測順');
  });

  test('複数パラメータのテンプレートは具体化しない', async () => {
    const explorer = new ScriptedExplorer()
      .script('http://fixture.target.test/', {
        routeTemplates: ['http://fixture.target.test/a/:id/b/:name'],
        observedResourceIds: ['7'],
      });
    await runWithExplorer(explorer, 'http://fixture.target.test/');

    assert.deepEqual(explorer.observeCalls, ['http://fixture.target.test/']);
  });

  test('具体化 URL は scope・session-control・上限の既存の安全制御を通る', async () => {
    // template が別 Origin を指していても、具体化 URL は pop 時に scope 拒否される。
    const explorer = new ScriptedExplorer()
      .script('http://fixture.target.test/', {
        routeTemplates: ['http://elsewhere.example/item/:id'],
        observedResourceIds: ['7'],
      });
    const run = await runWithExplorer(explorer, 'http://fixture.target.test/');

    assert.deepEqual(explorer.observeCalls, ['http://fixture.target.test/']);
    assert.ok(run.deniedUrls.some((denied) => denied.url === 'http://elsewhere.example/item/7'));
  });

  test('depth 上限を超える具体化は行わない', async () => {
    // depth 1 のページでテンプレート・識別子を観測しても、maxDepth 1 なら
    // 具体化 (depth 2) は frontier へ入らない。
    const explorer = new ScriptedExplorer()
      .script('http://fixture.target.test/', { links: ['http://fixture.target.test/section'] })
      .script('http://fixture.target.test/section', {
        routeTemplates: ['http://fixture.target.test/item/:id'],
        observedResourceIds: ['7'],
      });
    await runWithExplorer(explorer, 'http://fixture.target.test/', 1);

    assert.deepEqual(explorer.observeCalls, ['http://fixture.target.test/', 'http://fixture.target.test/section']);
  });
});
