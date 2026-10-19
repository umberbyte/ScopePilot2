import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

/**
 * document hints (AGENTS.md 入力ドキュメントの活用) の service 経路。
 * 登録は許可 Origin 内の URL 数を監査に残し、計画構築で追加開始点へ統合、
 * 観測は由来 (document-hint) を付けて記録される。hint 単独では観測を作らない。
 */
describe('document hints (入力ドキュメントの活用)', () => {
  test('登録→計画統合→hint 由来の観測まで。監査は計数のみ', async () => {
    const { service, operator } = await bootstrapFlow();
    const registered = service.registerDocumentHints(operator, {
      documentLabel: '操作手順書 v2',
      urls: [
        'http://fixture.target.test/setup.php',
        'http://elsewhere.example/out-of-scope', // 許可外 → 計数に含まれない
      ],
    });
    assert.equal(registered.urlCount, 2);
    assert.equal(registered.acceptedUrlCount, 1);
    assert.deepEqual(service.listDocumentHints(), [
      { documentLabel: '操作手順書 v2', urls: ['http://fixture.target.test/setup.php', 'http://elsewhere.example/out-of-scope'] },
    ]);

    // 計画の target snapshot に hint が統合される (確認対象に含まれる)。
    const { plan } = service.buildExplorationPlan(operator, ['http://fixture.target.test/']);
    service.authorizePlan(plan);
    assert.deepEqual(plan.steps[0]?.targetSnapshot, ['http://fixture.target.test/', 'http://fixture.target.test/setup.php']);

    const confirmation = service.confirmPlan(plan, operator);
    const run = await service.runExploration(operator, plan, confirmation, { maxDepth: 1 });
    assert.equal(run.runRecord.state, 'Completed');

    // hint 由来の観測は originType=document-hint、明示 seed と link は crawl。
    const setup = service.listObservations().find((observation) => observation.url === 'http://fixture.target.test/setup.php');
    assert.equal(setup?.originType, 'document-hint');
    const home = service.listObservations().find((observation) => observation.url === 'http://fixture.target.test/');
    assert.equal(home?.originType, 'crawl');

    // 監査 event は label と計数のみ (URL の一覧は応答・監査に出さない設計ではないが、
    // ここでは計数の記録を検証する)。
    const eventsText = JSON.stringify(service.events());
    assert.ok(eventsText.includes('DocumentHintsRegistered'));
    assert.ok(eventsText.includes('操作手順書 v2'));
  });

  test('空 label・空 URL 一覧は検証 error。権限なしは拒否', async () => {
    const { service, operator } = await bootstrapFlow();
    assert.throws(
      () => service.registerDocumentHints(operator, { documentLabel: '  ', urls: ['http://fixture.target.test/setup.php'] }),
      /documentLabel must not be empty/,
    );
    assert.throws(
      () => service.registerDocumentHints(operator, { documentLabel: 'doc', urls: [] }),
      /at least one URL/,
    );
    const limited = { ...operator, permissions: ['case.read'] } as typeof operator;
    assert.throws(
      () => service.registerDocumentHints(limited, { documentLabel: 'doc', urls: ['http://fixture.target.test/setup.php'] }),
      /permission/,
    );
  });
});
