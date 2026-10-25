/**
 * ZAP非対応テーマ1「認証回避・強制ブラウジング」の代替検証 (作業用 Excel
 * 「ZAP非対応項目と代替検証手段」No.1、IPA手順「認証回避」相当)。
 * 事前に把握した認証用 cookie だけを書き換える。全 cookie の無差別削除はしない。
 */
import { domainError } from '@scopepilot2/contracts';
import type { LoginSessionCookie } from '../ports/engines.ts';

/** IPA手順 ②: 認証済み代表リクエストの認証用 cookie 書き換え (空値・削除) と ④: 未認証での直接アクセス。 */
export const AUTH_BYPASS_PAGE_PATTERNS = ['session-baseline', 'auth-cookie-emptied', 'auth-cookie-removed', 'no-session'] as const;
export type AuthBypassPagePattern = (typeof AUTH_BYPASS_PAGE_PATTERNS)[number];

/** IPA手順 ③: ログイン要求の password 書き換え (空値・削除・1文字追加)。 */
export const AUTH_BYPASS_LOGIN_PATTERNS = ['password-emptied', 'password-omitted', 'password-plus-one-char'] as const;
export type AuthBypassLoginPattern = (typeof AUTH_BYPASS_LOGIN_PATTERNS)[number];

/** 代表リクエストは少数で足りる (Excel「少数試行」・安全制御)。超過分は実行しない。 */
export const AUTH_BYPASS_MAX_TARGETS = 5;

export interface AuthBypassPlan {
  readonly targetUrls: readonly string[];
  readonly pagePatterns: readonly AuthBypassPagePattern[];
  readonly loginPatterns: readonly AuthBypassLoginPattern[];
  readonly totalRequests: number;
}

/** probe 数の上限は案件 limits (maxRequests) と突き合わせる素材を返す。 */
export function planAuthBypassCheck(input: {
  readonly targetUrls: readonly string[];
  readonly includeLoginVariants: boolean;
}): AuthBypassPlan {
  const unique = [...new Set(input.targetUrls.map((url) => url.trim()).filter((url) => url !== ''))];
  if (unique.length === 0) {
    throw domainError('ValidationFailed', 'auth bypass check needs at least one authenticated target URL');
  }
  if (unique.length > AUTH_BYPASS_MAX_TARGETS) {
    throw domainError('ValidationFailed', `auth bypass check accepts at most ${AUTH_BYPASS_MAX_TARGETS} representative target URLs (got ${unique.length})`);
  }
  const loginPatterns = input.includeLoginVariants ? [...AUTH_BYPASS_LOGIN_PATTERNS] : [];
  return {
    targetUrls: unique,
    pagePatterns: [...AUTH_BYPASS_PAGE_PATTERNS],
    loginPatterns,
    totalRequests: unique.length * AUTH_BYPASS_PAGE_PATTERNS.length + loginPatterns.length,
  };
}

/**
 * pattern に応じた送信 cookie。書き換え・削除の対象は事前に把握した認証用
 * cookie 名 (authCookieNames) だけに限る (Excel 注意欄)。no-session は未認証
 * セッションとして cookie を一切渡さない (強制ブラウジング ④)。
 */
export function sessionCookiesForPattern(
  cookies: readonly LoginSessionCookie[],
  pattern: AuthBypassPagePattern,
  authCookieNames: ReadonlySet<string>,
): readonly LoginSessionCookie[] | undefined {
  if (pattern === 'no-session') {
    return undefined;
  }
  if (pattern === 'auth-cookie-emptied') {
    return cookies.map((cookie) => (authCookieNames.has(cookie.name) ? { ...cookie, value: '' } : cookie));
  }
  if (pattern === 'auth-cookie-removed') {
    return cookies.filter((cookie) => !authCookieNames.has(cookie.name));
  }
  return cookies;
}

/** password-plus-one-char で一時的に使う派生値。監査・応答へ出さない (メモリ上のみ)。 */
export function derivePasswordVariant(pattern: AuthBypassLoginPattern, passwordValue: string): string {
  if (pattern === 'password-emptied') {
    return '';
  }
  if (pattern === 'password-plus-one-char') {
    return `${passwordValue}A`;
  }
  throw domainError('ValidationFailed', `login pattern ${pattern} does not derive a password value`);
}

export type AuthBypassProbeOutcome = 'exposed' | 'denied' | 'inconclusive';

/**
 * ページ観測の判定 (Excel: 認証後の情報が出力される=疑い / アクセスできない=問題なし)。
 * marker が設定されているのに baseline に現れない場合は判定材料不足で inconclusive
 * (未観測を問題なしにしない — design/f17 §5)。
 */
export function judgePageProbe(input: {
  readonly markers: readonly string[];
  readonly baseline: { readonly status: number | null; readonly bodyHash: string; readonly markersFound: boolean };
  readonly variant: { readonly status: number | null; readonly finalUrl: string; readonly targetUrl: string; readonly bodyHash: string; readonly markersFound: boolean };
}): AuthBypassProbeOutcome {
  if (input.markers.length > 0 && !input.baseline.markersFound) {
    return 'inconclusive';
  }
  if (input.variant.markersFound) {
    return 'exposed';
  }
  if (input.variant.bodyHash === input.baseline.bodyHash && input.variant.status === input.baseline.status) {
    return 'exposed';
  }
  if (input.variant.status === 401 || input.variant.status === 403) {
    return 'denied';
  }
  if (input.variant.finalUrl !== input.variant.targetUrl) {
    return 'denied';
  }
  if (input.markers.length > 0) {
    return 'denied';
  }
  return 'inconclusive';
}

/** ログイン変種の判定 (Excel: 認証が成功する=疑い / 認証に失敗する=問題なし)。 */
export function judgeLoginVariant(authenticated: boolean): AuthBypassProbeOutcome {
  return authenticated ? 'exposed' : 'denied';
}

/** 全体結果: 1つでも exposed なら fail、inconclusive が残れば inconclusive、それ以外は pass。 */
export function summarizeAuthBypassOutcomes(outcomes: readonly AuthBypassProbeOutcome[]): { readonly status: 'pass' | 'fail' | 'inconclusive' } {
  if (outcomes.length === 0) {
    return { status: 'inconclusive' };
  }
  if (outcomes.includes('exposed')) {
    return { status: 'fail' };
  }
  if (outcomes.includes('inconclusive')) {
    return { status: 'inconclusive' };
  }
  return { status: 'pass' };
}

/** 1 probe の観測。markersFound は marker 未設定 (null) と不在 (false) を区別する。 */
export interface AuthBypassProbeResult {
  readonly kind: 'page' | 'login';
  readonly pattern: AuthBypassPagePattern | AuthBypassLoginPattern;
  readonly targetUrl: string;
  readonly status: number | null;
  readonly finalUrl: string;
  readonly bodyHash: string;
  readonly outcome: AuthBypassProbeOutcome | null;
  readonly markersFound: boolean | null;
}

export interface AuthBypassCheckSummary {
  readonly checkId: string;
  readonly themeNo: string;
  readonly role: string;
  readonly status: 'pass' | 'fail' | 'inconclusive';
  readonly totalRequests: number;
  readonly loginVariantsNotRun: readonly string[];
  readonly executedAt: string;
  readonly results: readonly AuthBypassProbeResult[];
}

/** 実行履歴の list item (結果の詳細は checkId の evidence で参照)。 */
export interface AuthBypassCheckListItem {
  readonly checkId: string;
  readonly themeNo: string;
  readonly role: string;
  readonly status: string;
  readonly totalRequests: number;
  readonly loginVariantsNotRun: readonly string[];
  readonly executedAt: string;
}

export interface AuthBypassCheckRecord extends AuthBypassCheckListItem {
  readonly status: 'pass' | 'fail' | 'inconclusive';
}
