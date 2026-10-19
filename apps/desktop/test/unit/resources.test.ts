import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { strings, t } from '../../src/renderer/resources.ts';

/** 文字列資源 (design/28 §8.1 MUST 10)。placeholder 置換と文の完結性。 */
describe('ui string resources', () => {
  test('placeholder を置換し、未指定 placeholder は残さない主要文で検証', () => {
    assert.equal(t('wizard.s01.opened', { caseName: 'ScopePilot2 案件' }), '案件「ScopePilot2 案件」を開きました。');
    assert.equal(t('wizard.s04.adopt', { count: 3 }), '選択を採用する (3 件)');
    assert.equal(t('app.mode.simple'), 'シンプル');
  });

  test('資源は文単位で完結する (連結用の断片 key を持たない)', () => {
    // prefix/suffix のような断片は unverified 補足のみで、それも独立 key として持つ。
    assert.equal(strings['wizard.s06.unverified'], ' ・実影響未確認');
    assert.ok(Object.keys(strings).every((key) => !key.endsWith('.prefix') && !key.endsWith('.suffix')));
  });
});
