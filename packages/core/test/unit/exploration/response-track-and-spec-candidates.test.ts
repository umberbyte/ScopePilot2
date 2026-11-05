import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PageObservation } from '@scopepilot2/contracts';
import type { ExplorationPort } from '../../../src/ports/engines.ts';
import { bootstrapFlow, type TestFlow } from '../support/test-flow.ts';

/**
 * 診断適用可能性の拡張 (2026-11-05 の能力ギャップ対応):
 * 1. 入力点なし GET API 候補にも応答内容ベースのトラックを割り当てる
 *    (JSON 応答 → api-schema、エンティティ ID 付き経路 → authorization-differential)。
 * 2. API 仕様 (OpenAPI) 取込済み endpoint を診断候補へ合成する
 *    (閲覧クロールでは発火しない書き込み API を仕様から拾う)。
 */

class ApiObservingExplorer implements ExplorationPort {
  readonly engineVersion = 'api-observing-1';

  async observe(url: string): Promise<PageObservation> {
    return {
      url,
      status: 200,
      contentType: 'text/html',
      discoveredFrom: null,
      depth: 0,
      originType: 'crawl',
      links: [],
      forms: [],
      requests: [
        {
          requestId: 'browser-000001',
          url: 'http://fixture.target.test/rest/orders/42',
          method: 'GET',
          resourceType: 'xhr',
          contentType: 'application/json',
          inputPoints: [],
          sourceUrl: url,
        },
        {
          requestId: 'browser-000002',
          url: 'http://fixture.target.test/rest/plain',
          method: 'GET',
          resourceType: 'xhr',
          inputPoints: [],
          sourceUrl: url,
        },
      ],
    };
  }
}

async function runExploration(flow: TestFlow): Promise<ReturnType<TestFlow['service']['runExploration']>> {
  const { plan } = flow.service.buildExplorationPlan(flow.operator, ['http://fixture.target.test/']);
  flow.service.authorizePlan(plan);
  const confirmation = flow.service.confirmPlan(plan, flow.operator);
  return await flow.service.runExploration(flow.operator, plan, confirmation, { maxDepth: 1 });
}

describe('探索: 応答内容トラックと API 仕様候補の合成', () => {
  test('JSON 応答の GET API 候補は api-schema を持つ (パス命名に依存しない)', async () => {
    const flow = await bootstrapFlow({
      allowedOrigins: ['http://fixture.target.test'],
      explorer: new ApiObservingExplorer(),
    });
    const run = await runExploration(flow);
    const jsonCandidate = run.candidates.find((candidate) => candidate.url === 'http://fixture.target.test/rest/orders/42');
    assert.ok(jsonCandidate !== undefined);
    assert.ok(jsonCandidate.diagnosticTracks?.includes('api-schema'), `api-schema がない: ${JSON.stringify(jsonCandidate.diagnosticTracks)}`);
    // エンティティ ID (42) を持つ経路は認可差分の対象。
    assert.ok(jsonCandidate.diagnosticTracks?.includes('authorization-differential'));

    const plainCandidate = run.candidates.find((candidate) => candidate.url === 'http://fixture.target.test/rest/plain');
    assert.ok(plainCandidate !== undefined);
    assert.ok(!plainCandidate.diagnosticTracks?.includes('api-schema'), 'JSON 応答でない候補に api-schema は付けない');
  });

  test('API 仕様の endpoint は診断候補へ合成される (書き込み API を含む)', async () => {
    const flow = await bootstrapFlow({
      allowedOrigins: ['http://fixture.target.test'],
      explorer: new ApiObservingExplorer(),
    });
    flow.service.importApiSpec(flow.operator, {
      documentLabel: 'owned-spec',
      document: {
        openapi: '3.0.0',
        info: { title: 'owned', version: '1.0.0' },
        servers: [{ url: 'http://fixture.target.test' }],
        paths: {
          '/api/Feedbacks': {
            post: { responses: { 200: { description: 'ok' } } },
            get: { responses: { 200: { description: 'ok' } } },
          },
          '/api/Orders/{id}': {
            get: { responses: { 200: { description: 'ok' } } },
          },
        },
      },
    });
    const run = await runExploration(flow);

    const post = run.candidates.find((candidate) => candidate.url === 'http://fixture.target.test/api/Feedbacks' && candidate.method === 'POST');
    assert.ok(post !== undefined, '仕様の POST endpoint が候補化されていない');
    assert.equal(post.category, 'api-endpoint');
    assert.deepEqual(post.guidelineBasis, ['api-spec:owned-spec']);
    assert.ok(post.diagnosticTracks !== undefined && post.diagnosticTracks.length > 0);

    // path template ({id}) は具体値がないため対象外。
    assert.ok(!run.candidates.some((candidate) => candidate.url.includes('{id}')));
    // 仕様の GET endpoint でクロール観測と重複するものは二重に候補化しない (観測由来を優先)。
    assert.equal(run.candidates.filter((candidate) => candidate.url === 'http://fixture.target.test/api/Feedbacks').length, 2, 'GET と POST で別候補 (method違い)');
  });

  test('スクリプト内 API 呼び出し定義は書き込み API 候補になり、トランスポート経路は候補化しない', async () => {
    const explorer = new ApiAndScriptObservingExplorer();
    const flow = await bootstrapFlow({
      allowedOrigins: ['http://fixture.target.test'],
      explorer,
    });
    const { plan } = flow.service.buildExplorationPlan(flow.operator, ['http://fixture.target.test/']);
    flow.service.authorizePlan(plan);
    const confirmation = flow.service.confirmPlan(plan, flow.operator);
    const run = await flow.service.runExploration(flow.operator, plan, confirmation, { maxDepth: 1 });

    // スクリプト定義の書き込み API (閲覧観測には現れない) が候補になる。
    const post = run.candidates.find((candidate) => candidate.url === 'http://fixture.target.test/api/BasketItems' && candidate.method === 'POST');
    assert.ok(post !== undefined, 'スクリプト定義の POST API が候補化されていない');
    assert.equal(post.category, 'api-endpoint');
    assert.equal(post.dynamic, true);
    assert.match(post.detectionReason ?? '', /スクリプト内/);

    // 観測済み GET と同一 URL×method のスクリプト定義は重複しない。
    assert.equal(run.candidates.filter((candidate) => candidate.url === 'http://fixture.target.test/rest/orders/42' && candidate.method === 'GET').length, 1);

    // トランスポート経路 (socket.io ポーリング) は候補化しない。
    assert.ok(!run.candidates.some((candidate) => candidate.url.includes('/socket.io/')), 'socket.io ポーリングが候補化されている');
  });
});

/** 観測リクエスト・スクリプト API 定義・トランスポートポーリングを含む fake explorer。 */
class ApiAndScriptObservingExplorer implements ExplorationPort {
  readonly engineVersion = 'api-script-observing-1';

  async observe(url: string): Promise<PageObservation> {
    return {
      url,
      status: 200,
      contentType: 'text/html',
      discoveredFrom: null,
      depth: 0,
      originType: 'crawl',
      links: [],
      forms: [],
      requests: [
        {
          requestId: 'browser-000001',
          url: 'http://fixture.target.test/rest/orders/42',
          method: 'GET',
          resourceType: 'xhr',
          contentType: 'application/json',
          inputPoints: [],
          sourceUrl: url,
        },
        {
          requestId: 'browser-000002',
          url: 'http://fixture.target.test/socket.io/?EIO=4&transport=polling&t=1699000000000',
          method: 'GET',
          resourceType: 'xhr',
          contentType: 'application/json',
          inputPoints: [
            { name: 'EIO', location: 'query', type: 'string' },
            { name: 'transport', location: 'query', type: 'string' },
            { name: 't', location: 'query', type: 'string' },
          ],
          sourceUrl: url,
        },
      ],
      scriptApiCalls: [
        { method: 'POST', url: 'http://fixture.target.test/api/BasketItems' },
        { method: 'GET', url: 'http://fixture.target.test/rest/orders/42' },
        { method: 'POST', url: 'http://fixture.target.test/socket.io/' },
      ],
    };
  }
}
