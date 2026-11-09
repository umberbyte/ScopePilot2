/**
 * UI モードと操作可能 route の規則。`docs/detailed-design/02-ui-information-architecture.md` §2〜§3、
 * Advanced の route 体系は `docs/design/40-advanced-mode-redesign.md` §3.2・§7.3。
 * モードは表示と編集範囲だけを変え、権限・認可・scope・上限を緩めない。
 * 非公開機能は見た目だけ隠すのではなく、API 側の権限でも拒否する前提で command 生成も行わない。
 */
import type { OperatorPermission } from '@scopepilot2/contracts';

export type UiMode = 'simple' | 'advanced';

export type SimpleRoute =
  | 'wizard.case-open'
  | 'wizard.guideline'
  | 'wizard.explore'
  | 'wizard.target-select'
  | 'wizard.final-confirm'
  | 'wizard.run'
  | 'wizard.report';

/** Advanced の route ID は `adv.<group>.<feature>` (design/40 §3.2)。 */
export type AdvancedRoute =
  // 案件
  | 'adv.case.overview'
  | 'adv.case.scope'
  | 'adv.case.guidelines'
  // 認証・セッション
  | 'adv.auth.login'
  | 'adv.auth.session'
  // 偵察・探索
  | 'adv.recon.site-map'
  | 'adv.recon.history'
  | 'adv.recon.crawl'
  | 'adv.recon.api'
  | 'adv.recon.hints'
  // 手動検証
  | 'adv.manual.proxy'
  | 'adv.manual.repeater'
  | 'adv.manual.fuzzer'
  | 'adv.manual.websocket'
  | 'adv.manual.oast'
  | 'adv.manual.dom'
  // 自動診断
  | 'adv.scan.active'
  | 'adv.scan.passive'
  | 'adv.scan.templates'
  | 'adv.scan.policies'
  // 解析ツール
  | 'adv.tools.decoder'
  | 'adv.tools.comparer'
  | 'adv.tools.sequencer'
  // 結果・報告
  | 'adv.results.findings'
  | 'adv.results.evidence'
  | 'adv.results.report'
  // 実行管理
  | 'adv.ops.jobs'
  | 'adv.ops.audit'
  // 設定
  | 'adv.settings.engines'
  | 'adv.settings.certificates'
  | 'adv.settings.library'
  | 'adv.settings.extensions'
  | 'adv.settings.ai';

export type UiRoute = SimpleRoute | AdvancedRoute;

/** 再編前 (A01〜A13) の Advanced route。保存済み UI 状態・外部参照の写像専用で、ナビには出さない。 */
export type LegacyAdvancedRoute =
  | 'advanced.dashboard'
  | 'advanced.scope'
  | 'advanced.guidelines'
  | 'advanced.sessions'
  | 'advanced.jobs'
  | 'browser.site-map'
  | 'proxy.intercept'
  | 'repeater'
  | 'fuzzer'
  | 'scan-plans'
  | 'decoder'
  | 'findings'
  | 'settings';

/** 旧 route → 新 route (design/40 §7.3)。 */
export const LEGACY_ROUTE_MAP: Readonly<Record<LegacyAdvancedRoute, AdvancedRoute>> = {
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
};

const SIMPLE_ROUTES: ReadonlySet<UiRoute> = new Set<UiRoute>([
  'wizard.case-open',
  'wizard.guideline',
  'wizard.explore',
  'wizard.target-select',
  'wizard.final-confirm',
  'wizard.run',
  'wizard.report',
]);

/** 画面ごとの必要権限 (design/40 §3.2 の「権限」列)。 */
export const ROUTE_PERMISSIONS: Readonly<Record<UiRoute, OperatorPermission>> = {
  'wizard.case-open': 'case.read',
  'wizard.guideline': 'case.read',
  'wizard.explore': 'run.manage',
  'wizard.target-select': 'run.manage',
  'wizard.final-confirm': 'run.manage',
  'wizard.run': 'run.manage',
  'wizard.report': 'report.export',
  'adv.case.overview': 'case.read',
  'adv.case.scope': 'case.manage',
  'adv.case.guidelines': 'case.read',
  'adv.auth.login': 'run.manage',
  'adv.auth.session': 'run.manage',
  'adv.recon.site-map': 'case.read',
  'adv.recon.history': 'case.read',
  'adv.recon.crawl': 'run.manage',
  'adv.recon.api': 'run.manage',
  'adv.recon.hints': 'case.manage',
  'adv.manual.proxy': 'run.manage',
  'adv.manual.repeater': 'run.manage',
  'adv.manual.fuzzer': 'run.manage',
  'adv.manual.websocket': 'run.manage',
  'adv.manual.oast': 'run.manage',
  'adv.manual.dom': 'run.manage',
  'adv.scan.active': 'run.manage',
  'adv.scan.passive': 'case.read',
  'adv.scan.templates': 'run.manage',
  'adv.scan.policies': 'case.manage',
  'adv.tools.decoder': 'case.read',
  'adv.tools.comparer': 'case.read',
  'adv.tools.sequencer': 'run.manage',
  'adv.results.findings': 'finding.confirm',
  'adv.results.evidence': 'case.read',
  'adv.results.report': 'report.export',
  'adv.ops.jobs': 'case.read',
  'adv.ops.audit': 'case.read',
  'adv.settings.engines': 'case.manage',
  'adv.settings.certificates': 'case.manage',
  'adv.settings.library': 'case.manage',
  'adv.settings.extensions': 'case.manage',
  'adv.settings.ai': 'case.manage',
};

function isKnownRoute(value: string): value is UiRoute {
  return Object.hasOwn(ROUTE_PERMISSIONS, value);
}

/**
 * 保存済み UI 状態・外部参照の route 文字列を現行 route へ正規化する (design/40 §7.3)。
 * 旧 route は新 route へ写像し、未知の文字列は undefined (呼出側で既定画面へ)。
 */
export function normalizeRoute(value: string): UiRoute | undefined {
  if (Object.hasOwn(LEGACY_ROUTE_MAP, value)) {
    return LEGACY_ROUTE_MAP[value as LegacyAdvancedRoute];
  }
  return isKnownRoute(value) ? value : undefined;
}

export interface RouteDecision {
  readonly allowed: boolean;
  /** 拒否時の代替先 (Simple の非公開 route は wizard へ戻す)。 */
  readonly fallback?: UiRoute;
  readonly reason?: string;
}

/** Simple で raw 編集系 route を要求したら拒否して wizard に戻す (UI-UT-001)。 */
export function resolveRoute(mode: UiMode, route: UiRoute, permissions: readonly OperatorPermission[]): RouteDecision {
  if (mode === 'simple' && !SIMPLE_ROUTES.has(route)) {
    return { allowed: false, fallback: 'wizard.guideline', reason: `route ${route} is not available in Simple mode` };
  }
  const required = ROUTE_PERMISSIONS[route];
  if (!permissions.includes(required)) {
    // Advanced でも権限不足なら操作を隠し、API 用 command も生成しない (UI-UT-002)。
    return { allowed: false, reason: `operator lacks permission ${required} for route ${route}` };
  }
  return { allowed: true };
}

/** command 生成可否は route 判定と同じ根拠から出す (隠すだけで止めないための二重確認)。 */
export function mayBuildCommand(mode: UiMode, route: UiRoute, permissions: readonly OperatorPermission[]): boolean {
  return resolveRoute(mode, route, permissions).allowed;
}
