import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { ADVANCED_NAV_GROUPS, advancedDefaultRoute, advancedNavGroups, advancedNavItems } from '../../../src/app/advanced-nav.ts';
import { LEGACY_ROUTE_MAP, ROUTE_PERMISSIONS, normalizeRoute, resolveRoute, type UiRoute } from '../../../src/app/mode-policy.ts';

const FULL_PERMISSIONS = ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'] as const;

describe('advanced navigation (design/40 §3)', () => {
  test('UI-UT-012: 目的別 9 グループ・設計順で、設定だけが下端', () => {
    assert.deepEqual(
      ADVANCED_NAV_GROUPS.map((group) => group.groupId),
      ['case', 'auth', 'recon', 'manual', 'scan', 'tools', 'results', 'ops', 'settings'],
    );
    assert.deepEqual(
      ADVANCED_NAV_GROUPS.filter((group) => group.placement === 'footer').map((group) => group.groupId),
      ['settings'],
    );
    const items = advancedNavItems(FULL_PERMISSIONS);
    assert.deepEqual(
      items.map((item) => item.screenId),
      [
        'A01', 'A02', 'A03',
        'A10', 'A11',
        'A20', 'A21', 'A22', 'A23', 'A24',
        'A30', 'A31', 'A32', 'A33', 'A34', 'A35',
        'A40', 'A41', 'A42', 'A43',
        'A50', 'A51', 'A52',
        'A60', 'A61', 'A62',
        'A70', 'A71',
        'A90', 'A91', 'A92', 'A93', 'A94',
      ],
    );
  });

  test('UI-UT-012: 全 Advanced route はちょうど 1 グループに属し、ID の十の位がグループと一致する', () => {
    const advancedRoutes = (Object.keys(ROUTE_PERMISSIONS) as UiRoute[]).filter((route) => route.startsWith('adv.'));
    const owners = new Map<string, string[]>();
    for (const group of ADVANCED_NAV_GROUPS) {
      const tens = new Set(group.screens.map((screen) => screen.screenId.slice(1, 2)));
      assert.equal(tens.size, 1, `group ${group.groupId} の画面 ID は同じ十の位`);
      for (const screen of group.screens) {
        assert.ok(screen.route.startsWith(`adv.${group.groupId}.`), `${screen.route} は adv.${group.groupId}.* であること`);
        owners.set(screen.route, [...(owners.get(screen.route) ?? []), group.groupId]);
      }
    }
    for (const route of advancedRoutes) {
      assert.deepEqual(owners.get(route)?.length, 1, `${route} は 1 グループにだけ属する`);
    }
    assert.equal(owners.size, advancedRoutes.length, 'ナビにだけある未定義 route がない');
    const screenIds = advancedNavItems(FULL_PERMISSIONS).map((item) => item.screenId);
    assert.equal(new Set(screenIds).size, screenIds.length, '画面 ID は重複しない');
    // 全 route が Advanced 専用 (Simple では拒否)。
    for (const route of advancedRoutes) {
      assert.equal(resolveRoute('simple', route, FULL_PERMISSIONS).allowed, false, `route ${route} must be Advanced-only`);
    }
  });

  test('送信を伴う画面に egress 表示の根拠がある (§3.1-3)', () => {
    const items = advancedNavItems(FULL_PERMISSIONS);
    const sending = items.filter((item) => item.egress !== 'none').map((item) => item.screenId);
    assert.deepEqual(sending, ['A10', 'A11', 'A22', 'A30', 'A31', 'A32', 'A33', 'A34', 'A35', 'A40', 'A42', 'A52']);
    assert.equal(items.find((item) => item.screenId === 'A35')?.egress, 'live');
    // 送信する画面は run.manage を要求する (送信しない道具と同じ権限に混ぜない)。
    for (const item of items.filter((entry) => entry.egress !== 'none')) {
      assert.equal(ROUTE_PERMISSIONS[item.route], 'run.manage', `${item.screenId} は run.manage`);
    }
  });

  test('UI-UT-013: 権限不足の画面はナビから隠す (case.read のみ)', () => {
    const items = advancedNavItems(['case.read']);
    const enabled = items.filter((item) => item.enabled).map((item) => item.screenId);
    assert.deepEqual(enabled, ['A01', 'A03', 'A20', 'A21', 'A41', 'A50', 'A51', 'A61', 'A70', 'A71']);
    const groups = advancedNavGroups(['case.read']);
    // 画面が残らないグループ (認証・手動検証・設定) は見出しごと隠す。
    assert.deepEqual(
      groups.map((group) => group.groupId),
      ['case', 'recon', 'scan', 'tools', 'results', 'ops'],
    );
    const visible = groups.flatMap((group) => group.items.map((item) => item.screenId));
    assert.deepEqual(visible, enabled);
    assert.ok(groups.every((group) => group.items.every((item) => item.enabled)));
  });

  test('UI-UT-014: 全権限なら全画面有効・既定着地は A01 概要', () => {
    const items = advancedNavItems(FULL_PERMISSIONS);
    assert.ok(items.every((item) => item.enabled));
    assert.equal(advancedNavGroups(FULL_PERMISSIONS).length, 9);
    assert.equal(advancedDefaultRoute(FULL_PERMISSIONS), 'adv.case.overview');
    // case.read がない operator は A01 も開けず、着地先は最初の権限内画面へ後退する。
    assert.equal(advancedDefaultRoute(['finding.confirm']), 'adv.results.findings');
    assert.equal(advancedDefaultRoute([]), undefined);
  });
});

describe('legacy route migration (design/40 §7.3)', () => {
  test('旧 A01〜A13 の route がすべて新 route へ写像される', () => {
    assert.deepEqual(LEGACY_ROUTE_MAP, {
      'advanced.dashboard': 'adv.case.overview',
      'advanced.scope': 'adv.case.scope',
      'advanced.guidelines': 'adv.case.guidelines',
      'browser.site-map': 'adv.recon.site-map',
      'proxy.intercept': 'adv.manual.proxy',
      repeater: 'adv.manual.repeater',
      fuzzer: 'adv.manual.fuzzer',
      'scan-plans': 'adv.scan.active',
      'advanced.sessions': 'adv.auth.login',
      decoder: 'adv.tools.decoder',
      findings: 'adv.results.findings',
      'advanced.jobs': 'adv.ops.jobs',
      settings: 'adv.settings.engines',
    });
    const navRoutes = new Set<string>(advancedNavItems(FULL_PERMISSIONS).map((item) => item.route));
    for (const [legacy, next] of Object.entries(LEGACY_ROUTE_MAP)) {
      assert.equal(normalizeRoute(legacy), next);
      assert.ok(navRoutes.has(next), `${legacy} の写像先 ${next} はナビにある`);
    }
  });

  test('写像は権限を緩めない (旧 route と写像先の必要権限が同じ)', () => {
    const legacyPermissions: Record<string, string> = {
      'advanced.dashboard': 'case.read',
      'advanced.scope': 'case.manage',
      'advanced.guidelines': 'case.read',
      'advanced.sessions': 'run.manage',
      'advanced.jobs': 'case.read',
      'browser.site-map': 'case.read',
      'proxy.intercept': 'run.manage',
      repeater: 'run.manage',
      fuzzer: 'run.manage',
      'scan-plans': 'run.manage',
      decoder: 'case.read',
      findings: 'finding.confirm',
      settings: 'case.manage',
    };
    for (const [legacy, next] of Object.entries(LEGACY_ROUTE_MAP)) {
      assert.equal(ROUTE_PERMISSIONS[next], legacyPermissions[legacy], legacy);
    }
  });

  test('現行 route はそのまま、未知の文字列は undefined', () => {
    assert.equal(normalizeRoute('adv.manual.fuzzer'), 'adv.manual.fuzzer');
    assert.equal(normalizeRoute('wizard.run'), 'wizard.run');
    assert.equal(normalizeRoute('adv.unknown'), undefined);
    assert.equal(normalizeRoute('toString'), undefined);
    assert.equal(normalizeRoute(''), undefined);
  });
});
