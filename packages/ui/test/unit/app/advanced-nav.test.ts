import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { advancedDefaultRoute, advancedNavItems } from '../../../src/app/advanced-nav.ts';
import { resolveRoute } from '../../../src/app/mode-policy.ts';

const FULL_PERMISSIONS = ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'] as const;

describe('advanced navigation (design/02 §3)', () => {
  test('UI-UT-012: 既存ナビの自動診断直後に A41 を置き、全 route が Advanced 専用', () => {
    const items = advancedNavItems(FULL_PERMISSIONS);
    assert.equal(items.length, 14);
    assert.deepEqual(
      items.map((item) => item.screenId),
      ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A41', 'A09', 'A10', 'A11', 'A12', 'A13'],
    );
    const routes = new Set(items.map((item) => item.route));
    assert.equal(routes.size, 14);
    for (const route of routes) {
      const decision = resolveRoute('simple', route, FULL_PERMISSIONS);
      assert.equal(decision.allowed, false, `route ${route} must be Advanced-only`);
    }
  });

  test('UI-UT-013: 権限不足の画面はナビから隠す (case.read のみ)', () => {
    const items = advancedNavItems(['case.read']);
    const enabled = items.filter((item) => item.enabled).map((item) => item.screenId);
    // case.read だけで開けるのは読取系 (Dashboard・Guidelines・Site map・Decoder・Audit)。
    assert.deepEqual(enabled, ['A01', 'A03', 'A04', 'A41', 'A10', 'A12']);
    // 実行系 (run.manage) と案件管理系 (case.manage) は隠す。
    assert.equal(items.find((item) => item.screenId === 'A08')?.enabled, false);
    assert.equal(items.find((item) => item.screenId === 'A13')?.enabled, false);
  });

  test('UI-UT-014: 全権限なら全画面有効・既定着地は A01 Dashboard', () => {
    const items = advancedNavItems(FULL_PERMISSIONS);
    assert.ok(items.every((item) => item.enabled));
    assert.equal(advancedDefaultRoute(FULL_PERMISSIONS), 'advanced.dashboard');
    // case.read がない operator は A01 も開けず、着地先は最初の権限内画面へ後退する。
    assert.equal(advancedDefaultRoute(['finding.confirm']), 'findings');
  });
});
