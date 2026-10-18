import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classifyAction,
  formRequiresConfirmation,
  observedPageFromSources,
  runBudgetedActions,
  seedHints,
  UrlFrontier,
} from '@scopepilot2/core';

const scope = { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] };

describe('UrlFrontier', () => {
  test('[F08-UT-001] 同 URL 再発見は dedupe し provenance を追加する', () => {
    const frontier = new UrlFrontier();
    assert.deepEqual(frontier.add({ url: 'http://fixture.target.test/a', depth: 0, discoveredFrom: null, originType: 'crawl' }), { added: true });
    assert.deepEqual(frontier.add({ url: 'http://fixture.target.test/a', depth: 2, discoveredFrom: 'page-b', originType: 'crawl' }), { added: false });
    const entry = frontier.entry('http://fixture.target.test/a');
    // 再発見は新規 entry を作らず、発見元 (provenance) だけを追加する。
    assert.deepEqual(entry?.provenance, ['seed', 'page-b']);
    assert.equal(entry?.depth, 0, '初回の depth を保持');
    assert.equal(frontier.drain().length, 1);
  });
});

describe('ActionClassifier / FormPolicy', () => {
  test('[F08-UT-003] delete/logout 表現は自動操作しない', () => {
    assert.deepEqual(classifyAction({ label: 'アカウント削除' }).safety, 'manual-only');
    assert.deepEqual(classifyAction({ label: 'LogOut' }).safety, 'manual-only');
    assert.deepEqual(classifyAction({ label: 'unsubscribe newsletters' }).safety, 'manual-only');
    assert.equal(classifyAction({ label: '次へ', method: 'GET' }).safety, 'auto');
    assert.equal(classifyAction({ label: '検索', method: 'POST' }).safety, 'manual-only');
  });

  test('[F08-UT-004] write form は confirmation 必要とする', () => {
    assert.deepEqual(formRequiresConfirmation('data-write'), { requires: true, reason: /data-write/.exec('data-write form changes server state; plan confirmation required')?.[0] ? 'data-write form changes server state; plan confirmation required' : '' });
    assert.equal(formRequiresConfirmation('login').requires, true);
    assert.equal(formRequiresConfirmation('search').requires, false);
    assert.equal(formRequiresConfirmation('filter').requires, false);
  });
});

describe('HintSeedPolicy', () => {
  test('[F08-UT-005] scope 外の document URL は frontier へ追加しない', () => {
    const result = seedHints(
      { ok: true, hints: { urls: ['http://fixture.target.test/admin', 'http://elsewhere.example/panel'] } },
      scope,
    );
    assert.deepEqual(result.seeded, ['http://fixture.target.test/admin']);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0]?.reason ?? '', /not in allowed origins/);
  });

  test('[F08-UT-006] hint 抽出失敗は empty hints で探索を継続する', () => {
    const result = seedHints({ ok: false, reason: 'document parse error' }, scope);
    assert.deepEqual(result.seeded, []);
    assert.equal(result.continued, true);
    assert.match(result.note ?? '', /continuing without hints/);
  });
});

describe('exploration budget / observation', () => {
  test('[F08-UT-007] cancel 後は adapter action を呼ばない', async () => {
    const acted: string[] = [];
    let cancelled = false;
    const result = await runBudgetedActions([{ label: 'a' }, { label: 'b' }, { label: 'c' }], { maxActions: 10 }, {
      isCancelled: () => cancelled,
      adapter: { act: async (label) => { acted.push(label); } },
    });
    assert.deepEqual(result, { performed: 3, cancelledAt: null });
    cancelled = true;
    const stopped = await runBudgetedActions([{ label: 'a' }], { maxActions: 10 }, {
      isCancelled: () => cancelled,
      adapter: { act: async (label) => { acted.push(label); } },
    });
    assert.deepEqual(stopped, { performed: 0, cancelledAt: 0 });
    assert.deepEqual(acted, ['a', 'b', 'c'], 'cancel 後の追加 action なし');
  });

  test('[F08-UT-008] document hint のみでは observed page を生成しない', () => {
    assert.deepEqual(observedPageFromSources([{ originType: 'document-hint' }]), { observed: false });
    assert.deepEqual(observedPageFromSources([{ originType: 'document-hint' }, { originType: 'crawl' }]), { observed: true });
  });
});
