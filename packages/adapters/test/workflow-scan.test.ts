/**
 * ワークフロー診断の回帰テスト。DVWAが意図して含む18分類の脆弱性と副ギャップ
 * （API経由のOSコマンドインジェクション、LFI成立証拠、SQLi URL単位確認、
 * オープンリダイレクト medium/high 迂回）を取りこぼしなく検出できることを確認する。
 * 旧 C# 実装の WorkflowScanTests に相当する。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { NodeWorkflowScanTransport } from '../src/workflow-scan-transport.ts';
import { startFakeDvwaServer, type FakeDvwaServer } from './fake-dvwa-server.ts';
import {
  clientSideTokenCandidates,
  detectRepeatingKey,
  findDomSink,
  analyzeSessionPattern,
  md5Hex,
  parseExternalScriptOrigins,
  runWorkflowScan,
  tryGetHost,
  xorBytes,
  type WorkflowScanTransport,
} from '@scopepilot2/core';

const EXPECTED_CHECK_IDS: readonly string[] = [
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
];

function createTransport(baseUrl: string, maxRequests: number, redactions: readonly string[]): WorkflowScanTransport {
  return new NodeWorkflowScanTransport({ baseUrl, maxRequests, redactionValues: redactions });
}

describe('WorkflowScan (DVWA 18分類の網羅検出)', () => {
  let server: (FakeDvwaServer & { loginAttempted: boolean; currentPassword: string }) | undefined;

  before(async () => {
    server = (await startFakeDvwaServer('admin', 'SecretPass123')) as FakeDvwaServer & {
      loginAttempted: boolean;
      currentPassword: string;
    };
  });

  after(async () => {
    await server?.close();
  });

  test('全チェックIDを検出し、レベル別挙動・証跡・復元を確認する', async () => {
    assert.ok(server !== undefined);
    const baseUrl = server.baseUrl;
    const transport = new NodeWorkflowScanTransport({
      baseUrl,
      maxRequests: 2000,
      redactionValues: ['SecretPass123'],
    });
    const result = await runWorkflowScan(
      { baseUrl, username: 'admin', password: 'SecretPass123' },
      transport,
      {
        progress: () => undefined,
        createProbeTransport: () =>
          createTransport(baseUrl, 100, ['SecretPass123']),
      },
    );

    assert.equal(result.authenticated, true);
    assert.equal(result.originalSecurityLevel, 'low');
    const detectedIds = new Set(result.checks.map((check) => check.checkId));
    const missing = EXPECTED_CHECK_IDS.filter((id) => !detectedIds.has(id));
    assert.deepEqual(missing, [], `未検出のチェック: ${missing.join(', ')} / 検出済み: ${[...detectedIds].join(', ')}`);

    // レベル別に挙動が変わる暗号モジュール: XOR=low / ECB=medium / CBCオラクル=high
    assert.ok(result.checks.some((c) => c.checkId === 'crypto-xor' && c.securityLevel === 'low'));
    assert.ok(result.checks.some((c) => c.checkId === 'crypto-ecb' && c.securityLevel === 'medium'));
    assert.ok(result.checks.some((c) => c.checkId === 'crypto-cbc-oracle' && c.securityLevel === 'high'));

    // セッションIDの生成規則はレベルごとに判定される（連番・時刻・MD5連番）。
    const weakSessionLevels = new Set(
      result.checks.filter((c) => c.checkId === 'weak-session').map((c) => c.securityLevel),
    );
    for (const level of ['low', 'medium', 'high']) {
      assert.ok(weakSessionLevels.has(level), `weak-session ${level} が未検出`);
    }

    // LFI（ローカルファイル読取りの成立証拠）は全レベルで確認する。
    const lfiLevels = new Set(result.checks.filter((c) => c.checkId === 'lfi').map((c) => c.securityLevel));
    for (const level of ['low', 'medium', 'high']) {
      assert.ok(lfiLevels.has(level), `lfi ${level} が未検出`);
    }

    // SQLインジェクションはURL単位（通常型・ブラインド型）で確認する。
    const sqliUrls = [...new Set(result.checks.filter((c) => c.checkId === 'sqli-verify').map((c) => c.url))];
    assert.ok(
      sqliUrls.some((url) => url.includes('vulnerabilities/sqli/') && !url.includes('blind')),
      `通常型のURLが無い: ${sqliUrls.join(', ')}`,
    );
    assert.ok(sqliUrls.some((url) => url.includes('sqli_blind')), `ブラインド型のURLが無い: ${sqliUrls.join(', ')}`);

    // オープンリダイレクトは low/medium/high の各実装ファイルで確認する。
    assert.equal(result.checks.filter((c) => c.checkId === 'open-redirect').length, 3);

    // すべての所見が報告に必要な内容を持つ。
    for (const check of result.checks) {
      assert.ok(check.title.trim() !== '');
      assert.ok(check.description.trim() !== '');
      assert.ok(check.evidence.trim() !== '');
      assert.ok(check.remediation.trim() !== '');
      assert.ok(['high', 'medium', 'low', 'info'].includes(check.severity), check.severity);
      assert.ok(/^\d+$/.test(check.cwe), check.cwe);
    }

    // ペイロード集合の版が記録されている (AGENTS.md ベンチマーク節の要件)。
    assert.ok(result.payloadSet.includes('workflow-scan-payloads/v1'));

    // 認証情報は要求証跡へ露出しない。
    const logText = JSON.stringify(result.requestLog);
    assert.ok(!logText.includes('SecretPass123'), '証跡ログへパスワードが含まれている');

    // 破壊的検証の復元: パスワード・セキュリティレベルは元の値へ戻る。
    assert.equal(server.currentPassword, 'SecretPass123');
    assert.equal(server.securityLevel, 'low');

    assert.ok(result.requestCount > 100 && result.requestCount <= 2000, `requestCount=${String(result.requestCount)}`);
  });

  test('ログイン失敗時は未認証のまま安全に完了する', async () => {
    assert.ok(server !== undefined);
    const transport = new NodeWorkflowScanTransport({ baseUrl: server.baseUrl, maxRequests: 500 });
    const result = await runWorkflowScan({ baseUrl: server.baseUrl, username: 'admin', password: 'wrong-password' }, transport);
    assert.equal(result.authenticated, false);
    assert.equal(result.checks.length, 0);
    assert.equal(server.loginAttempted, true);
  });
});

describe('WorkflowScan 純粋関数', () => {
  test('セッションID系列からDVWAの生成規則を特定する', () => {
    assert.equal(analyzeSessionPattern(['1', '2', '3', '4'])?.name, '単純連番');
    const now = String(Math.floor(Date.now() / 1000));
    assert.equal(analyzeSessionPattern([now, now, now])?.name, '現在時刻');
    assert.equal(analyzeSessionPattern([md5Hex('7'), md5Hex('7')])?.name, '連番のMD5（7）');
    assert.equal(analyzeSessionPattern(['xk29fja0w83', 'pqq1zlm4vc9']), undefined);
  });

  test('既知平文から反復XOR鍵を復元する', () => {
    const key = new TextEncoder().encode('wachtwoord');
    const plain = new TextEncoder().encode('the password is Olifant and more text to cover the whole key');
    const cipher = xorBytes(plain, key);
    const stream = xorBytes(cipher, plain);
    const recovered = detectRepeatingKey(stream);
    assert.equal(recovered === undefined ? '' : new TextDecoder().decode(recovered), 'wachtwoord');
    assert.equal(detectRepeatingKey(new Uint8Array(64).map(() => Math.floor(Math.random() * 256))), undefined);
  });

  test('DOMシンク検出はソースとシンクの両方を要求する', () => {
    assert.ok(findDomSink('var lang = location.href.substring(10);\ndocument.write(lang);') !== undefined);
    assert.equal(findDomSink("document.write('static content');"), undefined);
    assert.equal(findDomSink('var x = location.href;'), undefined);
  });

  test('CSP許可元パースは self キーワードを除外する', () => {
    const origins = parseExternalScriptOrigins("script-src 'self' https://pastebin.com example.com cdn.jsdelivr.net;");
    assert.equal(origins.length, 3);
    assert.ok(origins.includes('https://pastebin.com'));
  });

  test('クライアント側トークン候補は配布ロジックと一致する', () => {
    const [low, medium, high] = clientSideTokenCandidates('success');
    assert.equal(low, md5Hex('fhpprff'));
    assert.equal(medium, 'XXsseccusXX');
    const inner = `XX${'success'.split('').reverse().join('')}`;
    const expected = createHash('sha256')
      .update(`${createHash('sha256').update(inner, 'ascii').digest('hex')}ZZ`, 'ascii')
      .digest('hex');
    assert.equal(high, expected);
  });

  test('リダイレクト先ホスト解析はプロトコル相対URLを扱う', () => {
    assert.equal(tryGetHost('//scopepilot-check.invalid/x'), 'scopepilot-check.invalid');
    assert.equal(tryGetHost('https://evil.test/y'), 'evil.test');
    assert.equal(tryGetHost('login.php'), undefined);
  });
});
