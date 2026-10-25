/**
 * ZAP非対応テーマ代替検証 (作業用 Excel「ZAP非対応項目と代替検証手段」) のうち
 * Top10 対象テーマの汎用 plan/judge。テーマ1 (認証回避) は auth-bypass.ts。
 *
 * 実装から除外した困難観点 (Excel 解決案欄の記載どおり):
 * - テーマ5: 大量・高速試験とレート限界の精密測定 (JMeter・負荷領域) → 少数試行の観察のみ
 * - テーマ18: 対象固有ガジェット特定による実害実証 → 応答観察のみ
 * - テーマ20: ミリ秒同期レースの安定検出 → 順次再送による観察のみ
 * - テーマ22: testssl/OpenSSL 相当の独自実装 → nuclei のスポット実行で代替
 *
 * 判定は Excel の「疑わしい挙動/問題なし」列に対応させ、材料が足りなければ
 * inconclusive (未観測を問題なしにしない — design/f17 §5)。
 */
import { domainError } from '@scopepilot2/contracts';
import type { AuthBypassProbeOutcome } from './auth-bypass.ts';

/** 実装済みテーマ (テーマ1を含む。A03 の実行ボタンと同期する)。 */
export const ZAP_UNSUPPORTED_IMPLEMENTED_THEMES = ['1', '2', '3', '4', '5', '7', '10', '11', '13', '18', '20', '21', '22', '23', '29'] as const;
export type ZapUnsupportedThemeNo = (typeof ZAP_UNSUPPORTED_IMPLEMENTED_THEMES)[number];

export interface ThemeCheckProbeResult {
  readonly kind: 'browser' | 'flow' | 'login' | 'http' | 'fuzz' | 'dom' | 'nuclei';
  readonly pattern: string;
  readonly targetUrl: string;
  readonly status: number | null;
  readonly finalUrl: string;
  readonly bodyHash: string;
  readonly outcome: AuthBypassProbeOutcome | null;
  readonly markersFound?: boolean | null;
  /** 追加の非機密情報 (ACAO 値・件数等)。秘密値・応答本文は含めない。 */
  readonly detail?: string;
}

export interface ThemeCheckSummary {
  readonly checkId: string;
  readonly themeNo: string;
  readonly role: string | null;
  readonly status: 'pass' | 'fail' | 'inconclusive';
  readonly totalRequests: number;
  readonly skipped?: readonly string[];
  readonly executedAt: string;
  readonly results: readonly ThemeCheckProbeResult[];
}

/**
 * テーマ全体を完了したと誤解させない集約。未実施観点が残る場合、検出ありは fail のまま、
 * 検出なしは pass ではなく inconclusive とする。
 */
export function summarizeThemeOutcomes(
  outcomes: readonly AuthBypassProbeOutcome[],
  skipped: readonly string[],
): { readonly status: 'pass' | 'fail' | 'inconclusive' } {
  if (outcomes.includes('exposed')) return { status: 'fail' };
  if (outcomes.length === 0 || outcomes.includes('inconclusive') || skipped.length > 0) {
    return { status: 'inconclusive' };
  }
  return { status: 'pass' };
}

export function isImplementedTheme(no: string): no is ZapUnsupportedThemeNo {
  return (ZAP_UNSUPPORTED_IMPLEMENTED_THEMES as readonly string[]).includes(no);
}

export function requireImplementedTheme(no: string): ZapUnsupportedThemeNo {
  if (!isImplementedTheme(no)) {
    throw domainError('ValidationFailed', `zap-unsupported theme ${no} is not implemented (or is excluded as infeasible)`);
  }
  return no;
}

// ---------------------------------------------------------------------------
// 共通 helper
// ---------------------------------------------------------------------------

/** 案件 limits と突き合わせる送信数の上限検査。 */
export function assertRequestBudget(planned: number, maxRequests: number, themeNo: string): void {
  if (planned > maxRequests) {
    throw domainError('ValidationFailed', `theme ${themeNo} check needs ${planned} requests which exceeds the case limit ${maxRequests}`);
  }
}

// ---------------------------------------------------------------------------
// テーマ2: 既定アカウント・既定資格
// ---------------------------------------------------------------------------

export const DEFAULT_CREDENTIAL_PAIRS_MAX = 10;

export interface DefaultCredentialPair {
  readonly username: string;
  readonly password: string;
}

/** 'user:pass' 行 (password 空可) を解析・重複除去・上限検査。辞書攻撃には使わない。 */
export function parseDefaultCredentialPairs(lines: readonly string[]): readonly DefaultCredentialPair[] {
  const pairs: DefaultCredentialPair[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const separator = trimmed.indexOf(':');
    if (separator <= 0) {
      throw domainError('ValidationFailed', `default credential pair must be 'username:password' (got: ${trimmed.slice(0, 40)})`);
    }
    const username = trimmed.slice(0, separator);
    const password = trimmed.slice(separator + 1);
    const key = `${username}\u0000${password}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    pairs.push({ username, password });
    if (pairs.length > DEFAULT_CREDENTIAL_PAIRS_MAX) {
      throw domainError('ValidationFailed', `default credential pairs are capped at ${DEFAULT_CREDENTIAL_PAIRS_MAX} (this is not a brute-force dictionary)`);
    }
  }
  if (pairs.length === 0) {
    throw domainError('NeedsInput', 'theme 2 requires default credential pairs from the product documentation (username:password per line)');
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// テーマ3: パスワードポリシー・保存・表示
// ---------------------------------------------------------------------------

/** Excel の IPA検出パターンを改変せず使用する。 */
export const WEAK_PASSWORD_CANDIDATES = ['', '1234567', 'abcdefg', 'abcd123'] as const;
/** Excel に記載された受理確認用の対照値。一般的な強度基準を意味しない。 */
export const PASSWORD_POLICY_CONTROL = 'Rf@9yY8&wk';

/** パスワードの応答への露出 (表示) 判定。echo は transient に調べた boolean のみ渡す。 */
export function judgePasswordEcho(echoedInResponse: boolean): AuthBypassProbeOutcome {
  return echoedInResponse ? 'exposed' : 'denied';
}

// ---------------------------------------------------------------------------
// テーマ4: パスワードリセット・初期発行
// ---------------------------------------------------------------------------

export const RESET_TOKEN_PATTERNS = ['token-emptied', 'token-forged', 'token-omitted'] as const;
export type ResetTokenPattern = (typeof RESET_TOKEN_PATTERNS)[number];

/** 推測不能な token の代わりに固定の forge 値を使う (対象実装の token は使わない)。 */
export function forgeResetToken(): string {
  return 'forged'.repeat(8);
}

// ---------------------------------------------------------------------------
// テーマ5: ロックアウト・レート制限 (少数試行の観察のみ)
// ---------------------------------------------------------------------------

export const LOCKOUT_MAX_FAILURES = 20;

export function planLockoutSequence(failureCount: number): readonly string[] {
  if (!Number.isInteger(failureCount) || failureCount < 1 || failureCount > LOCKOUT_MAX_FAILURES) {
    throw domainError('ValidationFailed', `lockout observation needs 1..${LOCKOUT_MAX_FAILURES} agreed failure attempts (high-volume rate testing is out of scope)`);
  }
  return Array.from({ length: failureCount }, (_, index) => `wrong-${index + 1}`);
}

/** 連続失敗後の正当 login が成功すれば ロックなし (疑い)。失敗なら問題なし。 */
export function judgeLockout(correctLoginAfterFailures: 'authenticated' | 'rejected' | 'errored'): AuthBypassProbeOutcome {
  if (correctLoginAfterFailures === 'authenticated') {
    return 'exposed';
  }
  if (correctLoginAfterFailures === 'rejected') {
    return 'denied';
  }
  return 'inconclusive';
}

// ---------------------------------------------------------------------------
// テーマ7: ユーザ列挙 (応答差)
// ---------------------------------------------------------------------------

export interface EnumerabilityProbe {
  readonly status: number | null;
  readonly finalUrl: string;
  readonly bodyHash: string;
  readonly averageElapsedMs?: number;
}

/** ログイン画面のCSRF/nonce等の揮発値だけを除き、意味のある応答差を比較する。 */
export function normalizeEnumerationResponse(bodyText: string): string {
  return bodyText
    .replace(/(name\s*=\s*["'](?:csrf|xsrf|nonce|request[_-]?id)["'][^>]*\bvalue\s*=\s*["'])[^"']*/giu, '$1[volatile]')
    .replace(/\b(csrf|xsrf|nonce|request[_-]?id)(["'\s:=_-]+)[A-Za-z0-9+/_=-]{8,}/giu, (_match, name: string, separator: string) => `${name}${separator}[volatile]`)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, '[uuid]')
    .replace(/\b[0-9a-f]{32,}\b/giu, '[hex-token]')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 応答差、または複数回平均の有意な時間差があれば列挙可能性あり。 */
export function judgeUserEnumeration(
  existing: EnumerabilityProbe,
  nonexistent: EnumerabilityProbe,
  timingThresholdMs = 250,
): AuthBypassProbeOutcome {
  const differs = existing.status !== nonexistent.status
    || existing.finalUrl !== nonexistent.finalUrl
    || existing.bodyHash !== nonexistent.bodyHash;
  const timingDiffers = existing.averageElapsedMs !== undefined
    && nonexistent.averageElapsedMs !== undefined
    && Math.abs(existing.averageElapsedMs - nonexistent.averageElapsedMs) >= timingThresholdMs;
  return differs || timingDiffers ? 'exposed' : 'denied';
}

// ---------------------------------------------------------------------------
// テーマ10: 機能・オブジェクト単位の認可 (IDOR)
// ---------------------------------------------------------------------------

/** URL の query parameter を value へ差し替える (未存在なら追加)。 */
export function substituteObjectParam(url: string, param: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(param, value);
  return parsed.toString();
}

export function planIdorProbes(input: {
  readonly targetUrl: string;
  readonly objectParam: string;
  readonly ownValue: string;
  readonly otherValues: readonly string[];
}): readonly { readonly pattern: string; readonly url: string; readonly value: string }[] {
  if (input.objectParam.trim() === '' || input.ownValue === '' || input.otherValues.length === 0 || input.otherValues.length > 3) {
    throw domainError('ValidationFailed', 'theme 10 needs objectParam, ownValue and 1..3 otherValues (representative objects only)');
  }
  return [
    { pattern: 'own-object-baseline', url: substituteObjectParam(input.targetUrl, input.objectParam, input.ownValue), value: input.ownValue },
    ...input.otherValues.flatMap((value) => [
      { pattern: `other-object-authorized:${value}`, url: substituteObjectParam(input.targetUrl, input.objectParam, value), value },
      { pattern: `other-object-candidate:${value}`, url: substituteObjectParam(input.targetUrl, input.objectParam, value), value },
    ]),
  ];
}

/**
 * 他ロールで取得できる対象と候補ロールの応答を比較する。単なる「ログイン済み marker」は
 * オブジェクト閲覧の証拠にならないため使わない。一致しなければ安全とも脆弱とも断定しない。
 */
export function judgeIdorAccess(input: {
  readonly authorized: EnumerabilityProbe;
  readonly candidate: EnumerabilityProbe;
}): AuthBypassProbeOutcome {
  if (input.authorized.status === null || input.authorized.status >= 400) return 'inconclusive';
  if (input.candidate.status === 401 || input.candidate.status === 403) return 'denied';
  if (input.candidate.finalUrl !== input.authorized.finalUrl && input.candidate.status !== input.authorized.status) return 'denied';
  if (input.candidate.status === input.authorized.status && input.candidate.bodyHash === input.authorized.bodyHash) return 'exposed';
  return 'inconclusive';
}

// ---------------------------------------------------------------------------
// テーマ11: フィールド認可・マスアサインメント
// ---------------------------------------------------------------------------

/** base JSON body に extra fields を shallow merge した文字列を作る (純関数)。 */
export function mergeJsonFields(baseBody: string, extraFields: Readonly<Record<string, unknown>>): string {
  const base = JSON.parse(baseBody) as unknown;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    throw domainError('ValidationFailed', 'mass assignment base body must be a JSON object');
  }
  return JSON.stringify({ ...(base as Readonly<Record<string, unknown>>), ...extraFields });
}

export function parseExtraFieldsJson(text: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw domainError('ValidationFailed', 'extraFields must be a non-empty JSON object (e.g. {"role":"admin"})');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

/** 2xx は送信受付に過ぎない。反映 marker が無い限り成立を断定しない。 */
export function judgeMassAssignment(input: {
  readonly variantStatus: number;
  readonly successMarker?: string;
  readonly markerFound?: boolean | null;
}): AuthBypassProbeOutcome {
  if (input.variantStatus >= 400) {
    return 'denied';
  }
  if (input.successMarker === undefined) return 'inconclusive';
  if (input.markerFound == null) {
    return 'inconclusive';
  }
  return input.markerFound ? 'exposed' : 'denied';
}

// ---------------------------------------------------------------------------
// テーマ13: CORS設定
// ---------------------------------------------------------------------------

/**
 * Excel の成立条件どおり、任意の具体的 Origin が反射され、資格情報付き読み取りが
 * ブラウザで成立する構成だけを exposed とする。`*` と credentials の併用は矛盾構成で
 * あり、ブラウザは資格情報付き応答を公開しないため、それ自体を脆弱成立としない。
 */
export function judgeCorsResponse(input: {
  readonly requestOrigin: string;
  readonly acao: string | null;
  readonly acac: string | null;
  readonly credentialsSent: boolean;
}): AuthBypassProbeOutcome {
  if (input.acao === null) {
    return 'denied';
  }
  const credentialsAllowed = (input.acac ?? '').toLowerCase() === 'true';
  if (input.acao === '*') return credentialsAllowed ? 'inconclusive' : 'denied';
  if (input.acao !== input.requestOrigin) return 'denied';
  return input.credentialsSent && credentialsAllowed ? 'exposed' : 'inconclusive';
}

/** プリフライトも要求 Origin と method の双方が許可されるかを確認する。 */
export function judgeCorsPreflight(input: { readonly requestOrigin: string; readonly requestMethod: string; readonly acao: string | null; readonly acaom: string | null }): AuthBypassProbeOutcome {
  if (input.acao === null && input.acaom === null) {
    return 'denied';
  }
  if (input.acao !== input.requestOrigin || input.acaom === null) return 'inconclusive';
  const methods = input.acaom.split(',').map((value) => value.trim().toUpperCase());
  // プリフライト許可だけでは実際の資格情報付き読み取り成立を証明しない。
  return methods.includes(input.requestMethod.toUpperCase()) ? 'inconclusive' : 'denied';
}

// ---------------------------------------------------------------------------
// テーマ18: デシリアライゼーション (応答観察のみ)
// ---------------------------------------------------------------------------

/** 有名な直列化形式の署名 (Java/PHP/.NET/Python/YAML)。実害実証は行わない。 */
export const SERIALIZATION_SIGNATURES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'java-base64', pattern: /(?:rO0|H4sIA)[A-Za-z0-9+/=]*/u },
  { name: 'php-array', pattern: /\ba:\d+:\{/u },
  { name: 'php-object', pattern: /\bO:\d+:"[^"]+":\d+:/u },
  { name: 'dotnet-base64', pattern: /AAEAAAD/u },
  { name: 'python-pickle', pattern: /!!python\/object/u },
];

/** 応答本文 (transient) に直列化署名があれば 疑い (非安全 deserialization の候補)。 */
export function findSerializationSignature(bodyText: string): { readonly name: string; readonly snippet: string } | null {
  for (const signature of SERIALIZATION_SIGNATURES) {
    const match = signature.pattern.exec(bodyText);
    if (match !== null) {
      const start = Math.max(0, match.index - 16);
      // 署名周辺の固定長 snippet のみ (本文の保存にならないよう上限付き)。
      return { name: signature.name, snippet: bodyText.slice(start, Math.min(bodyText.length, match.index + 24)) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// テーマ20: 業務ロジック・競合 (順次再送による観察のみ)
// ---------------------------------------------------------------------------

export const REPLAY_MAX_COUNT = 5;

export function planReplayCount(count: number): number {
  if (!Number.isInteger(count) || count < 2 || count > REPLAY_MAX_COUNT) {
    throw domainError('ValidationFailed', `sequential replay count must be 2..${REPLAY_MAX_COUNT} (synchronized race testing is out of scope)`);
  }
  return count;
}

/** 成功 marker が全再送で成立 = 同一処理の複数回成立 (疑い)。marker 無しで応答が全て同一なら判断保留。 */
export function judgeReplay(input: {
  readonly responses: readonly { readonly status: number; readonly bodyHash: string; readonly markerFound?: boolean | null }[];
  readonly successMarker?: string;
}): AuthBypassProbeOutcome {
  if (input.successMarker !== undefined) {
    const allSucceeded = input.responses.every((response) => response.markerFound === true);
    const noneSucceeded = input.responses.every((response) => response.markerFound === false);
    if (allSucceeded && input.responses.length >= 2) {
      return 'exposed';
    }
    if (noneSucceeded) {
      return 'denied';
    }
    return 'inconclusive';
  }
  const identical = input.responses.every((response) => response.bodyHash === input.responses[0]?.bodyHash && response.status === input.responses[0]?.status);
  return identical ? 'inconclusive' : 'exposed';
}

// ---------------------------------------------------------------------------
// テーマ21: 入力検証の堅牢性
// ---------------------------------------------------------------------------

/** 境界値・型混同・長大文字列 (Excel 手段列のファジング観点)。 */
export const INPUT_ROBUSTNESS_PAYLOADS = [
  '-1',
  '0',
  '2147483648',
  '99999999999999999999',
  '1.5',
  'true',
  'null',
  '',
  // Excel 注意欄は「数百文字程度まで」。過度な負荷を避ける。
  'A'.repeat(512),
] as const;

export const INPUT_ROBUSTNESS_MAX_VALUES = 12;

/** 5xx は堅牢性不足、4xx は安全な拒否。2xx/3xx は業務成立の材料がないため判定保留。 */
export function judgeInputRobustness(status: number): AuthBypassProbeOutcome {
  if (status >= 500) return 'exposed';
  if (status >= 400) return 'denied';
  return 'inconclusive';
}

// ---------------------------------------------------------------------------
// テーマ22: TLS・証明書・暗号スイート (nuclei スポット実行)
// ---------------------------------------------------------------------------

export const NUCLEI_SPOT_TEMPLATE_IDS_MAX = 20;

/** スポット実行は審査済み manifest 内の指定 template に限る (全走査はしない)。 */
export function validateSpotTemplateIds(templateIds: readonly string[]): readonly string[] {
  const unique = [...new Set(templateIds.map((id) => id.trim()).filter((id) => id !== ''))];
  if (unique.length === 0 || unique.length > NUCLEI_SPOT_TEMPLATE_IDS_MAX) {
    throw domainError('ValidationFailed', `theme 22 spot execution requires 1..${NUCLEI_SPOT_TEMPLATE_IDS_MAX} reviewed template ids (vulnerability-specific spot run only)`);
  }
  return unique;
}

/** nuclei JSONL 行のうち parse できた match 行数 (機密でない統計のみ使う)。 */
export function countNucleiMatches(lines: readonly string[]): number {
  return lines.filter((line) => {
    try {
      const parsed = JSON.parse(line) as { readonly 'template-id'?: unknown; readonly 'matched-at'?: unknown };
      return typeof parsed['template-id'] === 'string' && typeof parsed['matched-at'] === 'string';
    } catch {
      return false;
    }
  }).length;
}

/** match が1つでもあれば 疑い。0 なら問題なし (テンプレートの検出範囲内で)。 */
export function judgeNucleiSpot(matchCount: number): AuthBypassProbeOutcome {
  return matchCount > 0 ? 'exposed' : 'denied';
}

// ---------------------------------------------------------------------------
// テーマ23: 平文送信・混在
// ---------------------------------------------------------------------------

/** 平文 (http://) で同一 resource が取得できれば 疑い。拒否・redirect なら問題なし。 */
export function judgePlainHttp(input: { readonly status: number; readonly finalUrl: string; readonly targetUrl: string }): AuthBypassProbeOutcome {
  if (input.status >= 400) {
    return 'denied';
  }
  if (input.finalUrl !== input.targetUrl) {
    return 'denied';
  }
  return 'exposed';
}

const MIXED_CONTENT_PATTERN = /(?:\bsrc|\baction|\bposter)\s*=\s*["']http:\/\//iu;

/** https 页面の body (transient) に http:// 参照があれば混在 (疑い)。 */
export function findMixedContent(bodyText: string): boolean {
  return MIXED_CONTENT_PATTERN.test(bodyText);
}

// ---------------------------------------------------------------------------
// テーマ29: データ保護・機微露出
// ---------------------------------------------------------------------------

const SENSITIVE_QUERY_NAME = /(?:pass(?:word)?|secret|token|session|sid|auth|api[_-]?key|credit|card|pin|mynumber|individualnumber)/iu;

/** URL値は返さず、機微疑いの query parameter 名だけを返す。 */
export function findSensitiveUrlParamNames(url: string): readonly string[] {
  const parsed = new URL(url);
  return [...new Set([...parsed.searchParams.keys()].filter((name) => SENSITIVE_QUERY_NAME.test(name)))];
}

/** 機微画面のキャッシュ抑止。Excel の明示基準 `Cache-Control: no-store` を採用する。 */
export function judgeSensitiveCache(cacheControl: string | null): AuthBypassProbeOutcome {
  if (cacheControl === null) return 'exposed';
  return cacheControl.split(',').map((value) => value.trim().toLowerCase()).includes('no-store') ? 'denied' : 'exposed';
}

/**
 * PII候補の存在だけでは、本人に対する正当な表示と漏えいを区別できない。カード番号・PIN・
 * マイナンバー等の「マスク必須」パターンが平文確認された場合だけ exposed とし、それ以外の
 * PII候補は人によるデータ所有者・最小化の確認が必要なため inconclusive とする。
 */
export function judgePiiExposure(piiNodeCount: number, confirmedUnmaskedSensitiveCount = 0): AuthBypassProbeOutcome {
  if (confirmedUnmaskedSensitiveCount > 0) return 'exposed';
  return piiNodeCount > 0 ? 'inconclusive' : 'denied';
}
