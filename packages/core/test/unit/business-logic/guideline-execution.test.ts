import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveGuidelineThemeRoutes } from '@scopepilot2/core';

describe('guideline execution route selection', () => {
  test('未選択・HTTP対象外ガイドラインではZAP非対応テーマを自動追加しない', () => {
    assert.deepEqual(resolveGuidelineThemeRoutes([]), []);
    assert.deepEqual(resolveGuidelineThemeRoutes(['OWASP AISVS 1.01']), []);
  });

  test('ASVS/WSTG/DS-221/WAPG はテーマ30を自動経路へ接続する', () => {
    for (const guideline of ['OWASP ASVS 5.0', 'OWASP WSTG 4.2', 'デジタル庁 DS-221', 'IPA/NISC/WebAppPentestGuidelines']) {
      const routes = resolveGuidelineThemeRoutes([guideline]);
      assert.equal(routes.find((route) => route.themeNo === '30')?.mode, 'automatic', guideline);
      assert.ok(routes.some((route) => route.mode === 'needs-input'), guideline);
    }
  });

  test('複数選択時はテーマを重複せず、由来ガイドラインを保持する', () => {
    const routes = resolveGuidelineThemeRoutes(['OWASP ASVS 5.0', 'デジタル庁 DS-221']);
    const theme30 = routes.filter((route) => route.themeNo === '30');
    assert.equal(theme30.length, 1);
    assert.deepEqual(theme30[0]?.guidelineIds, ['OWASP ASVS 5.0', 'デジタル庁 DS-221']);
    assert.equal(routes.find((route) => route.themeNo === '26')?.mode, 'needs-input');
  });
});
