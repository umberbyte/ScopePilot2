import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const catalog = JSON.parse(readFileSync(join(root, 'docs/generated/guideline-catalog.json'), 'utf8'));
const outputPath = join(root, 'docs/guideline-conformance-evidence.html');

const TARGETS = [
  { name: 'OWASP Top 10-2025', short: 'OWASP Top 10', keep: (row) => ![16, 18, 28, 40, 41, 42, 43].includes(Number(row.no)) },
  {
    name: 'OWASP ASVS 5.0',
    short: 'OWASP ASVS 5.0',
    keep: (row) =>
      !/(資料|文書)/.test(row.checkItem + ' ' + row.method) &&
      !row.itemId.startsWith('11.') &&
      !row.itemId.startsWith('12.') &&
      row.itemId !== '16.2.5',
  },
  { name: 'OWASP WSTG 4.2', short: 'OWASP WSTG 4.2', keep: (row) => ![1, 4, 10, 11, 20, 71].includes(Number(row.no)) },
  {
    name: 'デジタル庁 DS-221',
    short: 'デジタル庁 DS-221',
    keep: (row) => Number(row.no) <= 23 || [25, 27, 29].includes(Number(row.no)),
  },
  { name: 'WebAppPentestGuidelines v1.2', short: 'WebAppPentestGuidelines', keep: () => true },
];

const IMPLEMENTED_THEMES = new Set(['1', '2', '3', '4', '5', '6', '7', '9', '10', '11', '13', '14', '15', '16', '18', '20', '21', '22', '23', '24', '25', '26', '27', '29', '30']);
const AUTO_THEME_WORKFLOWS = new Map([
  ['8', ['weak-session', 792]],
  ['12', ['csrf-password', 586]],
  ['19', ['file-upload', 638]],
  ['28', ['xss-dom', 922]],
]);

const WORKFLOW_PATTERNS = [
  ['sqli-verify', /SQL.*インジェクション|SQLi/i, 1645],
  ['api-command-injection', /コマンドインジェクション|OSコマンド/i, 1580],
  ['xss-reflected', /反射型XSS|クロスサイトスクリプティング.*反射/i, 841],
  ['xss-stored', /蓄積型XSS|格納型XSS|クロスサイトスクリプティング.*蓄積/i, 882],
  ['xss-dom', /DOM.*XSS|DOM-based XSS/i, 922],
  ['file-upload', /アップロード|ZIP|書庫|ファイル種別|zip slip/i, 638],
  ['brute-force', /総当たり|試行制御|ロックアウト|レート制限/i, 540],
  ['csrf-password', /CSRF/i, 586],
  ['weak-session', /セッション.*(強度|固定|推測|再発行|失効|タイムアウト)|弱いセッション/i, 792],
  ['authorization-bypass', /認可回避|権限昇格|強制ブラウジング|機能単位の認可/i, 1080],
  ['bac-open-access', /IDOR|オブジェクト.*認可|横の権限/i, 1130],
  ['open-redirect', /オープンリダイレクト|外部.*リダイレクト/i, 1165],
  ['crypto-xor', /XOR/i, 1196],
  ['crypto-ecb', /ECB/i, 1254],
  ['crypto-cbc-oracle', /パディングオラクル|CBC/i, 1339],
  ['api-legacy', /旧API|legacy API/i, 1480],
  ['api-mass-assignment', /マスアサインメント|フィールド.*認可/i, 1533],
  ['lfi', /LFI|トラバーサル|ローカルファイル/i, 1713],
];

const ZAP_PATTERNS = [
  ['sql-injection', /SQL.*インジェクション|SQLi/i, '40018/40019/40020/40021/40022/40027/40028'],
  ['command-injection', /コマンドインジェクション|OSコマンド/i, '90020/90037'],
  ['xss', /XSS|クロスサイトスクリプティング/i, '40012/40014'],
  ['path-traversal', /トラバーサル|LFI|ファイル取り込み/i, '6'],
  ['open-redirect', /リダイレクト/i, '20019/10028'],
  ['xxe', /XXE|外部実体/i, '90023'],
  ['ssti', /SSTI|テンプレート.*インジェクション/i, '90035/90036'],
  ['crlf', /CRLF|応答分割/i, '40003'],
  ['padding-oracle', /パディングオラクル/i, '90024'],
  ['directory-listing', /ディレクトリ.*(一覧|リスティング|ブラウジング)/i, '0/10033'],
  ['csrf-passive', /CSRF/i, '10202'],
  ['cookie', /Cookie|クッキー/i, '10010/10011/10054/90033'],
  ['csp', /CSP|Content-Security-Policy/i, '10038/10055'],
  ['cors', /CORS|クロスドメイン/i, '10098'],
  ['hsts', /HSTS|Strict-Transport-Security/i, '10035'],
  ['sri', /SRI|Subresource Integrity/i, '90003'],
  ['error-disclosure', /エラー|スタックトレース|例外/i, '10023/90022'],
  ['information-disclosure', /情報漏えい|情報露出|機微.*露出|バナー|デバッグ/i, '10009/10023/10024/10027/10036/10037'],
  ['http-method', /HTTPメソッド|TRACE|TRACK|動詞改ざん|許可メソッド/i, 'manual-theme-25'],
  ['security-header', /セキュリティヘッダ|X-Content-Type|Referrer-Policy|frame-ancestors|クリックジャッキング/i, '10020/10021'],
];

/** 原本の行座標に対してレビュー済みの個別実行経路を固定する。曖昧な全文検索だけに依存しない。 */
const HTTP_ROUTE_OVERRIDES = new Map([
  ['OWASP Top 10-2025:33', ['workflow:brute-force', 'zap-unsupported:5']],
  ['OWASP Top 10-2025:38', ['zap-unsupported:6']],
  ['OWASP Top 10-2025:49', ['zap-unsupported:21']],
  ['OWASP ASVS 5.0:5', ['workflow:xss-reflected', 'workflow:xss-stored', 'workflow:xss-dom']],
  ['OWASP ASVS 5.0:6', ['workflow:xss-reflected', 'workflow:xss-stored', 'workflow:xss-dom']],
  ['OWASP ASVS 5.0:8', ['workflow:xss-dom']],
  ['OWASP ASVS 5.0:12', ['zap-unsupported:15']],
  ['OWASP ASVS 5.0:16', ['workflow:xss-stored', 'workflow:xss-dom']],
  ['OWASP ASVS 5.0:20', ['zap-unsupported:15', 'workflow:xss-dom']],
  ['OWASP ASVS 5.0:25', ['zap-unsupported:15']],
  ['OWASP ASVS 5.0:42', ['zap-unsupported:20']],
  ['OWASP ASVS 5.0:69', ['zap-unsupported:30']],
  ['OWASP ASVS 5.0:70', ['zap-unsupported:29']],
  ['OWASP ASVS 5.0:78', ['zap-unsupported:30']],
  ['OWASP ASVS 5.0:87', ['zap-unsupported:21']],
  ['OWASP ASVS 5.0:124', ['zap-unsupported:6']],
  ['OWASP ASVS 5.0:135', ['zap-unsupported:4']],
  ['OWASP ASVS 5.0:185', ['workflow:authorization-bypass', 'zap-unsupported:10']],
  ['OWASP ASVS 5.0:197', ['skip:target-specific-oauth-scope-baseline']],
  ['OWASP ASVS 5.0:279', ['zap-unsupported:30']],
  ['OWASP WSTG 4.2:5', ['zap-unsupported:30']],
  ['OWASP WSTG 4.2:12', ['zap-unsupported:30']],
  ['OWASP WSTG 4.2:27', ['zap-unsupported:10']],
  ['OWASP WSTG 4.2:47', ['zap-unsupported:29']],
  ['OWASP WSTG 4.2:60', ['zap-unsupported:15']],
  ['OWASP WSTG 4.2:61', ['zap-unsupported:15']],
  ['OWASP WSTG 4.2:65', ['zap-unsupported:15']],
  ['OWASP WSTG 4.2:84', ['zap-unsupported:20']],
  ['OWASP WSTG 4.2:89', ['workflow:xss-reflected', 'workflow:xss-stored', 'workflow:xss-dom']],
  ['デジタル庁 DS-221:10', ['zap-unsupported:15', 'workflow:sqli-verify', 'workflow:api-command-injection']],
  ['デジタル庁 DS-221:17', ['zap-unsupported:21']],
]);

const WAPG_FAMILIES = [
  [1, 6, 'SQLインジェクション', '入力値を変更し、真偽・エラー・時間差を基準応答と比較する', 'DB解釈を示す再現可能な差分', '入力をデータとして処理し差分が成立しない'],
  [7, 14, 'コマンド／コードインジェクション', '無害な真偽ペアまたは時間差プローブを送信して応答を比較する', 'コマンド評価と整合する出力または時間差', '評価されず通常の入力検証で拒否される'],
  [15, 17, 'HTTPヘッダ・メールヘッダ注入', '制御文字を含む値を送信し、応答ヘッダまたは許可済み受信fixtureを確認する', '追加ヘッダ・宛先等が生成される', '制御文字が拒否または無害化される'],
  [18, 24, 'XSS', '反射・保存・DOMの各文脈へ目印入力を送り、応答およびブラウザ実行を確認する', '入力が実行可能な文脈へ未処理で到達する', '文脈別にエンコードまたは除去される'],
  [25, 28, 'クライアントサイド注入', 'HTTP応答から生成されたDOMとブラウザ動作を、制御した入力で比較する', '危険なDOM・URL・メッセージ処理が成立する', '入力が検証され危険なsinkへ到達しない'],
  [29, 35, 'パストラバーサル／LFI', 'パス入力へ上位移動表現を送り、基準応答と本文指紋を比較する', '許可外ファイルの内容または存在差が返る', '許可ディレクトリ外は拒否される'],
  [36, 46, 'ファイル処理', '拡張子・内容・サイズ・保存名を変えたファイルを送信して取得・実行可否を確認する', '危険形式の受理、実行、領域外書込みが成立する', '形式、保存先、配信方法が強制される'],
  [47, 52, 'XML／XXE', '外部実体または構文差を含むXMLを許可済みendpointへ送信する', '外部参照、内部ファイル、構文由来の差が観測される', '外部実体が無効で安全に拒否される'],
  [53, 55, 'オープンリダイレクト', '転送先パラメータを外部originへ変更しLocationと最終URLを確認する', '任意外部originへ転送される', '許可先だけに限定される'],
  [56, 61, 'SSRF・デシリアライズ等', 'URLまたは直列化入力を変更し、隔離oracleと応答差を確認する', '内部到達または改変オブジェクトの処理が成立する', '宛先・型・完全性検証で拒否される'],
  [62, 67, 'ブラウザ保護・認証入口', '応答ヘッダ、未認証要求、既定資格の少数試行を確認する', '保護ヘッダ欠如または未認証到達が成立する', 'ブラウザ保護と認証拒否が一貫する'],
  [68, 75, '認証・パスワード', '失敗回数、設定値、リセットフローを少数の許可済み要求で確認する', '弱い資格・回避・列挙が再現する', '強度、試行制御、本人確認がHTTP応答で確認できる'],
  [76, 84, 'セッション・認可・CSRF', '複数セッションと変更要求を再送し、ID更新・権限・Origin検証を比較する', '旧ID、他者ID、トークンなし要求が受理される', 'セッションと認可が要求ごとに強制される'],
  [85, 97, '情報露出・データ保護', 'URL、ヘッダ、本文、キャッシュ指示を収集し機微情報の露出を確認する', '機微情報または内部情報が不要に返る', '最小限の情報と安全なキャッシュ制御になる'],
  [98, 102, '公開面・既知脆弱性', '公開URL、不要ファイル、技術指紋を収集し、版固定されたルールへ照合する', '不要面の公開または既知脆弱版の指紋が一致する', '公開面が限定され既知の該当がない'],
];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const sourceFileLines = new Map();
const sourcePopupRegistry = new Map();

function sourceLine(path, marker, fallback = 1) {
  let lines = sourceFileLines.get(path);
  if (lines === undefined) {
    lines = readFileSync(join(root, path), 'utf8').split(/\r?\n/);
    sourceFileLines.set(path, lines);
  }
  const index = lines.findIndex((line) => line.includes(marker));
  return index < 0 ? fallback : index + 1;
}

function numberedSourceLine(source, line) {
  const clean = source.replace(/[ \t]+$/u, '');
  return String(line).padStart(4) + (clean === '' ? '' : '  ' + clean);
}

function sourcePopupButton(path, line, title, start = Math.max(1, line - 6), end = line + 12, label = '実装を表示') {
  let lines = sourceFileLines.get(path);
  if (lines === undefined) {
    lines = readFileSync(join(root, path), 'utf8').split(/\r?\n/);
    sourceFileLines.set(path, lines);
  }
  const safeStart = Math.max(1, start);
  const safeEnd = Math.min(lines.length, end);
  const id = 'source-' + slug(path + '-' + line + '-' + safeStart + '-' + safeEnd);
  if (!sourcePopupRegistry.has(id)) {
    const excerpt = lines.slice(safeStart - 1, safeEnd)
      .map((source, index) => numberedSourceLine(source, safeStart + index))
      .join('\n');
    sourcePopupRegistry.set(id, { id, path, line, title, start: safeStart, end: safeEnd, excerpt });
  }
  return '<button type="button" class="source-ref" data-source-ref="' + esc(id) + '">' +
    '<span>' + esc(label) + '</span><small>' + esc(path + ':' + line) + '</small></button>';
}

/** 呼出し・登録行ではなく、実際の送信と判定を含む関数/case block全体を参照する。 */
function sourceBlock(path, marker, title, options = {}) {
  let lines = sourceFileLines.get(path);
  if (lines === undefined) {
    lines = readFileSync(join(root, path), 'utf8').split(/\r?\n/);
    sourceFileLines.set(path, lines);
  }
  const line = sourceLine(path, marker, options.fallback ?? 1);
  const bodyMarker = options.bodyMarker ?? marker;
  const bodyLine = sourceLine(path, bodyMarker, line);
  const bodyText = lines[bodyLine - 1] ?? '';
  const openingColumn = bodyText.lastIndexOf('{');
  if (openingColumn < 0) {
    return { path, line, start: Math.max(1, line - 4), end: Math.min(lines.length, line + 24), title, label: options.label ?? '送信・判定を表示' };
  }
  let depth = 0;
  let end = bodyLine;
  let opened = false;
  outer: for (let index = bodyLine - 1; index < lines.length; index += 1) {
    const text = lines[index] ?? '';
    const from = index === bodyLine - 1 ? openingColumn : 0;
    for (let column = from; column < text.length; column += 1) {
      if (text[column] === '{') {
        depth += 1;
        opened = true;
      } else if (text[column] === '}') {
        depth -= 1;
        if (opened && depth === 0) {
          end = index + 1;
          break outer;
        }
      }
    }
  }
  return {
    path,
    line,
    start: Math.max(1, line - 2),
    end,
    title,
    label: options.label ?? '送信・判定を表示',
  };
}

function renderSourcePopupTemplates() {
  return [...sourcePopupRegistry.values()].map((source) =>
    '<template id="' + esc(source.id) + '"><article class="popup-source"><h3>' + esc(source.title) +
    '</h3><p><code>' + esc(source.path + ':' + source.start + '-' + source.end) +
    '</code></p><pre><code>' + esc(source.excerpt) + '</code></pre></article></template>'
  ).join('');
}

function sourceExcerpt(path, start, end, evidenceId, title) {
  const lines = readFileSync(join(root, path), 'utf8').split(/\r?\n/);
  const excerpt = lines.slice(start - 1, end).map((line, index) => numberedSourceLine(line, start + index)).join('\n');
  return '<article class="code-evidence" data-search-card><header><b>' + esc(evidenceId + ' ' + title) +
    '</b>' + sourcePopupButton(path, start, title, start, end) +
    '</header><pre><code>' + esc(excerpt) + '</code></pre></article>';
}

function themeSegment(theme, target) {
  const marker = { 'OWASP Top 10-2025': 'Top10:', 'OWASP ASVS 5.0': 'ASVS:', 'OWASP WSTG 4.2': 'WSTG:', 'デジタル庁 DS-221': 'DS:' }[target];
  if (!marker) return [];
  const at = theme.targetItems.indexOf(marker);
  if (at < 0) return [];
  const rest = theme.targetItems.slice(at + marker.length);
  const next = rest.search(/\s(?:Top10|ASVS|WSTG|DS|CNAS|AISVS):/);
  return (next < 0 ? rest : rest.slice(0, next)).split('/').map((part) => part.trim()).filter(Boolean);
}

function themesFor(target, row) {
  const expected = target === 'OWASP Top 10-2025' ? '#' + row.no :
    target === 'OWASP WSTG 4.2' ? row.itemId.replace(/^WSTG-/, '') : row.itemId;
  return catalog.zapUnsupportedThemes
    .filter((theme) => /^\d+$/.test(theme.no) && themeSegment(theme, target).includes(expected))
    .map((theme) => 'zap-unsupported:' + theme.no);
}

function wapgFamily(row) {
  const no = Number(row.no);
  const found = WAPG_FAMILIES.find(([from, to]) => no >= from && no <= to);
  return found ?? [no, no, 'Webアプリケーション検査', row.method, row.suspectedBehavior, row.safeState];
}

function visibleMethod(target, row) {
  if (target === 'WebAppPentestGuidelines v1.2') return wapgFamily(row)[3];
  return row.method.replace('ソース/応答', 'HTTP応答');
}

function routesFor(target, row) {
  if (target === 'WebAppPentestGuidelines v1.2') return [...(row.coverageRoutes ?? [])];
  const text = row.itemId + ' ' + row.checkItem + ' ' + row.method;
  const routes = [...(HTTP_ROUTE_OVERRIDES.get(`${target}:${String(row.row)}`) ?? []), ...themesFor(target, row)];
  for (const [id, pattern] of WORKFLOW_PATTERNS) if (pattern.test(text)) routes.push('workflow:' + id);
  for (const [name, pattern, ids] of ZAP_PATTERNS) if (pattern.test(text)) routes.push('zap:' + name + ':' + ids);
  if (/既知脆弱|CVE|コンポーネント|製品.*版/i.test(text)) routes.push('nuclei:known-vulnerabilities');
  return [...new Set(routes.length > 0 ? routes : ['review:unmapped-http'])];
}

const WORKFLOW_IMPLEMENTATIONS = new Map([
  ['brute-force', 'runBruteForceCheck'],
  ['csrf-password', 'runCsrfCheck'],
  ['file-upload', 'runFileUploadCheck'],
  ['captcha-bypass', 'runCaptchaBypassCheck'],
  ['weak-session', 'runWeakSessionCheck'],
  ['xss-reflected', 'runXssReflectedCheck'],
  ['xss-stored', 'runXssStoredCheck'],
  ['xss-dom', 'runXssDomCheck'],
  ['csp-bypass', 'runCspBypassCheck'],
  ['client-side-token', 'runClientSideTokenCheck'],
  ['authorization-bypass', 'runAuthorizationBypassCheck'],
  ['bac-open-access', 'runBacOpenAccessCheck'],
  ['open-redirect', 'runOpenRedirectCheck'],
  ['crypto-xor', 'runCryptoXorCheck'],
  ['crypto-ecb', 'runCryptoEcbCheck'],
  ['crypto-cbc-oracle', 'runCryptoCbcOracleCheck'],
  ['api-legacy', 'runApiLegacyCheck'],
  ['api-mass-assignment', 'runApiMassAssignmentCheck'],
  ['api-command-injection', 'runApiCommandInjectionCheck'],
  ['sqli-verify', 'runSqliVerificationCheck'],
  ['lfi', 'runLfiCheck'],
]);

function workflowSource(id, kind = `ScopePilot workflow (${id})`) {
  const functionName = WORKFLOW_IMPLEMENTATIONS.get(id);
  if (functionName === undefined) {
    return sourceBlock('packages/core/src/domain/workflow-scan.ts', `id: '${id}'`, kind, { fallback: 1800 });
  }
  return sourceBlock(
    'packages/core/src/domain/workflow-scan.ts',
    `export async function ${functionName}(`,
    kind,
    { fallback: 534 },
  );
}

function routeSources(route) {
  if (route.startsWith('workflow:')) {
    const id = route.slice('workflow:'.length);
    return [workflowSource(id)];
  }
  if (route.startsWith('zap-unsupported:')) {
    const themeNo = route.split(':')[1];
    if (themeNo === '17') {
      const file = 'docs/work-logs/2026-10-31.md';
      const line = sourceLine(file, '検査不能・スキップ', 1);
      return [{ path: file, line, start: Math.max(1, line - 3), end: line + 16, title: '制限により検査不能・スキップ', label: '制限事項を表示' }];
    }
    const automatic = AUTO_THEME_WORKFLOWS.get(themeNo);
    if (automatic) return [workflowSource(automatic[0], '既存workflowによる代替 (' + automatic[0] + ')')];
    const file = 'packages/core/src/application/baseline-flow.ts';
    if (themeNo === '1') {
      return [sourceBlock(file, 'async runAuthBypassCheck(', 'ScopePilot補完テーマ 1 のHTTP送信・判定', {
        fallback: 1006,
        bodyMarker: '): Promise<AuthBypassCheckSummary> {',
      })];
    }
    return [sourceBlock(file, `case '${themeNo}': {`, `ScopePilot補完テーマ ${themeNo} のHTTP送信・判定`, { fallback: 1200 })];
  }
  if (route.startsWith('zap:')) {
    const file = 'packages/adapters/src/zap-engine.ts';
    return [
      sourceBlock(file, 'async start(request: ActiveScanRequest', 'ZAPの探索・能動診断の実行処理', { fallback: 616, label: '診断実行を表示' }),
      sourceBlock(file, 'async alerts(engineRunId: string', 'ZAP所見とHTTP要求・応答の取得処理', { fallback: 714, label: '結果取得を表示' }),
    ];
  }
  if (route.startsWith('nuclei:')) {
    const file = 'packages/adapters/src/nuclei-runner.ts';
    return [sourceBlock(file, 'async run(input: {', 'Nuclei審査済みHTTP templateの実行処理', {
      fallback: 244,
      bodyMarker: '}): Promise<NucleiRunResult> {',
      label: '診断実行を表示',
    })];
  }
  if (route.startsWith('manual-review:')) {
    const file = 'tools/guideline-catalog/src/generate.ts';
    const line = sourceLine(file, "'manual-review:", 43);
    return [{ path: file, line, start: Math.max(1, line - 4), end: line + 12, title: '手動確認route（自動実行処理なし）', label: '分類根拠を表示' }];
  }
  if (route.startsWith('skip:')) {
    const file = 'docs/work-logs/2026-10-31.md';
    const line = sourceLine(file, '検査不能・スキップ', 1);
    return [{ path: file, line, start: Math.max(1, line - 3), end: line + 16, title: '制限により検査不能・スキップ', label: '制限事項を表示' }];
  }
  return [{ path: 'packages/core/src/domain/workflow-scan.ts', line: 180, start: 176, end: 194, title: '個別接続なし', label: '分類根拠を表示' }];
}

function renderSourceButtons(sources) {
  return sources.map((source) => sourcePopupButton(
    source.path,
    source.line,
    source.title,
    source.start,
    source.end,
    source.label,
  )).join('');
}

function routeReviewText(route) {
  if (route.startsWith('skip:') || route === 'zap-unsupported:17') {
    return '実装: 安全に実証できる製品経路がないため送信しない。判定: 検査不能・スキップとして記録し、pass/failを生成しない。制約: 必要な隔離fixtureまたは対象固有基準が整うまで対象外とする。';
  }
  if (route.startsWith('workflow:')) {
    const id = route.slice('workflow:'.length);
    return `実装: ${id} を選択済みcheck集合から実行し、送信上限内でHTTP要求・応答hash・判定を集約する。判定: check固有の正常対照と変異応答を比較する。制約: 対象URL、認証情報、期待markerが不足する場合は理由付きskipとなり、合否を推測しない。`;
  }
  if (route.startsWith('zap-unsupported:')) {
    const themeNo = route.split(':')[1];
    return `実装: 補完テーマ${themeNo}のhandlerがscope・認可・request budget検査後に限定probeを送信する。判定: domain判定をexposed/denied/inconclusiveへ集約し、未実施観点があればpassにしない。制約: 対象固有入力やfixtureが必要なsub-checkは入力なしでは実行しない。`;
  }
  if (route.startsWith('zap:')) {
    return '実装: ScopePilotは確認済みtarget、scope、上限をZAPへ渡し、alertを所見として取り込む。判定: pluginの検出結果に依存し、ScopePilot内に同等の個別判定コードはない。制約: 連携診断ツールの個々の送信は事前拒否できず、版・入力・観測出力によるDelegated保証である。';
  }
  if (route.startsWith('nuclei:')) {
    return '実装: hash固定・審査済みHTTP templateだけをstageし、確認済みtargetと共有上限で実行してJSONL matchを取り込む。判定: template matchを候補所見とし、人の確認前に確定扱いしない。制約: template外の挙動や連携診断ツール内部の個々の送信は保証しない。';
  }
  if (route.startsWith('manual-review:')) {
    return '実装: 自動assertionはなく、HTTP履歴と公開面を診断者が確認するrouteである。判定: 観測した要求・応答証跡に基づく手動判定を要する。制約: 自動検出済みまたは安全確認済みとは扱わない。';
  }
  return '実装: 個別実行関数との接続を確認できない。判定: 未接続。制約: 実装・試験証拠が整うまで診断可能とは扱わない。';
}

function reviewFor(target, routes) {
  if (routes.includes('review:unmapped-http')) {
    return { status: '自動検証の準備未完了', css: 's-gap', text: 'HTTPで検証できる項目だが、カタログ項目IDから実行関数への個別接続を実装上確認できない。' };
  }
  if (routes.includes('zap-unsupported:17')) {
    return { status: '検査不能・スキップ', css: 's-skip', text: 'HTTP要求スマグリング用の隔離proxy/oracleを製品経路へ安全に接続できないため、利用者方針に従い検査不能としてスキップする。' };
  }
  if (routes.some((route) => route.startsWith('skip:'))) {
    return { status: '検査不能・スキップ', css: 's-skip', text: '対象固有のOAuth認可要求・許可済みscope基準・比較主体がなく、HTTP応答だけでは過剰scopeを判定できないためスキップする。' };
  }
  const hasWorkflow = routes.some((route) => route.startsWith('workflow:'));
  const hasTheme = routes.some((route) => {
    if (!route.startsWith('zap-unsupported:')) return false;
    const themeNo = route.split(':')[1];
    return IMPLEMENTED_THEMES.has(themeNo) || AUTO_THEME_WORKFLOWS.has(themeNo);
  });
  const hasEngine = routes.some((route) => route.startsWith('zap:') || route.startsWith('nuclei:'));
  const basis = hasWorkflow || hasTheme ? 'ScopePilotの送信・判定実装を確認。' :
    hasEngine ? '連携診断ツールの版固定入力と結果取込処理を確認。' : 'HTTP証跡の手動確認のみ。';
  const mapping = target === 'WebAppPentestGuidelines v1.2' ?
    'WAPGの対応はNo範囲単位であり、個々のNo専用assertionではない。' :
    '項目との対応は本レビューによる推定で、runtimeに項目ID別mappingはない。';
  return {
    status: hasWorkflow || hasTheme ? 'ScopePilot内で自動検証' : hasEngine ? '連携診断ツールで自動検証' : 'HTTP証跡を手動確認',
    css: hasWorkflow || hasTheme ? 's-code' : 's-engine',
    text: basis + mapping,
  };
}

function renderRoutes(routes) {
  return routes.map((route) => {
    const sources = routeSources(route);
    return '<li><code>' + esc(route) + '</code><span class="route-kind">' + esc(sources.map((source) => source.title).join('／')) + '</span>' +
      renderSourceButtons(sources) + '</li>';
  }).join('');
}

function renderCodeReview(target, routes) {
  const review = reviewFor(target, routes);
  const details = routes.map((route) => {
    const sources = routeSources(route);
    return '<li><code>' + esc(route) + '</code><br>' + esc(routeReviewText(route)) +
      renderSourceButtons(sources) + '</li>';
  }).join('');
  return '<div data-code-review="complete"><span class="status ' + review.css + '">' + review.status +
    '</span><small>' + esc(review.text) + '</small><ul class="review-details">' + details + '</ul></div>';
}

function renderItem(target, row) {
  const routes = routesFor(target, row);
  const family = target === 'WebAppPentestGuidelines v1.2' ? wapgFamily(row) : null;
  const itemName = family ? 'No.' + row.no + ' ' + family[2] : row.checkItem;
  const suspected = family ? family[4] : row.suspectedBehavior;
  const safe = family ? family[5] : row.safeState;
  return '<tr data-item-row data-http-only="true" data-search-text="' + esc([row.itemId, itemName, row.chapter, visibleMethod(target, row), routes.join(' ')].join(' ').toLowerCase()) + '">' +
    '<td class="id"><b>' + esc(row.itemId) + '</b><small>原本行 ' + esc(row.row) + '</small></td>' +
    '<td><b>' + esc(itemName) + '</b><small>' + esc(row.chapter) + '</small></td>' +
    '<td>' + esc(visibleMethod(target, row)) + '</td>' +
    '<td><span class="bad">疑い: ' + esc(suspected) + '</span><span class="good">安全: ' + esc(safe) + '</span></td>' +
    '<td><ul class="routes">' + renderRoutes(routes) + '</ul></td>' +
    '<td>' + renderCodeReview(target, routes) + '</td>' +
    '</tr>';
}

function renderGuideline(target, index) {
  const guideline = catalog.guidelines.find((candidate) => candidate.sheet === target.name);
  const rows = guideline.checks.filter(target.keep);
  const source = catalog.sources.find((candidate) => candidate.id === guideline.sourceId);
  const grouped = new Map();
  for (const row of rows) {
    const chapter = target.name === 'WebAppPentestGuidelines v1.2' ? wapgFamily(row)[2] : row.chapter;
    if (!grouped.has(chapter)) grouped.set(chapter, []);
    grouped.get(chapter).push(row);
  }
  const sections = [...grouped.entries()].map(([chapter, chapterRows], chapterIndex) =>
    '<details class="chapter" data-search-card ' + (chapterIndex === 0 ? 'open' : '') + '><summary>' +
    esc(chapter) + ' <span>' + chapterRows.length + '項目</span></summary><div class="table-wrap"><table>' +
    '<thead><tr><th>ID</th><th>検証項目</th><th>HTTP検証手順</th><th>判定基準</th><th>検証方法・実装参照</th><th>実装確認結果</th></tr></thead><tbody>' +
    chapterRows.map((row) => renderItem(target.name, row)).join('') +
    '</tbody></table></div></details>'
  ).join('');
  const sourceLink = source?.sourceUrl ? '<p class="summary-line">固定原本: <a href="' + esc(source.sourceUrl) + '">' +
    esc(source.id + ' / commit ' + (source.repositoryCommit ?? '-') + ' / SHA-256 ' + source.sha256) + '</a></p>' : '';
  return '<section id="g' + (index + 1) + '" class="guideline-section"><h2>' + (index + 1) + '. ' + esc(target.short) +
    '</h2><p class="summary-line"><b>HTTP観測対象 ' + rows.length + '項目</b>／原本 ' + guideline.checks.length +
    '項目。表示対象の各行について要求、判定基準、検証方法、実装確認結果を記載する。</p>' + sourceLink + sections + '</section>';
}

const targetData = TARGETS.map((target) => {
  const guideline = catalog.guidelines.find((candidate) => candidate.sheet === target.name);
  return { ...target, guideline, rows: guideline.checks.filter(target.keep) };
});
const httpTotal = targetData.reduce((sum, target) => sum + target.rows.length, 0);
const routeStats = { code: 0, engine: 0, skipped: 0, gap: 0 };
for (const target of targetData) {
  for (const row of target.rows) {
    const review = reviewFor(target.name, routesFor(target.name, row));
    if (review.status === 'ScopePilot内で自動検証') routeStats.code += 1;
    else if (review.status === '連携診断ツールで自動検証') routeStats.engine += 1;
    else if (review.status === '検査不能・スキップ') routeStats.skipped += 1;
    else routeStats.gap += 1;
  }
}

const nav = TARGETS.map((target, index) => '<li><a href="#g' + (index + 1) + '">' + esc(target.short) + '</a></li>').join('');
const overviewRows = targetData.map((target, index) =>
  '<tr><td><a href="#g' + (index + 1) + '">' + esc(target.short) + '</a></td><td>' + target.rows.length +
  '</td><td>' + target.guideline.checks.length + '</td><td>' + esc(target.guideline.version) + '</td></tr>'
).join('');

const agentImplementationReview = [
  {
    area: '製品の実行経路への接続',
    result: '確認済み',
    css: 's-code',
    behavior: '明示設定時だけOTP/SAML用のローカル制御器adapterを生成し、Desktop起動時の診断serviceへ注入する。未設定時は従来どおり理由付きでスキップする。',
    review: '設定の有無がruntime bundle hashにも反映される。製品経路へ未接続だった問題は解消している。',
    references: [
      ['packages/adapters/src/engine-config.ts', 'const securityFixture = createSecurityFixtureAdapters(env);', 'ローカル制御器adapterの生成と構成'],
      ['apps/desktop/src/main/index.ts', '...(engines.otpInbox === undefined', 'Desktop診断serviceへの依存注入'],
    ],
  },
  {
    area: 'OTP受信と再利用・期限・試行制限',
    result: '確認済み（実環境は条件付き）',
    css: 's-code',
    behavior: '制御器の接続先をloopbackへ限定し、redirectを拒否する。発行時刻以後のOTPだけを一時的に受け取り、診断結果にはOTP本文を残さない。302でcookieが発行される通常のMFA入口も正常対照として扱う。',
    review: '単体・service試験は成功。実メールボックスとの結合は制御器が未設定のため実施せず、実案件ではスキップになる。誤OTPは桁数を合わせ、正規OTPとの一致を避けている。',
    references: [
      ['packages/adapters/src/security-fixture.ts', 'export class HttpSecurityFixtureOtpInbox', 'OTP受信adapterと鮮度確認'],
      ['packages/core/src/application/baseline-flow.ts', "case '6': {", 'MFA・OTPの判定処理'],
      ['packages/adapters/test/security-fixture.test.ts', "test('OTP polling", 'OTP adapter試験'],
    ],
  },
  {
    area: 'SAML assertion再送',
    result: '要修正（High）',
    css: 's-gap',
    behavior: 'ローカル制御器は隔離実行の宣言を必須とし、assertion本文ではなくSHA-256だけを返す。redirectも拒否する。',
    review: '制御器自体の接続先はloopback限定だが、制御器へ渡すIdP開始URLとACS URLはhttp(s)形式だけを検査し、案件scopeまたは専用allowlistとの照合がない。制御器が任意URLへ送信できないよう、送信前の許可先検査を追加するまで安全保証は条件付き。実IdP/SP結合は未設定のため実施していない。',
    references: [
      ['packages/adapters/src/security-fixture.ts', 'function fixtureTargetUrl', 'SAML対象URLの現行検証'],
      ['packages/core/src/application/baseline-flow.ts', 'const samlReady =', 'SAML実行条件と制御器呼出し'],
      ['packages/adapters/test/security-fixture.test.ts', "test('SAML controller", 'SAML adapter試験'],
    ],
  },
  {
    area: 'JWT正規tokenの秘密値経路',
    result: '要改善（Medium）',
    css: 's-engine',
    behavior: 'Desktop UIでは正規JWTを伏せ字入力とし、通常parameterではなくsecretValuesへ分離して送信する。CoreもsecretValuesを優先する。',
    review: 'UI経路は修正済み。ただしCoreは旧API互換としてparams.validTokenも受理するため、UI以外の呼出しでは秘密値経路を強制できない。移行期間と削除条件を定め、通常parameterのfallbackを廃止することが望ましい。',
    references: [
      ['apps/desktop/src/renderer/theme-schema.ts', 'export function partitionThemeFieldValues', 'UI入力の通常値・秘密値分離'],
      ['packages/core/src/application/baseline-flow.ts', 'const token = secrets.validToken', 'CoreのJWT取得順序'],
      ['apps/desktop/test/unit/theme-schema.test.ts', "test('secret field", '秘密値分離試験'],
    ],
  },
  {
    area: 'ガイドライン選択から診断関数への接続',
    result: '確認済み',
    css: 's-code',
    behavior: '5ガイドラインの選択を、入力なしで実行できるテーマ30と、対象固有入力を要する診断テーマへ重複なく解決する。active scanではテーマ30の通信数をZAP用上限と分けて予約し、結果を証跡と報告モデルへ残す。',
    review: '経路選択、重複除去、active scanからの実行、通信数予約を試験で確認した。入力待ちテーマは自動成功にせずneeds-inputとして保持する。',
    references: [
      ['packages/core/src/domain/guideline-execution.ts', 'export function resolveGuidelineThemeRoutes', 'ガイドライン別の診断経路解決'],
      ['packages/core/src/application/baseline-flow.ts', 'const guidelineThemePlans =', 'active scanからの自動実行接続'],
      ['packages/core/test/unit/active-scan/scan-start-policy.test.ts', "test('ASVS選択", 'active scan接続試験'],
    ],
  },
  {
    area: '回帰試験・ビルド',
    result: '成功',
    css: 's-code',
    behavior: 'OTP/SAML adapter 4件、Core診断・ガイドライン経路36件、UI schema 9件が成功。全workspaceのnpm test、TypeScript型検査、Desktop main/preload/renderer buildも終了コード0。',
    review: '実ZAP・実Playwright・実DVWA・実メールボックス・実IdP/SPなど環境変数や外部サービスを要する試験は、既定どおりスキップされている。今回の成功は、実環境結合までを証明するものではない。',
    references: [
      ['packages/adapters/test/security-fixture.test.ts', "describe('security fixture adapters'", 'ローカル制御器adapter試験'],
      ['packages/core/test/unit/application/zap-unsupported-check.test.ts', "describe('zap-unsupported check", '補完診断service試験'],
      ['apps/desktop/test/unit/theme-schema.test.ts', "describe('zap-unsupported theme runner schema'", 'Desktop入力schema試験'],
    ],
  },
].map((item) => {
  const references = item.references.map(([path, marker, title]) => {
    const line = sourceLine(path, marker, 1);
    return sourcePopupButton(path, line, title);
  }).join('');
  return '<tr data-agent-review-row><td><b>' + esc(item.area) + '</b></td><td><span class="status ' + item.css + '">' +
    esc(item.result) + '</span></td><td>' + esc(item.behavior) + '</td><td>' + esc(item.review) + '</td><td>' + references + '</td></tr>';
}).join('');

const css = [
  ':root{--nav:20rem;--ink:#172033;--muted:#5b667a;--blue:#0969a2;--navy:#102a43;--line:#dbe3ec;--bg:#f3f6f9;--ok:#107c41;--warn:#986400;--bad:#b42318}',
  '*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:var(--bg);font:15px/1.65 "Segoe UI","Yu Gothic UI",sans-serif}',
  '.nav{position:fixed;inset:0 auto 0 0;z-index:30;width:var(--nav);overflow:auto;padding:1.1rem;color:#fff;background:var(--navy)}.nav h1{font-size:1.1rem;margin:0}.nav p{color:#cbd5e1}.nav input{width:100%;padding:.65rem;border:0;border-radius:.35rem}.nav a{color:#e0f2fe;text-decoration:none}.nav a:hover,.nav a[aria-current=true]{text-decoration:underline}.nav li{margin:.35rem 0}.nav .small{font-size:.75rem;color:#cbd5e1}',
  'main{margin-left:var(--nav);padding:2rem clamp(1rem,3vw,3rem) 6rem}.wrap{max-width:1700px;margin:auto}.hero,section{background:#fff;border:1px solid var(--line);border-radius:.8rem;padding:1.6rem;margin-bottom:1.4rem;box-shadow:0 .15rem .7rem #0f172a0d}.hero{border-top:.38rem solid var(--blue)}h1{font-size:clamp(1.8rem,3vw,3rem);line-height:1.2;margin:.2rem 0}h2{color:var(--navy);border-bottom:2px solid #dbeafe;padding-bottom:.4rem}h3{color:var(--navy)}',
  '.notice{padding:1rem;border-left:.3rem solid var(--blue);background:#eef6ff}.notice.warn{border-color:#e67e00;background:#fff8e6}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.8rem}.metric{padding:1rem;border:1px solid var(--line);border-radius:.6rem}.metric b{display:block;font-size:1.7rem;color:var(--navy)}',
  '.chapter{margin:.8rem 0;border:1px solid var(--line);border-radius:.55rem;background:#fff}.chapter>summary{cursor:pointer;padding:.8rem 1rem;font-weight:700;color:var(--navy);background:#f7fafc}.chapter>summary span{float:right;color:var(--muted);font-weight:400}.table-wrap{overflow:auto;max-height:70vh}table{width:100%;min-width:1200px;border-collapse:collapse;font-size:.82rem}th,td{padding:.55rem;vertical-align:top;border:1px solid var(--line)}th{position:sticky;top:0;z-index:2;color:#fff;background:var(--navy)}td:nth-child(1){width:8rem}td:nth-child(2){width:14rem}td:nth-child(3){width:22rem}td:nth-child(4){width:20rem}td:nth-child(5){width:19rem}.id small,td small{display:block;color:var(--muted);margin-top:.3rem}.bad,.good{display:block}.bad{color:#8a1c13}.good{color:#0b6b3a}.routes{margin:0;padding-left:1.1rem}.routes code{font-size:.76rem}.route-kind{display:block;margin:.2rem 0;color:var(--muted)}',
  '.status{display:inline-block;padding:.15rem .5rem;border-radius:999px;font-weight:700}.s-code{color:#075c31;background:#dff7e8}.s-engine{color:#714c00;background:#fff1c2}.s-skip{color:#5f3b00;background:#f5e7c6}.s-gap{color:#8f1d16;background:#ffe2df}.summary-line{color:var(--muted)}.review-details{margin:.45rem 0 0;padding-left:1.1rem}.review-details li{margin:.45rem 0}',
  '.code-evidence{margin:1rem 0;border:1px solid var(--line);border-radius:.55rem;overflow:hidden}.code-evidence header{display:flex;justify-content:space-between;gap:1rem;padding:.65rem;background:#edf5fb}.code-evidence pre{margin:0;padding:1rem;overflow:auto;background:#101923;color:#e6edf3;font-size:.78rem}',
  '.source-ref{display:inline-flex;flex-direction:column;align-items:flex-start;gap:.05rem;margin:.3rem 0;padding:.35rem .55rem;border:1px solid #9bbbd3;border-radius:.35rem;color:#075985;background:#f0f9ff;cursor:pointer;font:inherit;text-align:left}.source-ref:hover,.source-ref:focus-visible{background:#dff2ff;border-color:#0969a2}.source-ref small{margin:0;color:#526274;font-size:.7rem;overflow-wrap:anywhere}',
  '.source-modal{width:min(92vw,1100px);height:min(88vh,900px);max-height:88vh;padding:0;overflow:hidden;border:0;border-radius:.75rem;box-shadow:0 1.2rem 4rem #0007}.source-modal[open]{display:flex;flex-direction:column}.source-modal::backdrop{background:#07182bbb}.source-modal>header{flex:0 0 auto;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.2rem;color:#fff;background:var(--navy)}.source-modal>header h2{margin:0;padding:0;border:0;color:#fff;font-size:1.15rem}.source-modal-close{padding:.45rem .8rem;border:1px solid #fff;border-radius:.35rem;color:#fff;background:transparent;cursor:pointer}.source-modal-content{flex:1 1 auto;min-height:0;padding:1.2rem;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.popup-source h3{margin-top:0}.popup-source pre{max-width:100%;margin:0;padding:1rem;overflow-x:auto;overflow-y:visible;white-space:pre;color:#e6edf3;background:#101923;border-radius:.45rem;font-size:.8rem}',
  '.hidden-by-search{display:none!important}.no-results{display:none;color:var(--bad);font-weight:700}.no-results.visible{display:block}',
  '@media(max-width:950px){.nav{position:sticky;width:100%;max-height:45vh}.nav ol{columns:2}main{margin:0;padding:1rem}.table-wrap{max-height:none}}',
  '@media print{.nav{display:none}main{margin:0;padding:0}.hero,section{box-shadow:none;break-inside:avoid}.chapter{break-inside:auto}.chapter:not([open])>*:not(summary){display:block}.table-wrap{max-height:none;overflow:visible}table{font-size:7.5pt;min-width:0}a{color:inherit;text-decoration:none}}',
].join('');

const html = [
  '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>ScopePilot2 HTTP診断項目・実装確認レポート</title><style>' + css + '</style></head><body id="top">',
  '<nav class="nav" aria-label="文書索引"><h1>HTTP診断・実装確認</h1><p>ScopePilot2 / 個別検証項目</p>',
  '<input id="search" type="search" placeholder="ID・検査名・経路を検索" aria-label="文書内検索"><ol>',
  '<li><a href="#scope">対象範囲と結論</a></li><li><a href="#review">実装確認の概要</a></li><li><a href="#matrix">対象件数</a></li>' +
    nav + '<li><a href="#agent-review">追加実装のレビュー</a></li><li><a href="#evidence">実装コード抜粋</a></li><li><a href="#tests">試験コード抜粋</a></li></ol>',
  '<p class="small">索引は固定表示。検索時は一致する個別行と章だけを表示する。</p></nav>',
  '<main><div class="wrap"><header class="hero" id="scope" data-search-card><h1>ScopePilot2 HTTP診断項目・実装確認レポート</h1>',
  '<p>OWASP Top 10、ASVS、WSTG、DS-221、WebAppPentestGuidelinesについて、保存されたHTTP要求・HTTP応答（HTTP Upgrade handshakeを含む）と、その応答本文から追跡できるブラウザ観測だけで判定できる技術項目を扱う。TLS版・暗号スイート・証明書chain、DNS、端末内状態、サーバ内部のソース・設定・ログ、資料・ヒアリングだけで確認する観点は掲載しない。</p>',
  '<p>基準日 2026-10-31　catalog schema ' + esc(catalog.schemaVersion) + '　catalog hash <code>' + esc(catalog.catalogHash) + '</code></p>',
  '<div class="notice"><b>結論:</b> HTTP観測対象 ' + httpTotal + '項目を個別掲載した。ScopePilot内で自動検証 ' + routeStats.code +
    '項目、連携診断ツールで自動検証 ' + routeStats.engine + '項目、検査不能・スキップ ' + routeStats.skipped + '項目、自動検証の準備未完了 ' + routeStats.gap +
    '項目である。「カタログに項目があること」と「診断コードへ接続されていること」を分けて評価した。</div></header>',
  '<section id="review" data-search-card><h2>実装確認の概要</h2><ol>',
  '<li><b>Top10・ASVS・WSTG:</b> guideline選択後はworkflow検査と補完テーマprofileへ解決される。個々の標準項目IDとの対応は、本表の固定行座標mapping・補完テーマ表・ZAPルールを突合したレビュー結果である。</li>',
  '<li><b>DS-221:</b> guideline選択後のScopePilot workflowは9検査に限定される。その他のHTTP項目はZAP、Nuclei、補完テーマ、または自動検証の準備未完了として区別した。</li>',
  '<li><b>WebAppPentestGuidelines:</b> No.1～102にはcoverageRoutesが保存される。ただしNo範囲単位の対応であり、各No専用のassertionではない。</li>',
  '<li><b>判定の安全性:</b> 補完テーマは入力不足・未実施観点があればpassではなくinconclusiveにする。通信数上限も送信前に検査する。</li>',
  '</ol><div class="notice warn"><b>読み方:</b> 「ScopePilot内で自動検証」は本製品自身がHTTP送信と判定を行う項目、「連携診断ツールで自動検証」はZAPまたはNucleiの結果を本製品へ取り込む項目である。対象固有URL、認証情報、比較用アカウント、fixtureがなければ実案件の合否は確定しない。</div></section>',
  '<section id="matrix" data-search-card><h2>HTTP観測対象件数</h2><div class="metrics"><div class="metric"><b>' + httpTotal +
    '</b>個別項目</div><div class="metric"><b>' + routeStats.code + '</b>ScopePilot内で自動検証</div><div class="metric"><b>' +
    routeStats.engine + '</b>連携診断ツールで自動検証</div><div class="metric"><b>' + routeStats.skipped + '</b>検査不能・スキップ</div><div class="metric"><b>' + routeStats.gap + '</b>自動検証の準備未完了</div></div>',
  '<div class="table-wrap"><table><thead><tr><th>ガイドライン</th><th>HTTP観測対象</th><th>原本項目</th><th>版</th></tr></thead><tbody>' +
    overviewRows + '</tbody></table></div></section>',
  TARGETS.map((target, index) => renderGuideline(target, index)).join(''),
  '<section id="agent-review" data-search-card><h2>追加実装の動作確認・コードレビュー</h2>',
  '<p>2026-10-31に他のエージェントが追加・接続したガイドライン診断経路を独立に確認した。試験成功と実運用上の安全保証を分け、未構成の実サービスを使う試験は成功扱いにしていない。</p>',
  '<div class="notice warn"><b>レビュー結論:</b> 製品経路への接続と主要な判定ロジックは動作する。SAML対象URLの許可先検査はHigh、JWTの旧parameter fallbackはMediumの残課題として扱う。これらを解消するまで、該当機能の安全保証は条件付きである。</div>',
  '<div class="table-wrap"><table class="agent-review-table"><thead><tr><th>確認対象</th><th>評価</th><th>確認した動作</th><th>コードレビュー</th><th>実装・試験</th></tr></thead><tbody>' + agentImplementationReview + '</tbody></table></div></section>',
  '<section id="evidence"><h2>実装コード抜粋</h2>',
  sourceExcerpt('packages/core/src/domain/workflow-scan.ts', 139, 188, 'E-01', 'ガイドラインからworkflow検査への解決'),
  sourceExcerpt('packages/core/src/domain/workflow-scan.ts', 1809, 1894, 'E-02', '選択検査の実行、上限、証跡集約'),
  sourceExcerpt('packages/core/src/domain/zap-unsupported.ts', 17, 78, 'E-03', '補完テーマ、inconclusive、通信数上限'),
  sourceExcerpt('packages/core/src/domain/guideline-execution.ts', 1, 82, 'E-04', 'ガイドライン別の自動・入力待ち経路'),
  sourceExcerpt('packages/core/src/application/baseline-flow.ts', 4163, 4210, 'E-05', 'active scanのHTTP補完経路とrequest budget予約'),
  sourceExcerpt('tools/guideline-catalog/src/generate.ts', 39, 72, 'E-06', 'WAPG No.1～102のcoverage route'),
  sourceExcerpt('packages/adapters/src/workflow-scan-transport.ts', 1, 136, 'E-07', 'HTTP送信、Origin固定、秘密値保護'),
  '</section>',
  '<section id="tests"><h2>試験コード抜粋</h2><p>以下の試験コードは、実DVWAでのガイドライン切替と、DVWAにないHTTP機能のV/F境界を確認する。</p>',
  sourceExcerpt('packages/adapters/test/dvwa-workflow-guidelines.integration.test.ts', 25, 83, 'T-01', 'DVWA guideline切替統合試験'),
  sourceExcerpt('packages/adapters/test/vulnerabilitiesbox-guideline.integration.test.ts', 15, 155, 'T-02', 'GraphQL・WebSocket・JWT・mail・LDAP・SSRF・MFA V/F試験'),
  sourceExcerpt('packages/adapters/test/security-fixture.test.ts', 1, 90, 'T-03', 'OTP/SAMLローカル制御器adapter試験'),
  sourceExcerpt('apps/desktop/test/unit/theme-schema.test.ts', 108, 132, 'T-04', '秘密値入力の分離試験'),
  sourceExcerpt('packages/core/test/unit/active-scan/scan-start-policy.test.ts', 50, 93, 'T-05', 'ガイドライン選択から自動診断への接続試験'),
  '</section><p id="no-results" class="no-results">検索条件に一致する個別項目はありません。</p>',
  '<dialog id="source-modal" class="source-modal" aria-labelledby="source-modal-title"><header><h2 id="source-modal-title">実装コード</h2><button type="button" id="source-modal-close" class="source-modal-close">閉じる</button></header><div id="source-modal-content" class="source-modal-content"></div></dialog>',
  '<div hidden>' + renderSourcePopupTemplates() + '</div>',
  '<footer><p>生成元: <code>tools/report-tools/generate-guideline-conformance-evidence.mjs</code> / 単一HTML・外部CSS/JavaScript依存なし</p></footer>',
  '</div></main><script>(()=>{const s=document.getElementById("search");const rows=[...document.querySelectorAll("[data-item-row]")];const chapters=[...document.querySelectorAll(".chapter")];const cards=[...document.querySelectorAll("[data-search-card]:not(.chapter)")];const empty=document.getElementById("no-results");s.addEventListener("input",()=>{const q=s.value.trim().toLocaleLowerCase("ja");let count=0;for(const row of rows){const show=!q||row.dataset.searchText.includes(q);row.classList.toggle("hidden-by-search",!show);if(show&&q)count++}for(const chapter of chapters){const show=!q||chapter.querySelector("tr[data-item-row]:not(.hidden-by-search)");chapter.classList.toggle("hidden-by-search",!show);if(q&&show)chapter.open=true}for(const card of cards)card.classList.toggle("hidden-by-search",!!q);empty.classList.toggle("visible",!!q&&count===0)});const links=[...document.querySelectorAll(".nav a[href^=\\"#\\"]")];const targets=links.map(a=>document.querySelector(a.getAttribute("href"))).filter(Boolean);const o=new IntersectionObserver(es=>{const v=es.filter(e=>e.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];if(!v)return;links.forEach(a=>a.removeAttribute("aria-current"));document.querySelector(".nav a[href=\\"#"+v.target.id+"\\"]")?.setAttribute("aria-current","true")},{rootMargin:"-15% 0px -70% 0px",threshold:[0,.2,.6]});targets.forEach(t=>o.observe(t));const dialog=document.getElementById("source-modal");const content=document.getElementById("source-modal-content");document.addEventListener("click",event=>{const button=event.target.closest("[data-source-ref]");if(!button)return;const template=document.getElementById(button.dataset.sourceRef);if(!template)return;content.replaceChildren(template.content.cloneNode(true));dialog.showModal()});document.getElementById("source-modal-close").addEventListener("click",()=>dialog.close());dialog.addEventListener("click",event=>{if(event.target===dialog)dialog.close()})})();</script></body></html>',
].join('\n');

writeFileSync(outputPath, html, 'utf8');
console.log('generated ' + relative(root, outputPath) + ' (' + httpTotal + ' HTTP-observable items)');
