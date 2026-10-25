import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { presentTargets } from '../../../src/presenters/hint-origin.ts';

describe('hintOrigin presenter', () => {
  test('[UI-UT-004] document hint と観測 URL が混在しても未確認ラベルと出典を保持する', () => {
    const presented = presentTargets([
      { url: 'http://a.test/observed', originType: 'crawl' },
      { url: 'http://a.test/panel', originType: 'document-hint', documentSource: '操作手順書 v2 p.13' },
      { url: 'http://a.test/api-docs', originType: 'document-hint' },
    ]);
    assert.deepEqual(presented[0], { url: 'http://a.test/observed', confirmed: true, originLabel: '観測', sourceLabel: 'クロール' });
    assert.equal(presented[1]?.confirmed, false);
    assert.equal(presented[1]?.originLabel, '未確認');
    assert.equal(presented[1]?.sourceLabel, '文書の記載 (操作手順書 v2 p.13)');
    assert.equal(presented[2]?.sourceLabel, '文書の記載');
  });
});
