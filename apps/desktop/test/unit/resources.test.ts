import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getLocale, localeTables, setLocale, t } from '../../src/renderer/resources.ts';
import { jaStrings } from '../../src/renderer/resources.ja.ts';
import { enStrings } from '../../src/renderer/resources.en.ts';

/** 文字列資源 (design/28 §8.1 MUST 10)。placeholder 置換・文の完結性・locale 切替。 */
describe('ui string resources', () => {
  test('placeholder を置換し、未指定 placeholder は残さない主要文で検証', () => {
    assert.equal(t('wizard.s01.opened', { caseName: 'ScopePilot2 案件' }), '案件「ScopePilot2 案件」を開きました。');
    assert.equal(t('wizard.s04.adopt', { count: 3 }), '選択を採用する (3 件)');
    assert.equal(t('app.mode.simple'), 'シンプル');
  });

  test('資源は文単位で完結する (連結用の断片 key を持たない)', () => {
    assert.equal(jaStrings['wizard.s06.unverified'], ' ・実影響未確認');
    assert.ok(Object.keys(jaStrings).every((key) => !key.endsWith('.prefix') && !key.endsWith('.suffix')));
  });

  test('en は ja と同一 key 集を持ち、locale を切り替えると出力が変わる', () => {
    const jaKeys = Object.keys(jaStrings).sort();
    const enKeys = Object.keys(enStrings).sort();
    assert.deepEqual(enKeys, jaKeys, 'en table は ja と過不足なく一致');

    assert.equal(getLocale(), 'ja');
    assert.equal(t('app.mode.advanced'), 'アドバンスド');
    setLocale('en');
    try {
      assert.equal(getLocale(), 'en');
      assert.equal(t('app.mode.advanced'), 'Advanced');
      assert.equal(t('wizard.s04.adopt', { count: 3 }), 'Adopt selection (3 items)');
    } finally {
      setLocale('ja');
    }
    assert.equal(t('app.mode.advanced'), 'アドバンスド');

    assert.deepEqual(Object.keys(localeTables).sort(), ['en', 'ja']);
  });
});
