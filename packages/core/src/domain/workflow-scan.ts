/**
 * 探索で観測した HTTP 候補を対象にする汎用診断。
 *
 * 対象製品の画面名や URL 構成を仮定せず、確認済み URL、HTTP method、入力点だけを
 * 使用する。ScopePilot 自身が送る通信は transport の origin 固定と共有 request budget
 * の内側で実行し、元の request body を安全に再構築できない候補は理由付きでスキップする。
 */
import { createHash } from 'node:crypto';
import { domainError, type RequestInputPoint } from '@scopepilot2/contracts';
import {
  WORKFLOW_PAYLOAD_CATALOG,
  WORKFLOW_PAYLOAD_CATALOG_REFERENCE,
  payloadById,
  renderPayload,
} from '@scopepilot2/payloads';

export const WORKFLOW_SCAN_PAYLOAD_SET = WORKFLOW_PAYLOAD_CATALOG_REFERENCE;
export const WORKFLOW_SCAN_DEFAULT_MAX_REQUESTS = 2000;
export const WORKFLOW_SCAN_RESTORE_ATTEMPTS = 0;

export interface WorkflowScanFormPart {
  readonly fieldName: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly fields: Readonly<Record<string, string>>;
}

export interface WorkflowScanRequestSpec {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly form?: Readonly<Record<string, string>>;
  readonly json?: string;
  readonly multipart?: WorkflowScanFormPart;
}

export interface WorkflowScanHttpResponse {
  readonly status: number;
  readonly body: string;
  readonly location: string;
  readonly contentType: string;
  readonly contentSecurityPolicy: string;
  readonly setCookies: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly setCookieHeaders?: readonly string[];
}

export interface WorkflowScanRequestLogEntry {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly location: string;
  readonly requestPreview: string;
  readonly responsePreview: string;
}

export interface WorkflowScanTransport {
  readonly baseUrl: string;
  readonly requestCount: number;
  request(spec: WorkflowScanRequestSpec): Promise<WorkflowScanHttpResponse>;
  takeRequestLog(): WorkflowScanRequestLogEntry[];
}

export const WORKFLOW_SCAN_SEVERITIES = ['high', 'medium', 'low', 'info'] as const;
export type WorkflowScanSeverity = (typeof WORKFLOW_SCAN_SEVERITIES)[number];

export interface WorkflowScanCheckResult {
  readonly checkId: string;
  readonly title: string;
  readonly category: string;
  readonly severity: WorkflowScanSeverity;
  readonly cwe: string;
  readonly securityLevel: string;
  readonly url: string;
  readonly method: string;
  readonly param: string;
  readonly description: string;
  readonly evidence: string;
  readonly remediation: string;
  readonly limitations: string;
}

export interface WorkflowScanSkipNote {
  readonly checkId: string;
  readonly securityLevel: string;
  readonly note: string;
}

export interface WorkflowScanTarget {
  readonly url: string;
  readonly method: string;
  readonly inputPoints?: readonly RequestInputPoint[];
  readonly contentType?: string;
}

export interface WorkflowScanRunResult {
  readonly baseUrl: string;
  readonly authenticated: boolean;
  readonly originalSecurityLevel: string;
  readonly testedSecurityLevels: readonly string[];
  readonly requestCount: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly payloadSet: string;
  readonly checks: readonly WorkflowScanCheckResult[];
  readonly skips: readonly WorkflowScanSkipNote[];
  readonly requestLog: readonly WorkflowScanRequestLogEntry[];
}

export interface WorkflowScanOptions {
  readonly baseUrl: string;
  readonly targets: readonly WorkflowScanTarget[];
  readonly authenticated?: boolean;
  readonly maxRequests?: number;
  readonly checkIds?: readonly WorkflowScanCheckId[];
  readonly signal?: AbortSignal;
}

import { WORKFLOW_SCAN_CHECK_IDS } from './guideline-assertions.ts';
export { WORKFLOW_SCAN_CHECK_IDS } from './guideline-assertions.ts';

export type WorkflowScanCheckId = (typeof WORKFLOW_SCAN_CHECK_IDS)[number];

const DS221_CHECKS: readonly WorkflowScanCheckId[] = [
  'security-headers',
  'cookie-security',
  'cors-policy',
  'error-disclosure',
  'open-redirect',
  'path-traversal',
];

export function resolveWorkflowScanCheckIds(guidelines: readonly string[]): readonly WorkflowScanCheckId[] {
  if (guidelines.length === 0) return WORKFLOW_SCAN_CHECK_IDS;
  const selected = new Set<WorkflowScanCheckId>();
  for (const guideline of guidelines) {
    const checks = guideline.includes('DS-221') ? DS221_CHECKS : WORKFLOW_SCAN_CHECK_IDS;
    for (const check of checks) selected.add(check);
  }
  return WORKFLOW_SCAN_CHECK_IDS.filter((check) => selected.has(check));
}

export interface WorkflowScanHooks {
  readonly progress?: (message: string) => void;
}

const SQL_ERROR_PATTERN = /(?:sql syntax|syntax error.*sql|unterminated quoted string|unclosed quotation mark|sqlite[_ ]error|postgresql.*error|mysql(?:i)?[_ ](?:query|error)|ora-\d{4,5}|jdbc(?:sql)?exception)/i;
const ERROR_DISCLOSURE_PATTERN = /(?:stack trace|traceback \(most recent call last\)|fatal error:|uncaught (?:exception|error)|\bat [\w.$]+\([^\n]+:\d+\)|\/var\/www\/|[a-z]:\\[^\r\n]+\.\w+:\d+)/i;
const REDIRECT_PARAMETER_PATTERN = /(?:^|[_-])(?:url|uri|redirect|redirect_uri|return|return_to|returnurl|next|continue|destination|dest|callback)(?:$|[_-])/i;
const PATH_PARAMETER_PATTERN = /(?:^|[_-])(?:file|filename|path|page|template|include|document|folder|dir|download)(?:$|[_-])/i;
const SENSITIVE_INPUT_PATTERN = /pass|secret|token|csrf|captcha|otp|code|session|cookie/i;
const TEST_ORIGIN = 'https://scopepilot-check.invalid';

function reviewedPayload(id: string, variables: Readonly<Record<string, string | number>> = {}): string {
  return renderPayload(payloadById(WORKFLOW_PAYLOAD_CATALOG, id), variables);
}

interface CheckState {
  readonly transport: WorkflowScanTransport;
  readonly enabled: ReadonlySet<WorkflowScanCheckId>;
  readonly results: WorkflowScanCheckResult[];
  readonly skips: WorkflowScanSkipNote[];
  readonly progress: (message: string) => void;
  readonly signal: AbortSignal | undefined;
  readonly maxRequests: number;
  readonly marker: string;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw domainError('Cancelled', 'HTTP diagnostic scan aborted');
}

function canonicalTarget(baseUrl: string, value: string): URL {
  const target = new URL(value, `${baseUrl.replace(/\/$/, '')}/`);
  if (target.origin !== new URL(baseUrl).origin) {
    throw domainError('OutOfScope', `HTTP diagnostic target is outside the transport origin: ${target.origin}`);
  }
  target.hash = '';
  return target;
}

function requestPath(url: URL): string {
  return `${url.pathname}${url.search}`;
}

async function request(state: CheckState, spec: WorkflowScanRequestSpec): Promise<WorkflowScanHttpResponse> {
  throwIfAborted(state.signal);
  if (state.transport.requestCount >= state.maxRequests) {
    throw domainError('OutOfScope', `HTTP diagnostic request limit reached (${String(state.maxRequests)})`);
  }
  return state.transport.request(spec);
}

function header(response: WorkflowScanHttpResponse, name: string): string {
  const key = name.toLowerCase();
  return response.headers?.[key] ?? (key === 'content-security-policy' ? response.contentSecurityPolicy : '');
}

function finding(
  state: CheckState,
  input: Omit<WorkflowScanCheckResult, 'securityLevel' | 'limitations'> & { readonly limitations?: string },
): void {
  state.results.push({ ...input, securityLevel: '', limitations: input.limitations ?? '' });
  state.progress(`検出: ${input.title}`);
}

function skip(state: CheckState, checkId: WorkflowScanCheckId, url: string, note: string): void {
  state.skips.push({ checkId, securityLevel: '', note: `${url}: ${note}` });
}

function mutatedUrl(target: URL, name: string, value: string): URL {
  const changed = new URL(target);
  changed.searchParams.set(name, value);
  return changed;
}

function queryInputs(target: URL, points: readonly RequestInputPoint[]): readonly RequestInputPoint[] {
  const byName = new Map<string, RequestInputPoint>();
  for (const name of target.searchParams.keys()) byName.set(name, { name, location: 'query', type: 'string' });
  for (const point of points) if (point.location === 'query') byName.set(point.name, point);
  return [...byName.values()].filter((point) => point.name.trim() !== '').slice(0, 10);
}

function checkSecurityHeaders(state: CheckState, target: URL, response: WorkflowScanHttpResponse): void {
  // Error documents frequently come from a different framework/proxy path than the
  // requested application resource. Reporting their missing browser headers creates
  // one finding for every dead SPA route and says nothing about the live page.
  if (!state.enabled.has('security-headers') || response.status >= 400 || !/text\/html/i.test(response.contentType)) return;
  const missing: string[] = [];
  const csp = header(response, 'content-security-policy');
  if (csp === '') missing.push('Content-Security-Policy');
  if (header(response, 'x-content-type-options').toLowerCase() !== 'nosniff') missing.push('X-Content-Type-Options: nosniff');
  if (header(response, 'x-frame-options') === '' && !/frame-ancestors/i.test(csp)) missing.push('frame protection');
  if (header(response, 'referrer-policy') === '') missing.push('Referrer-Policy');
  if (target.protocol === 'https:' && header(response, 'strict-transport-security') === '') missing.push('Strict-Transport-Security');
  if (missing.length === 0) return;
  finding(state, {
    checkId: 'security-headers', title: 'ブラウザー向けセキュリティヘッダーの不足', category: 'セキュリティ設定', severity: 'low', cwe: '693',
    url: target.toString(), method: 'GET', param: '',
    description: `HTML応答で推奨ヘッダーが不足しています: ${missing.join(', ')}`,
    evidence: `GET ${requestPath(target)} → HTTP ${String(response.status)}。不足: ${missing.join(', ')}`,
    remediation: 'CSP、nosniff、frame制御、Referrer-Policy、およびHTTPSではHSTSを用途に合わせて設定してください。',
    limitations: 'ヘッダーの不足だけを根拠に攻撃成立とは判定していません。',
  });
}

function checkCookies(state: CheckState, target: URL, response: WorkflowScanHttpResponse): void {
  if (!state.enabled.has('cookie-security')) return;
  const cookies = response.setCookieHeaders ?? response.setCookies;
  for (const raw of cookies) {
    const name = raw.split('=', 1)[0]?.trim() ?? '';
    if (name === '') continue;
    const missing = [
      ...(!/;\s*httponly(?:;|$)/i.test(raw) ? ['HttpOnly'] : []),
      ...(!/;\s*samesite=(?:lax|strict|none)(?:;|$)/i.test(raw) ? ['SameSite'] : []),
      ...(target.protocol === 'https:' && !/;\s*secure(?:;|$)/i.test(raw) ? ['Secure'] : []),
    ];
    if (missing.length === 0) continue;
    finding(state, {
      checkId: 'cookie-security', title: `Cookie属性の不足 (${name})`, category: 'セッション管理', severity: 'medium', cwe: '614',
      url: target.toString(), method: 'GET', param: name,
      description: `応答Cookie ${name} に ${missing.join(', ')} 属性がありません。`,
      evidence: `GET ${requestPath(target)} の Set-Cookie ${name} で不足属性 ${missing.join(', ')} を確認。値は証跡へ保存していません。`,
      remediation: '用途に応じてHttpOnly、Secure、SameSiteを付与し、DomainとPathも必要最小限にしてください。',
    });
  }
}

async function checkCors(state: CheckState, target: URL): Promise<void> {
  if (!state.enabled.has('cors-policy')) return;
  const response = await request(state, { method: 'GET', path: requestPath(target), headers: { origin: TEST_ORIGIN } });
  const allowOrigin = header(response, 'access-control-allow-origin');
  const credentials = header(response, 'access-control-allow-credentials').toLowerCase() === 'true';
  // `*` と credentials の組合せはブラウザーが拒否するため、攻撃成立として扱わない。
  if (allowOrigin !== TEST_ORIGIN) return;
  finding(state, {
    checkId: 'cors-policy', title: '信頼されていないOriginを許可するCORS設定', category: 'アクセス制御', severity: credentials ? 'high' : 'medium', cwe: '942',
    url: target.toString(), method: 'GET', param: 'Origin',
    description: `外部Originへの応答でAccess-Control-Allow-Origin: ${allowOrigin}${credentials ? ' と資格情報許可' : ''}を確認しました。`,
    evidence: `Origin: ${TEST_ORIGIN} を付けたGET ${requestPath(target)} → ACAO=${allowOrigin}, ACAC=${credentials ? 'true' : 'false'}`,
    remediation: '許可Originを固定allowlistで照合し、資格情報を許可する応答ではワイルドカードや入力Originの無条件反射を避けてください。',
  });
}

function checkPassiveBody(state: CheckState, target: URL, response: WorkflowScanHttpResponse): void {
  if (state.enabled.has('error-disclosure') && ERROR_DISCLOSURE_PATTERN.test(response.body)) {
    finding(state, {
      checkId: 'error-disclosure', title: '内部エラー情報の応答露出', category: 'エラー処理', severity: 'medium', cwe: '209',
      url: target.toString(), method: 'GET', param: '',
      description: 'HTTP応答にスタックトレース、内部パス、または未処理例外を示す文字列が含まれています。',
      evidence: `GET ${requestPath(target)} → HTTP ${String(response.status)} で内部エラーを示す既知パターンに一致。`,
      remediation: '利用者向け応答から例外詳細と内部パスを除き、詳細はアクセス制御されたサーバーログへ記録してください。',
    });
  }
  if (state.enabled.has('dom-source-sink')) {
    const sink = findDomSink(extractInlineScripts(response.body));
    if (sink !== undefined) finding(state, {
      checkId: 'dom-source-sink', title: 'URL由来データから危険なDOM操作への経路', category: 'クライアント側入力処理', severity: 'medium', cwe: '79',
      url: target.toString(), method: 'GET', param: '',
      description: '同じインラインスクリプトでURL由来の値とHTML実行につながるDOM sinkを確認しました。',
      evidence: `GET ${requestPath(target)} のスクリプトで source と sink を確認: ${sink}`,
      remediation: 'URL由来値をinnerHTML、document.write、eval等へ渡さず、textContentなど文脈安全なAPIを使用してください。',
      limitations: '静的なsource/sink同居の確認であり、ブラウザー上の実行成立は別途DOM観測で確認します。',
    });
  }
}

async function checkInput(state: CheckState, target: URL, point: RequestInputPoint, baseline: WorkflowScanHttpResponse): Promise<void> {
  const name = point.name;
  if (SENSITIVE_INPUT_PATTERN.test(name)) {
    for (const checkId of ['reflected-input', 'sql-error', 'open-redirect', 'path-traversal'] as const) {
      if (state.enabled.has(checkId)) skip(state, checkId, target.toString(), `秘密値または制御値と推定した入力点 ${name} は自動変異しません`);
    }
    return;
  }
  if (state.enabled.has('reflected-input')) {
    const value = reviewedPayload('xss.reflection.marker', { marker: state.marker });
    const probe = mutatedUrl(target, name, value);
    const response = await request(state, { method: 'GET', path: requestPath(probe) });
    if (response.body.includes(value) && !baseline.body.includes(value)) finding(state, {
      checkId: 'reflected-input', title: '入力値が無変換でHTML応答へ反射', category: '入力処理', severity: 'medium', cwe: '79',
      url: probe.toString(), method: 'GET', param: name,
      description: `query parameter ${name} へ送ったHTMLメタ文字を含むマーカーが応答本文へそのまま反射されました。`,
      evidence: `GET ${requestPath(probe)} の応答に送信マーカーを完全一致で確認。`,
      remediation: '出力文脈に合ったエンコードを行い、必要に応じて厳格な入力検証とCSPを併用してください。',
      limitations: '反射を確認した段階であり、JavaScript実行の成立はブラウザー観測で別途確認します。',
    });
  }
  if (state.enabled.has('sql-error')) {
    const probe = mutatedUrl(target, name, reviewedPayload('sqli.error.single-quote'));
    const response = await request(state, { method: 'GET', path: requestPath(probe) });
    if (SQL_ERROR_PATTERN.test(response.body) && !SQL_ERROR_PATTERN.test(baseline.body)) finding(state, {
      checkId: 'sql-error', title: '入力変異によるSQLエラー情報の露出', category: 'インジェクション', severity: 'high', cwe: '89',
      url: probe.toString(), method: 'GET', param: name,
      description: `query parameter ${name} へ引用符を送った応答で、基準応答にないSQLエラーパターンを確認しました。`,
      evidence: `GET ${requestPath(probe)} → HTTP ${String(response.status)}。基準応答との差分でSQLエラーを確認。`,
      remediation: 'SQLを文字列連結せず、型付きparameter bindingを使用し、DB例外を利用者へ返さないでください。',
    });
  }
  if (state.enabled.has('open-redirect') && REDIRECT_PARAMETER_PATTERN.test(name)) {
    const destination = reviewedPayload('redirect.external-origin.marker', { marker: state.marker });
    const probe = mutatedUrl(target, name, destination);
    const response = await request(state, { method: 'GET', path: requestPath(probe) });
    let location: URL | undefined;
    try {
      location = response.location === '' ? undefined : new URL(response.location, target);
    } catch {
      location = undefined;
    }
    if (location?.origin === TEST_ORIGIN) finding(state, {
      checkId: 'open-redirect', title: '外部Originへのオープンリダイレクト', category: 'リダイレクト', severity: 'medium', cwe: '601',
      url: probe.toString(), method: 'GET', param: name,
      description: `query parameter ${name} に指定した外部OriginがLocationへ採用されました。`,
      evidence: `GET ${requestPath(probe)} → HTTP ${String(response.status)}, Location origin=${location.origin}`,
      remediation: '遷移先を相対パスまたは固定allowlistへ制限し、URLをそのままLocationへ反映しないでください。',
    });
  }
  if (state.enabled.has('path-traversal') && PATH_PARAMETER_PATTERN.test(name)) {
    const value = reviewedPayload('path.posix.passwd');
    const probe = mutatedUrl(target, name, value);
    const response = await request(state, { method: 'GET', path: requestPath(probe) });
    if (/root:x:0:0:|\[extensions\][\s\S]*\.dll/i.test(response.body)) finding(state, {
      checkId: 'path-traversal', title: 'パストラバーサルによるローカルファイル読取り', category: 'ファイルアクセス', severity: 'high', cwe: '22',
      url: probe.toString(), method: 'GET', param: name,
      description: `query parameter ${name} の相対パス入力に対し、OSローカルファイルの既知内容が応答しました。`,
      evidence: `GET ${requestPath(probe)} の応答でOSファイルの既知シグネチャを確認。`,
      remediation: '利用者入力をファイルパスへ直接連結せず、固定識別子から許可済みファイルへ解決し、正規化後の基準ディレクトリ逸脱を拒否してください。',
    });
  }
}

export async function runWorkflowScan(options: WorkflowScanOptions, transport: WorkflowScanTransport, hooks: WorkflowScanHooks = {}): Promise<WorkflowScanRunResult> {
  const startedAt = new Date().toISOString();
  const progress = hooks.progress ?? ((): void => undefined);
  const maxRequests = options.maxRequests ?? WORKFLOW_SCAN_DEFAULT_MAX_REQUESTS;
  const enabled = new Set(options.checkIds === undefined || options.checkIds.length === 0 ? WORKFLOW_SCAN_CHECK_IDS : options.checkIds);
  const results: WorkflowScanCheckResult[] = [];
  const skips: WorkflowScanSkipNote[] = [];
  const state: CheckState = {
    transport, enabled, results, skips, progress, signal: options.signal, maxRequests,
    marker: `sp${createHash('sha256').update(`${startedAt}:${Math.random()}`).digest('hex').slice(0, 12)}`,
  };
  const seen = new Set<string>();
  for (const input of options.targets) {
    throwIfAborted(options.signal);
    const target = canonicalTarget(options.baseUrl, input.url);
    const method = input.method.toUpperCase();
    const key = `${method} ${target.toString()} ${(input.inputPoints ?? []).map((point) => `${point.location}:${point.name}`).sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (method !== 'GET') {
      for (const checkId of enabled) skip(state, checkId, target.toString(), `${method} requestの元本文値を保存していないため、安全な自動再構築を行いません`);
      continue;
    }
    progress(`汎用HTTP診断: ${target.toString()}`);
    const baseline = await request(state, { method: 'GET', path: requestPath(target) });
    checkPassiveBody(state, target, baseline);
    if (baseline.status >= 400) {
      // Keep error-disclosure observation above, but do not mutate or classify an
      // unavailable endpoint as though it were an application page. The skip notes
      // remain in evidence so coverage cannot be mistaken for a clean result.
      for (const checkId of enabled) {
        if (checkId !== 'error-disclosure') {
          skip(state, checkId, target.toString(), `基準応答が HTTP ${String(baseline.status)} のため、有効な対象として診断しません`);
        }
      }
      continue;
    }
    checkSecurityHeaders(state, target, baseline);
    checkCookies(state, target, baseline);
    await checkCors(state, target);
    for (const point of queryInputs(target, input.inputPoints ?? [])) await checkInput(state, target, point, baseline);
  }
  return {
    baseUrl: options.baseUrl,
    authenticated: options.authenticated === true,
    originalSecurityLevel: '',
    testedSecurityLevels: [],
    requestCount: transport.requestCount,
    startedAt,
    endedAt: new Date().toISOString(),
    payloadSet: WORKFLOW_SCAN_PAYLOAD_SET,
    checks: results,
    skips,
    requestLog: transport.takeRequestLog(),
  };
}

export function md5Hex(value: string): string { return createHash('md5').update(value, 'ascii').digest('hex'); }
export function sha256Hex(value: string): string { return createHash('sha256').update(value, 'ascii').digest('hex'); }
export function rot13(value: string): string {
  return value.replace(/[a-zA-Z]/g, (character) => {
    const base = character <= 'Z' ? 65 : 97;
    return String.fromCharCode(((character.charCodeAt(0) - base + 13) % 26) + base);
  });
}
export function xorBytes(value: Uint8Array, key: Uint8Array): Uint8Array {
  const output = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) output[index] = value[index]! ^ key[index % key.length]!;
  return output;
}
export function detectRepeatingKey(keyStream: Uint8Array): Uint8Array | undefined {
  for (let period = 3; period <= 32 && period <= Math.floor(keyStream.length / 2); period += 1) {
    if (keyStream.slice(period).every((value, index) => value === keyStream[index % period])
      && keyStream.slice(0, period).every((value) => value >= 0x20 && value < 0x7f)) return keyStream.slice(0, period);
  }
  return undefined;
}
export function findDomSink(script: string): string | undefined {
  const sourcePattern = /location\.(?:href|search|hash)|document\.(?:URL|documentURI)|decodeURI(?:Component)?\(/;
  const sinkPattern = /document\.write(?:ln)?|\.innerHTML|\.insertAdjacentHTML|eval\(|setTimeout\(\s*['\"]/;
  if (!sourcePattern.test(script) || !sinkPattern.test(script)) return undefined;
  const line = script.split('\n').find((candidate) => sinkPattern.test(candidate))?.trim();
  return line === undefined ? undefined : line.slice(0, 160);
}
export function extractInlineScripts(html: string): string {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1] ?? '').join('\n');
}
export function parseExternalScriptOrigins(csp: string): string[] {
  const scriptSrc = csp.split(';').map((directive) => directive.trim()).find((directive) => directive.toLowerCase().startsWith('script-src')) ?? '';
  return scriptSrc.split(/\s+/).filter((token) => token.includes('://') || (!token.startsWith("'") && token.includes('.'))).filter((token) => !token.toLowerCase().startsWith('scopepilot'));
}
export function clientSideTokenCandidates(phrase: string): [string, string, string] {
  const medium = `XX${phrase}XX`.split('').reverse().join('');
  const inner = `XX${phrase.split('').reverse().join('')}`;
  return [md5Hex(rot13(phrase)), medium, sha256Hex(`${sha256Hex(inner)}ZZ`)];
}
export function tryGetHost(location: string): string | undefined {
  try { return new URL(location.startsWith('//') ? `https:${location}` : location).host || undefined; } catch { return undefined; }
}
export function analyzeSessionPattern(values: readonly string[]): { name: string; detail: string } | undefined {
  if (values.length === 0) return undefined;
  if (values.every((value) => /^\d+$/.test(value))) {
    const numbers = values.map(Number);
    const diffs = numbers.slice(1).map((number, index) => number - numbers[index]!);
    if (diffs.length > 0 && diffs.every((difference) => difference === 1)) return { name: '単純連番', detail: `連続する整数 ${numbers[0]}…${numbers.at(-1)}` };
    const now = Math.floor(Date.now() / 1000);
    if (numbers.every((number) => Math.abs(number - now) < 3600)) return { name: '現在時刻', detail: '値が現在時刻（Unix秒）に近接' };
  }
  for (let number = 0; number <= 5000; number += 1) {
    const hash = md5Hex(String(number));
    if (values.includes(hash)) return { name: `連番のMD5（${String(number)}）`, detail: `値 ${hash} が整数のMD5と一致` };
  }
  return undefined;
}
