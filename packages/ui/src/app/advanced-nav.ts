/**
 * Advanced モードの画面ナビゲーション (A01〜A13)。`docs/detailed-design/02-ui-information-architecture.md` §3。
 * 並び・構成は設計の A01〜A13 と一致させ、権限不足の画面はナビから隠す
 * (mode-policy の route 判定と同じ根拠。見た目だけ隠して command は出る、にしない)。
 */
import { resolveRoute, type UiRoute } from './mode-policy.ts';
import type { OperatorPermission } from '@scopepilot2/contracts';

export interface AdvancedNavItem {
  /** 設計文書の画面番号 (A01〜A13)。 */
  readonly screenId: string;
  readonly route: UiRoute;
  readonly label: string;
  /** 権限が足りない画面は表示・選択とも不可。 */
  readonly enabled: boolean;
}

interface AdvancedScreen {
  readonly screenId: string;
  readonly route: UiRoute;
  readonly label: string;
}

const ADVANCED_SCREENS: readonly AdvancedScreen[] = [
  { screenId: 'A01', route: 'advanced.dashboard', label: 'Dashboard / Case' },
  { screenId: 'A02', route: 'advanced.scope', label: 'Scope & Authorization' },
  { screenId: 'A03', route: 'advanced.guidelines', label: 'Guidelines & Check Catalog' },
  { screenId: 'A04', route: 'browser.site-map', label: 'Browser / Site map / HTTP history' },
  { screenId: 'A05', route: 'proxy.intercept', label: 'Proxy / Intercept' },
  { screenId: 'A06', route: 'repeater', label: 'Repeater' },
  { screenId: 'A07', route: 'fuzzer', label: 'Fuzzer' },
  { screenId: 'A08', route: 'scan-plans', label: 'Scan plans' },
  { screenId: 'A09', route: 'advanced.sessions', label: 'Sessions / Roles / Business logic' },
  { screenId: 'A10', route: 'decoder', label: 'Decoder / Comparer / Sequencer' },
  { screenId: 'A50', route: 'adv.tools.decoder', label: 'Decoder' },
  { screenId: 'A51', route: 'adv.tools.comparer', label: 'Comparer' },
  { screenId: 'A11', route: 'findings', label: 'Findings / Organizer / Report' },
  { screenId: 'A12', route: 'advanced.jobs', label: 'Jobs / Evidence / Audit' },
  { screenId: 'A13', route: 'settings', label: 'Settings / Certificates / Engines / AI' },
];

/** 権限に応じた A01〜A13 のナビ一覧。順序は設計どおり A01→A13。 */
export function advancedNavItems(permissions: readonly OperatorPermission[]): readonly AdvancedNavItem[] {
  return ADVANCED_SCREENS.map((screen) => ({
    ...screen,
    enabled: resolveRoute('advanced', screen.route, permissions).allowed,
  }));
}

/** Advanced 起動時の着地先。権限内の最初の画面 (通常 A01)。全画面不可なら undefined。 */
export function advancedDefaultRoute(permissions: readonly OperatorPermission[]): UiRoute | undefined {
  return advancedNavItems(permissions).find((item) => item.enabled)?.route;
}
