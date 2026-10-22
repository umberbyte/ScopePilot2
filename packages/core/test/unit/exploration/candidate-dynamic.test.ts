import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ExplorationPort } from '@scopepilot2/core';
import type { PageObservation } from '@scopepilot2/contracts';
import { bootstrapFlow } from '../support/test-flow.ts';

class DynamicCandidateExplorer implements ExplorationPort {
  readonly engineVersion = 'fake-explorer-1';

  async observe(url: string): Promise<PageObservation> {
    const parsed = new URL(url);
    return {
      url,
      status: 200,
      contentType: 'text/html',
      discoveredFrom: null,
      depth: 0,
      originType: 'crawl',
      links: [],
      forms: [],
      ...(parsed.pathname === '/javascript'
        ? { javascriptSignals: { scriptElements: 1, inlineEventHandlers: 1, javascriptUrls: 0 } }
        : {}),
    };
  }
}

describe('探索候補の動的初期選択判定', () => {
  test('JavaScriptページとGETパラメータ付きURLを動的候補として返し、純静的ページと区別する', async () => {
    const { service, operator } = await bootstrapFlow({ explorer: new DynamicCandidateExplorer() });
    const { plan } = service.buildExplorationPlan(operator, [
      'http://fixture.target.test/static',
      'http://fixture.target.test/javascript',
      'http://fixture.target.test/search?q=scopepilot',
      'http://fixture.target.test/logout.php',
    ]);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);
    const result = await service.runExploration(operator, plan, confirmation, { maxDepth: 1 });
    const byUrl = new Map(result.candidates.map((candidate) => [candidate.url, candidate]));

    assert.equal(byUrl.get('http://fixture.target.test/static')?.dynamic, false);
    assert.equal(byUrl.get('http://fixture.target.test/javascript')?.dynamic, true);
    assert.match(byUrl.get('http://fixture.target.test/javascript')?.detectionReason ?? '', /JavaScript要素 1 件/);
    assert.equal(byUrl.get('http://fixture.target.test/search?q=scopepilot')?.dynamic, true);
    assert.match(byUrl.get('http://fixture.target.test/search?q=scopepilot')?.detectionReason ?? '', /GETパラメータ 1 件/);
    assert.equal(byUrl.has('http://fixture.target.test/logout.php'), false);
    assert.ok(result.deniedUrls.some((entry) => entry.url === 'http://fixture.target.test/logout.php'));
  });
});
