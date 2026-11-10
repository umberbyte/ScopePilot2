/**
 * Advanced モードの画面ナビゲーション。`docs/design/40-advanced-mode-redesign.md` §3.2・§3.3。
 * 利用者の目的で 9 グループに分け、画面 ID の十の位をグループに割り当てる (A01〜A94)。
 * 権限不足の画面はナビから隠す (mode-policy の route 判定と同じ根拠。見た目だけ隠して command は出る、にしない)。
 */
import { resolveRoute, type AdvancedRoute } from './mode-policy.ts';
import type { OperatorPermission } from '@scopepilot2/contracts';

export type AdvancedNavGroupId = 'case' | 'auth' | 'recon' | 'manual' | 'scan' | 'tools' | 'results' | 'ops' | 'settings';

/** `main` は上から順に並べる本体、`footer` はナビ下端 (設定) に置く。 */
export type AdvancedNavPlacement = 'main' | 'footer';

/** 対象へ通信を送るか。`live` は live 観測時のみ送信 (A35 DOM 調査)。 */
export type AdvancedNavEgress = 'none' | 'sends' | 'live';

export interface AdvancedNavItem {
  /** 設計文書の画面番号 (A01〜A94)。 */
  readonly screenId: string;
  readonly route: AdvancedRoute;
  readonly label: string;
  readonly groupId: AdvancedNavGroupId;
  /** ナビの「⇅」表示の根拠 (§3.1-3)。 */
  readonly egress: AdvancedNavEgress;
  /** 権限が足りない画面は表示・選択とも不可。 */
  readonly enabled: boolean;
}

export interface AdvancedNavGroup {
  readonly groupId: AdvancedNavGroupId;
  readonly label: string;
  readonly placement: AdvancedNavPlacement;
  /** 権限内の画面のみ。空のグループは返さない。 */
  readonly items: readonly AdvancedNavItem[];
}

interface AdvancedScreen {
  readonly screenId: string;
  readonly route: AdvancedRoute;
  readonly label: string;
  readonly egress: AdvancedNavEgress;
}

export interface AdvancedGroupDefinition {
  readonly groupId: AdvancedNavGroupId;
  readonly label: string;
  readonly placement: AdvancedNavPlacement;
  readonly screens: readonly AdvancedScreen[];
}

export const ADVANCED_NAV_GROUPS: readonly AdvancedGroupDefinition[] = [
  {
    groupId: 'case',
    label: '案件',
    placement: 'main',
    screens: [
      { screenId: 'A01', route: 'adv.case.overview', label: '概要', egress: 'none' },
      { screenId: 'A02', route: 'adv.case.scope', label: 'スコープ・認可', egress: 'none' },
      { screenId: 'A03', route: 'adv.case.guidelines', label: 'ガイドライン・カバレッジ', egress: 'none' },
    ],
  },
  {
    groupId: 'auth',
    label: '認証・セッション',
    placement: 'main',
    screens: [
      { screenId: 'A10', route: 'adv.auth.login', label: 'ロール・ログイン', egress: 'sends' },
      { screenId: 'A11', route: 'adv.auth.session', label: 'セッション', egress: 'sends' },
    ],
  },
  {
    groupId: 'recon',
    label: '偵察・探索',
    placement: 'main',
    screens: [
      { screenId: 'A20', route: 'adv.recon.site-map', label: 'サイトマップ', egress: 'none' },
      { screenId: 'A21', route: 'adv.recon.history', label: 'HTTP 履歴', egress: 'none' },
      { screenId: 'A22', route: 'adv.recon.crawl', label: 'クロール', egress: 'sends' },
      { screenId: 'A23', route: 'adv.recon.api', label: 'API 定義', egress: 'none' },
      { screenId: 'A24', route: 'adv.recon.hints', label: '文書ヒント', egress: 'none' },
    ],
  },
  {
    groupId: 'manual',
    label: '手動検証',
    placement: 'main',
    screens: [
      { screenId: 'A30', route: 'adv.manual.proxy', label: 'Proxy・Intercept', egress: 'sends' },
      { screenId: 'A31', route: 'adv.manual.repeater', label: 'Repeater', egress: 'sends' },
      { screenId: 'A32', route: 'adv.manual.fuzzer', label: 'Fuzzer', egress: 'sends' },
      { screenId: 'A33', route: 'adv.manual.websocket', label: 'WebSocket', egress: 'sends' },
      { screenId: 'A34', route: 'adv.manual.oast', label: 'OAST', egress: 'sends' },
      { screenId: 'A35', route: 'adv.manual.dom', label: 'DOM 調査', egress: 'live' },
    ],
  },
  {
    groupId: 'scan',
    label: '自動診断',
    placement: 'main',
    screens: [
      { screenId: 'A40', route: 'adv.scan.active', label: '能動診断', egress: 'sends' },
      { screenId: 'A41', route: 'adv.scan.passive', label: '受動診断', egress: 'none' },
      { screenId: 'A42', route: 'adv.scan.templates', label: '個別検証（テンプレート）', egress: 'sends' },
      { screenId: 'A43', route: 'adv.scan.policies', label: '診断ポリシー', egress: 'none' },
    ],
  },
  {
    groupId: 'tools',
    label: '解析ツール',
    placement: 'main',
    screens: [
      { screenId: 'A50', route: 'adv.tools.decoder', label: 'Decoder', egress: 'none' },
      { screenId: 'A51', route: 'adv.tools.comparer', label: 'Comparer', egress: 'none' },
      { screenId: 'A52', route: 'adv.tools.sequencer', label: 'Sequencer', egress: 'sends' },
    ],
  },
  {
    groupId: 'results',
    label: '結果・報告',
    placement: 'main',
    screens: [
      { screenId: 'A60', route: 'adv.results.findings', label: '所見', egress: 'none' },
      { screenId: 'A61', route: 'adv.results.evidence', label: '証拠', egress: 'none' },
      { screenId: 'A62', route: 'adv.results.report', label: '報告', egress: 'none' },
    ],
  },
  {
    groupId: 'ops',
    label: '実行管理',
    placement: 'main',
    screens: [
      { screenId: 'A70', route: 'adv.ops.jobs', label: 'ジョブ', egress: 'none' },
      { screenId: 'A71', route: 'adv.ops.audit', label: '監査ログ', egress: 'none' },
    ],
  },
  {
    groupId: 'settings',
    label: '設定',
    placement: 'footer',
    screens: [
      { screenId: 'A90', route: 'adv.settings.engines', label: 'エンジン・ランタイム', egress: 'none' },
      { screenId: 'A91', route: 'adv.settings.certificates', label: '証明書', egress: 'none' },
      { screenId: 'A92', route: 'adv.settings.library', label: 'ライブラリ', egress: 'none' },
      { screenId: 'A93', route: 'adv.settings.extensions', label: '拡張', egress: 'none' },
      { screenId: 'A94', route: 'adv.settings.ai', label: 'AI 支援', egress: 'none' },
    ],
  },
];

/** 権限に応じた全画面のナビ一覧 (平坦、設計順)。権限外は enabled=false。 */
export function advancedNavItems(permissions: readonly OperatorPermission[]): readonly AdvancedNavItem[] {
  return ADVANCED_NAV_GROUPS.flatMap((group) =>
    group.screens.map((screen) => ({
      ...screen,
      groupId: group.groupId,
      enabled: resolveRoute('advanced', screen.route, permissions).allowed,
    })),
  );
}

/** 表示用のグループ別ナビ。権限外の画面は含めず、画面が 1 つも残らないグループも隠す。 */
export function advancedNavGroups(permissions: readonly OperatorPermission[]): readonly AdvancedNavGroup[] {
  const items = advancedNavItems(permissions);
  return ADVANCED_NAV_GROUPS.map((group) => ({
    groupId: group.groupId,
    label: group.label,
    placement: group.placement,
    items: items.filter((item) => item.groupId === group.groupId && item.enabled),
  })).filter((group) => group.items.length > 0);
}

/** Advanced 起動時の着地先。権限内の最初の画面 (通常 A01)。全画面不可なら undefined。 */
export function advancedDefaultRoute(permissions: readonly OperatorPermission[]): AdvancedRoute | undefined {
  return advancedNavItems(permissions).find((item) => item.enabled)?.route;
}
