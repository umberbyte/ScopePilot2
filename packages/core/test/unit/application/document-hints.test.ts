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

  test('認証情報 hint は所在のみ登録でき、秘密値の持込みは最初から拒否される', async () => {
    const { service, operator } = await bootstrapFlow();
    const registered = service.registerDocumentAuthHints(operator, {
      documentLabel: '操作手順書 v2',
      entries: [
        { role: 'admin', authMethod: 'Form', documentLocation: 'p.13 管理者ログイン' },
        { role: 'api-client', authMethod: 'Bearer', documentLocation: '付録 B' },
      ],
    });
    assert.deepEqual(registered, { documentLabel: '操作手順書 v2', entryCount: 2 });
    assert.deepEqual(service.listDocumentAuthHints(), [
      {
        documentLabel: '操作手順書 v2',
        entries: [
          { role: 'admin', authMethod: 'Form', documentLocation: 'p.13 管理者ログイン' },
          { role: 'api-client', authMethod: 'Bearer', documentLocation: '付録 B' },
        ],
      },
    ]);
    // 監査 event は文書 label と件数のみを記録する。
    const events = service.events() as readonly { type: string; documentLabel?: string; entryCount?: number }[];
    const event = events.find((candidate) => candidate.type === 'DocumentAuthHintsRegistered');
    assert.ok(event !== undefined);
    assert.equal(event.documentLabel, '操作手順書 v2');
    assert.equal(event.entryCount, 2);

    // allowlist 外の方式・空欄は拒否。
    assert.throws(
      () => service.registerDocumentAuthHints(operator, { documentLabel: 'd', entries: [{ role: 'admin', authMethod: 'OAuth' as never, documentLocation: 'p.1' }] }),
      /authMethod not allowed/,
    );
    assert.throws(
      () => service.registerDocumentAuthHints(operator, { documentLabel: 'd', entries: [{ role: '', authMethod: 'Form', documentLocation: 'p.1' }] }),
      /role must not be empty/,
    );
    assert.throws(
      () => service.registerDocumentAuthHints(operator, { documentLabel: 'd', entries: [] }),
      /at least one entry/,
    );
  });

  test('優先付け規則は探索の処理順に反映される (pii・payment が高優先)', async () => {
    const { service, operator } = await bootstrapFlow();
    // login.php (pii 規則に一致) を setup.php より後に登録しても先に観測される。
    service.registerDocumentPriorityHints(operator, {
      documentLabel: '操作手順書 v2',
      rules: [{ urlIncludes: '/login.php', category: 'pii' }],
    });
    assert.deepEqual(service.listDocumentPriorityRules(), [{ urlIncludes: '/login.php', category: 'pii' }]);

    const { plan } = service.buildExplorationPlan(operator, ['http://fixture.target.test/setup.php', 'http://fixture.target.test/login.php']);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);
    await service.runExploration(operator, plan, confirmation, { maxDepth: 1 });
    const urls = service.listObservations().map((observation) => observation.url);
    assert.equal(urls[0], 'http://fixture.target.test/login.php', '高優先の URL が最初に観測される');
    assert.ok(JSON.stringify(service.events()).includes('DocumentPriorityHintsRegistered'));

    // allowlist 外の区分・空条件は拒否。
    assert.throws(
      () => service.registerDocumentPriorityHints(operator, { documentLabel: 'd', rules: [{ urlIncludes: '/x', category: 'other' as never }] }),
      /category not allowed/,
    );
    assert.throws(
      () => service.registerDocumentPriorityHints(operator, { documentLabel: 'd', rules: [{ urlIncludes: '  ', category: 'pii' }] }),
      /urlIncludes must not be empty/,
    );
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
