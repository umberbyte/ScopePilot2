/**
 * UI モードと操作可能 route の規則。`docs/detailed-design/02-ui-information-architecture.md` §2〜§3。
 * モードは表示と編集範囲だけを変え、権限・認可・scope・上限を緩めない。
 * 非公開機能は見た目だけ隠すのではなく、API 側の権限でも拒否する前提で command 生成も行わない。
 */
import type { OperatorPermission } from '@scopepilot2/contracts';

export type UiMode = 'simple' | 'advanced';

export type UiRoute =
  | 'wizard.case-open'
  | 'wizard.guideline'
  | 'wizard.explore'
  | 'wizard.target-select'
  | 'wizard.final-confirm'
  | 'wizard.run'
  | 'wizard.report'
  | 'browser.site-map'
  | 'proxy.intercept'
  | 'repeater'
  | 'fuzzer'
  | 'scan-plans'
  | 'decoder'
  | 'findings'
  | 'settings';

const SIMPLE_ROUTES: ReadonlySet<UiRoute> = new Set<UiRoute>([
  'wizard.case-open',
  'wizard.guideline',
  'wizard.explore',
  'wizard.target-select',
  'wizard.final-confirm',
  'wizard.run',
  'wizard.report',
]);

const ROUTE_PERMISSIONS: Readonly<Record<UiRoute, OperatorPermission>> = {
  'wizard.case-open': 'case.read',
  'wizard.guideline': 'case.read',
  'wizard.explore': 'run.manage',
  'wizard.target-select': 'run.manage',
  'wizard.final-confirm': 'run.manage',
  'wizard.run': 'run.manage',
  'wizard.report': 'report.export',
  'browser.site-map': 'case.read',
  'proxy.intercept': 'run.manage',
  repeater: 'run.manage',
  fuzzer: 'run.manage',
  'scan-plans': 'run.manage',
  decoder: 'case.read',
  findings: 'finding.confirm',
  settings: 'case.manage',
};

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
