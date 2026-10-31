import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
  DEFAULT_REPORT_PROFILE,
  appendAssuranceHttpEvidenceMarkdown,
  buildReportFindingFamilies,
  buildAssuranceReport,
  renderAssuranceReport,
  renderExecutiveReport,
  renderTechnicalAnnexHtml,
} from '../../src/main/assurance-report.ts';

describe('ScopePilot2 assurance report', () => {
  test('前回と同じ所見とHTTP通信から具体的な説明・再現手順・対策を生成する', async () => {
    const input = {
      reportId: 'report-0001',
      modelHash: 'a'.repeat(64),
      startUrl: 'https://shop.example.test/login?token=START_SECRET#fragment',
      forbiddenActions: ['決済', '削除'],
      profile: {
        ...DEFAULT_REPORT_PROFILE,
        systemName: '架空ECサイト',
        clientName: '架空株式会社',
        conclusion: '確認済みの指摘を優先して対応してください',
      },
      model: {
        caseId: 'case-1',
        generatedAt: '2026-10-23T12:00:00.000Z',
        guidelines: ['OWASP Top 10-2025', 'OWASP WSTG 4.2'],
        assessmentScope: {
          caseName: '架空ECサイト診断',
          allowedOrigins: ['https://shop.example.test'],
          deniedOrigins: [],
          limits: { maxRequests: 1000, maxPages: 100, maxDurationMinutes: 60 },
          authorization: {
            allowedOperationClasses: ['Browse', 'ActiveScan'],
            targetRoles: ['unauthenticated', 'member'],
            validFrom: '2026-10-23T00:00:00.000Z',
            validUntil: '2026-11-23T00:00:00.000Z',
            evidenceRef: 'evidence-auth',
          },
        },
        coverage: {
          exploredUrlCount: 20,
          scannedUrlCount: 8,
          exploredUrls: [
            { url: 'https://shop.example.test/', statusCode: 200, contentType: 'text/html', depth: 0, discoveredFrom: null, originType: 'crawl' },
            { url: 'https://shop.example.test/account?id=QUERY_SECRET#detail', statusCode: 200, contentType: 'application/json', depth: 1, discoveredFrom: 'https://shop.example.test/', originType: 'crawl' },
            { url: 'https://shop.example.test/security.php', statusCode: 200, contentType: 'text/html', depth: 1, discoveredFrom: 'https://shop.example.test/', originType: 'crawl' },
          ],
          scannedUrls: ['https://shop.example.test/', 'https://shop.example.test/account?id=QUERY_SECRET#detail'],
          excludedUrls: [{ url: 'https://shop.example.test/security.php', reason: '診断候補として検出されたが、実行対象として選択されなかったため除外' }],
          diagnosticRoutes: [{ track: 'api-schema', targetUrl: 'https://shop.example.test/api/v2/user/', status: 'executed', detail: 'API診断' }],
          delegatedSteps: [{ stepId: 'active-1', engineKind: 'zap', engineVersion: '2.16.1' }],
          limitations: ['決済操作は実施していません'],
        },
        findings: [{
          findingId: 'F-001', title: '他利用者の情報を参照できる',
          source: { kind: 'zap-alert', engineVersion: '2.17.0', unverified: true },
          url: 'https://shop.example.test/account?id=QUERY_SECRET#detail', method: 'GET', param: 'id', severity: 'high',
          status: 'confirmed', evidenceRefs: ['evidence-0001'], firstSeenAt: '2026-10-23T10:00:00.000Z',
          lastSeenAt: '2026-10-23T11:00:00.000Z', occurrences: 2, enginePluginId: '40001',
        }],
      },
      evidence: [{
        evidenceId: 'evidence-0001', label: 'manual-check', sha256: 'b'.repeat(64), savedAt: '2026-10-23T10:00:00.000Z',
        metadata: { blob: 'evidence/blobs/hash.txt', mediaType: 'text/plain' },
      }],
      evidenceContents: {
        'evidence-0001': JSON.stringify({ alerts: [{
          pluginId: '40001', url: 'https://shop.example.test/account?id=QUERY_SECRET#detail', method: 'GET', param: 'id',
          requestHeader: 'GET /account?id=102 HTTP/1.1\r\nHost: shop.example.test\r\nCookie: session=COOKIE_SECRET\r\nAuthorization: Bearer AUTH_SECRET',
          requestBody: '',
          responseHeader: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: session=RESPONSE_SECRET',
          responseBody: `{"padding":"${'x'.repeat(3_000)}","customer":{"id":"102","email":"alice@example.test","name":"Alice"},"tail":"${'y'.repeat(3_000)}"}`,
          attack: '102', evidenceSummary: 'id=102',
        }] }),
      },
    } as const;
    const report = buildAssuranceReport(input);

    const serialized = JSON.stringify(report);
    assert.equal(report.templateId, 'scopepilot2-assurance-ja-v2');
    assert.equal(report.coverageSummary.exploredUrlCount, 3);
    assert.equal(report.coverageSummary.scannedUrlCount, 2);
    assert.match(report.urlCoverage.find((entry) => entry.url.endsWith('/security.php'))?.exclusionReason ?? '', /安全制約/u);
    assert.equal(report.urlCoverage.find((entry) => entry.url.endsWith('/api/v2/user/'))?.discoveredFrom, '診断経路: api-schema');
    assert.ok(report.assessment.assumptions.includes('ご依頼いただいたものはツールによる自動診断であり、手動での診断は作業範囲外となります。'));
    assert.equal(report.summary.highestSeverity, 'High');
    assert.doesNotMatch(serialized, /"(?:validationStatus|humanReview|validationCounts)"/u);
    assert.equal(report.findings[0]?.url, 'https://shop.example.test/account?id=QUERY_SECRET#detail');
    assert.match(report.findings[0]?.technicalEvidence.request ?? '', /^GET \/account\?id=102 HTTP\/1\.1/mu);
    assert.match(report.findings[0]?.technicalEvidence.response ?? '', /^HTTP\/1\.1 200 OK/mu);
    assert.match(report.findings[0]?.technicalEvidence.response ?? '', /Body省略/u);
    assert.match(report.findings[0]?.technicalEvidence.response ?? '', /"id":"102"/u);
    assert.ok((report.findings[0]?.technicalEvidence.responseBodyOmittedChars ?? 0) > 0);
    assert.equal(report.findings[0]?.technicalEvidence.bodyMode, 'relevant');
    assert.equal(report.findings[0]?.technicalEvidence.highlightEnabled, true);
    assert.ok(report.findings[0]?.technicalEvidence.highlightTerms.includes('102'));
    assert.match(report.findings[0]?.technicalEvidence.request ?? '', /Cookie: session=\[redacted\]/u);
    assert.match(report.findings[0]?.technicalEvidence.request ?? '', /Authorization: \[redacted\]/u);
    assert.match(report.findings[0]?.technicalEvidence.response ?? '', /Set-Cookie: session=\[redacted\]/u);
    assert.doesNotMatch(serialized, /COOKIE_SECRET|AUTH_SECRET|RESPONSE_SECRET/u);
    assert.doesNotMatch(report.findings[0]?.summary ?? '', /診断エンジンが検出した候補/u);
    assert.match(report.findings[0]?.summary ?? '', /認可確認が不足/u);
    assert.match(report.findings[0]?.conditions ?? '', /GET https:\/\/shop\.example\.test\/account\?id=QUERY_SECRET#detail/u);
    assert.match(report.findings[0]?.cause ?? '', /観測事実: GET \/account\?id=102 HTTP\/1\.1/u);
    assert.match(report.findings[0]?.cause ?? '', /推定原因:.*検索条件.*共通認可ガード/su);
    assert.match(report.findings[0]?.cause ?? '', /診断時通信からの推定/u);
    assert.match(report.findings[0]?.reproduction.steps.join('\n') ?? '', /対象URL「https:\/\/shop\.example\.test\/account\?id=QUERY_SECRET#detail」/u);
    assert.match(report.findings[0]?.remediation.permanent ?? '', /セッションから確定した利用者ID/u);
    assert.deepEqual(report.evidence[0]?.relatedFindingIds, ['F-001']);
    const markdown = appendAssuranceHttpEvidenceMarkdown('# 診断報告書', report);
    assert.match(markdown, /### F-001 他利用者の情報を参照できる[\s\S]*\*\*再現用 Request\*\*[\s\S]*GET \/account\?id=102 HTTP\/1\.1/u);
    assert.match(markdown, /\*\*観測した Response\*\*[\s\S]*HTTP\/1\.1 200 OK/u);
    assert.doesNotMatch(markdown, /COOKIE_SECRET|AUTH_SECRET|RESPONSE_SECRET/u);
    assert.match(markdown, /\*\*原因\*\*[\s\S]*観測事実:[\s\S]*推定原因:/u);
    assert.match(markdown, /## 指摘の再現情報/u);
    assert.doesNotMatch(markdown, /## 診断時HTTP証跡/u);
    assert.doesNotMatch(markdown, /人による検証結果|成立状態|証跡単位の判定/u);

    const word = await renderAssuranceReport(report);
    assert.equal(word.subarray(0, 2).toString('ascii'), 'PK');
    assert.ok(word.length > 10_000, '複数章と表を持つDOCXを生成する');
    const archive = await JSZip.loadAsync(word);
    const documentXml = await archive.file('word/document.xml')?.async('string');
    assert.match(documentXml ?? '', /<w:highlight w:val="yellow"\/>/u);
    assert.match(documentXml ?? '', /Body省略/u);
    assert.match(documentXml ?? '', /原因[\s\S]*観測事実:[\s\S]*推定原因:/u);
    assert.doesNotMatch(documentXml ?? '', /診断時に収集したHTTP証跡|業務影響/u);
    assert.ok(((documentXml ?? '').match(/<w:pageBreakBefore\/>/gu) ?? []).length >= 9, '第2章以降は章単位で改ページする');
    assert.ok(((documentXml ?? '').match(/<w:tblHeader\/>/gu) ?? []).length >= 10, '複数ページ表でヘッダー行を反復する');
    const plainWord = (documentXml ?? '').replace(/<[^>]+>/gu, '');
    assert.doesNotMatch(plainWord, /人による検証結果|成立状態|証跡単位の判定/u);
    const findingPositions = [...plainWord.matchAll(/F-001/gu)].map((match) => match.index);
    assert.ok((findingPositions[1] ?? Number.MAX_SAFE_INTEGER) < plainWord.indexOf('CWE'), '指摘見出しの後に同じ指摘の分類を配置する');

    const families = buildReportFindingFamilies(report);
    assert.equal(families.length, 1);
    assert.match(families[0]?.concreteRisk ?? '', /他利用者の情報を閲覧・変更|許可されていない機能/u);
    assert.match(families[0]?.verificationStatus ?? '', /要確認|未確認/u);
    assert.deepEqual(families[0]?.findingIds, ['F-001']);
    const executiveWord = await renderExecutiveReport(report);
    assert.equal(executiveWord.subarray(0, 2).toString('ascii'), 'PK');
    const executiveArchive = await JSZip.loadAsync(executiveWord);
    const executiveXml = await executiveArchive.file('word/document.xml')?.async('string') ?? '';
    const executiveText = executiveXml.replace(/<[^>]+>/gu, '');
    assert.match(executiveText, /第一部.*意思決定・対応用サマリー/u);
    assert.match(executiveText, /攻撃者が具体的にできること/u);
    assert.match(executiveText, /F-001/u);
    assert.doesNotMatch(executiveText, /GET \/account\?id=102 HTTP\/1\.1|HTTP\/1\.1 200 OK/u);

    const technicalAnnexHtml = renderTechnicalAnnexHtml(report).toString('utf8');
    assert.match(technicalAnnexHtml, /^<!doctype html>/u);
    assert.match(technicalAnnexHtml, /position: fixed/u, '固定ナビゲーションを持つ');
    assert.match(technicalAnnexHtml, /id="finding-index"/u, '指摘索引を持つ');
    assert.match(technicalAnnexHtml, /href="#finding-1"[^>]*>F-001<\/a>/u, '索引から指摘詳細へ移動できる');
    assert.match(technicalAnnexHtml, /id="finding-1-http-1"/u, 'HTTP証跡にアンカーを持つ');
    assert.match(technicalAnnexHtml, /GET \/account\?id=102 HTTP\/1\.1/u);
    assert.match(technicalAnnexHtml, /HTTP\/1\.1 200 OK/u);
    assert.doesNotMatch(technicalAnnexHtml, /COOKIE_SECRET|AUTH_SECRET|RESPONSE_SECRET/u);
    assert.match(technicalAnnexHtml, /<mark>102<\/mark>/u, '着目語を強調する');

    const emptyProfileReport = buildAssuranceReport({
      ...input,
      profile: {
        ...DEFAULT_REPORT_PROFILE,
        version: '', documentStatus: '', classification: '', assessmentType: '',
        systemName: '', clientName: '', author: '', reviewer: '', approver: '', distribution: '',
        conclusion: '', contact: '',
      },
    });
    assert.equal(emptyProfileReport.report.version, '未入力');
    assert.equal(emptyProfileReport.report.status, '未入力');
    assert.equal(emptyProfileReport.engagement.clientName, '未入力');
    assert.match(emptyProfileReport.summary.conclusion, /件の所見を報告します/u);

    const bodyOmittedReport = buildAssuranceReport({
      ...input,
      profile: { ...input.profile, evidenceBodyMode: 'omit', highlightEvidence: false },
    });
    const omittedResponse = bodyOmittedReport.findings[0]?.technicalEvidence.response ?? '';
    assert.match(omittedResponse, /HTTP\/1\.1 200 OK[\s\S]*Body省略: \d+文字/u);
    assert.doesNotMatch(omittedResponse, /"customer"|xxxxxxxx|yyyyyyyy/u);
    const bodyOmittedWord = await renderAssuranceReport(bodyOmittedReport);
    const bodyOmittedArchive = await JSZip.loadAsync(bodyOmittedWord);
    const bodyOmittedXml = await bodyOmittedArchive.file('word/document.xml')?.async('string');
    assert.doesNotMatch(bodyOmittedXml ?? '', /<w:highlight /u);

    const aiReport = buildAssuranceReport({
      ...input,
      findingNarratives: [{
        findingId: 'F-001',
        summary: '注文参照APIのオブジェクト単位認可が不足し、ログイン中の利用者が他者の注文情報を取得できます。',
        conditions: 'memberロールでGET /accountのidを他利用者の識別子へ変更した場合に、所有者照合なしで200応答が返ると成立します。',
        cause: '推定として、AccountServiceがidだけで注文を検索し、セッションの利用者IDを検索条件へ追加していない可能性があります。共通認可middlewareを経由しない経路である可能性もあります。',
        reproductionSteps: [
          'memberロールで https://shop.example.test/account?id=QUERY_SECRET#detail にアクセスします。',
          'GET /account?id=102 HTTP/1.1 を送信し、Responseのcustomer.idが102であることを確認します。',
        ],
        remediation: 'AccountServiceの検索条件へ必ずsession.userIdを追加し、idだけでレコードを取得しないようにします。管理者向け経路は別の認可ポリシーで明示的に許可します。',
        verificationCriteria: '別利用者のidでは403または404となり、自分のidでは200となることを確認します。',
      }],
    });
    assert.match(aiReport.findings[0]?.summary ?? '', /注文参照API/u);
    assert.match(aiReport.findings[0]?.cause ?? '', /AccountService/u);
    assert.match(aiReport.findings[0]?.cause ?? '', /観測事実:.*推定原因:/su);
    assert.match(aiReport.findings[0]?.remediation.permanent ?? '', /AccountService/u);

    const qaDirectory = process.env.SCOPEPILOT_REPORT_V2_QA;
    if (qaDirectory !== undefined && qaDirectory.trim() !== '') {
      await mkdir(qaDirectory, { recursive: true });
      await writeFile(join(qaDirectory, 'ScopePilot2-report-v2-QA.docx'), word);
      await writeFile(join(qaDirectory, 'ScopePilot2-report-v2-technical-annex-QA.html'), renderTechnicalAnnexHtml(report));
      await writeFile(join(qaDirectory, 'ScopePilot2-report-v2-QA.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
  });


  test('不足するレスポンスヘッダを脆弱性の根拠として明示する', async () => {
    const report = buildAssuranceReport({
      reportId: 'report-missing-csp', modelHash: 'e'.repeat(64), startUrl: 'https://shop.example.test/', forbiddenActions: [],
      profile: DEFAULT_REPORT_PROFILE,
      model: {
        caseId: 'case-header', generatedAt: '2026-10-24T00:00:00.000Z', guidelines: [],
        assessmentScope: { caseName: 'Header test', allowedOrigins: ['https://shop.example.test'], deniedOrigins: [], limits: { maxRequests: 10, maxPages: 10, maxDurationMinutes: 10 } },
        coverage: { exploredUrlCount: 1, scannedUrlCount: 1, delegatedSteps: [], limitations: [] },
        findings: [{
          findingId: 'F-CSP', title: 'Content Security Policy (CSP) Header Not Set',
          source: { kind: 'zap-alert', engineVersion: '2.17.0', unverified: true }, url: 'https://shop.example.test/dashboard', method: 'GET',
          severity: 'medium', status: 'candidate', evidenceRefs: ['evidence-csp'], firstSeenAt: '2026-10-24T00:00:00.000Z',
          lastSeenAt: '2026-10-24T00:00:00.000Z', occurrences: 1, enginePluginId: '10038',
        }],
      },
      evidence: [{ evidenceId: 'evidence-csp', label: 'zap-alerts-raw:test', sha256: 'f'.repeat(64), savedAt: '2026-10-24T00:00:00.000Z', metadata: { mediaType: 'application/json' } }],
      evidenceContents: { 'evidence-csp': JSON.stringify({ alerts: [{
        pluginId: '10038', name: 'Content Security Policy (CSP) Header Not Set', url: 'https://shop.example.test/dashboard', method: 'GET',
        requestHeader: 'GET /dashboard HTTP/1.1\r\nHost: shop.example.test\r\nCookie: session=live-session-token', requestBody: '',
        responseHeader: 'HTTP/1.1 200 OK\r\nContent-Type: text/html', responseBody: '<html><body>Dashboard</body></html>',
      }] }) },
    });
    assert.deepEqual(report.findings[0]?.technicalEvidence.responseDeficiencies, ['レスポンスに Content-Security-Policy ヘッダがありません。']);
    assert.match(report.findings[0]?.summary ?? '', /Content-Security-Policy ヘッダがありません/u);
    assert.match(report.findings[0]?.cause ?? '', /Content-Security-Policy ヘッダがありません/u);
    assert.match(report.findings[0]?.cause ?? '', /共通レスポンス処理/u);
    assert.match(report.findings[0]?.technicalEvidence.request ?? '', /Cookie: session=\[redacted\]/u);
    assert.doesNotMatch(report.findings[0]?.technicalEvidence.request ?? '', /live-session-token/u);
    const word = await renderAssuranceReport(report);
    const archive = await JSZip.loadAsync(word);
    const xml = await archive.file('word/document.xml')?.async('string');
    assert.match(xml ?? '', /確認結果: レスポンスに Content-Security-Policy ヘッダがありません/u);
    assert.match(xml ?? '', /原因[\s\S]*共通レスポンス処理/u);
  });

  test('URLだけが異なる同一現象を1件へ統合し、全URLとURL別HTTP証跡を保持する', async () => {
    const targets = [
      { id: 'F-CLICK-1', url: 'https://shop.example.test/xss_r/?name=alice', path: '/xss_r/?name=alice', param: 'name', evidenceId: 'evidence-click-1' },
      { id: 'F-CLICK-2', url: 'https://shop.example.test/hoge/?foot=1', path: '/hoge/?foot=1', param: 'foot', evidenceId: 'evidence-click-2' },
      { id: 'F-CLICK-3', url: 'https://shop.example.test/fuga/?bar=2', path: '/fuga/?bar=2', param: 'bar', evidenceId: 'evidence-click-3' },
      { id: 'F-CLICK-4', url: 'https://shop.example.test/piyo/?baz=3', path: '/piyo/?baz=3', param: 'baz', evidenceId: 'evidence-click-4' },
    ] as const;
    const report = buildAssuranceReport({
      reportId: 'report-multi-url', modelHash: '9'.repeat(64), startUrl: 'https://shop.example.test/', forbiddenActions: [],
      profile: DEFAULT_REPORT_PROFILE,
      model: {
        caseId: 'case-multi-url', generatedAt: '2026-10-24T01:00:00.000Z', guidelines: [],
        assessmentScope: { caseName: '同一現象統合テスト', allowedOrigins: ['https://shop.example.test'], deniedOrigins: [], limits: { maxRequests: 20, maxPages: 20, maxDurationMinutes: 10 } },
        coverage: { exploredUrlCount: 4, scannedUrlCount: 4, delegatedSteps: [], limitations: [] },
        findings: targets.map((target, index) => ({
          findingId: target.id,
          title: 'Anti-clickjacking Header Missing',
          source: { kind: 'zap-alert' as const, engineVersion: '2.17.0', unverified: true },
          url: target.url,
          method: 'GET',
          param: target.param,
          severity: 'medium' as const,
          status: 'candidate' as const,
          evidenceRefs: [target.evidenceId],
          firstSeenAt: `2026-10-24T01:0${String(index)}:00.000Z`,
          lastSeenAt: `2026-10-24T01:1${String(index)}:00.000Z`,
          occurrences: 1,
          enginePluginId: '10020',
        })),
      },
      evidence: targets.map((target, index) => ({
        evidenceId: target.evidenceId,
        label: `zap-alerts-raw:${String(index + 1)}`,
        sha256: String(index + 1).repeat(64),
        savedAt: `2026-10-24T01:0${String(index)}:00.000Z`,
        metadata: { mediaType: 'application/json' },
      })),
      evidenceContents: Object.fromEntries(targets.map((target) => [target.evidenceId, JSON.stringify({ alerts: [{
        pluginId: '10020',
        name: 'Anti-clickjacking Header Missing',
        url: target.url,
        method: 'GET',
        param: target.param,
        description: 'The response does not include either Content-Security-Policy with frame-ancestors or X-Frame-Options.',
        requestHeader: `GET ${target.path} HTTP/1.1\r\nHost: shop.example.test`,
        requestBody: '',
        responseHeader: 'HTTP/1.1 200 OK\r\nContent-Type: text/html',
        responseBody: `<html><body>${target.id}</body></html>`,
      }] })])),
    });

    assert.equal(report.findings.length, 1);
    assert.deepEqual(report.findings[0]?.urls, targets.map((target) => target.url));
    assert.deepEqual(report.findings[0]?.sourceFindingIds, targets.map((target) => target.id));
    assert.equal(report.findings[0]?.occurrences, 4);
    assert.equal(report.findings[0]?.technicalEvidenceByUrl.length, 4);
    assert.deepEqual(report.summary.severityCounts, { Medium: 1 });
    assert.ok(report.evidence.every((item) => item.relatedFindingIds.length === 1 && item.relatedFindingIds[0] === 'F-CLICK-1'));
    for (const [index, target] of targets.entries()) {
      assert.equal(report.findings[0]?.technicalEvidenceByUrl[index]?.url, target.url);
      assert.match(report.findings[0]?.technicalEvidenceByUrl[index]?.technicalEvidence.request ?? '', new RegExp(`GET ${target.path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} HTTP/1\\.1`, 'u'));
    }
    const markdown = appendAssuranceHttpEvidenceMarkdown('# 診断報告書\n\n## 所見 (4件)\n\n未統合一覧', report);
    assert.doesNotMatch(markdown, /未統合一覧/u);
    assert.match(markdown, /指摘の再現情報（同一現象をURL単位で統合）/u);
    for (const target of targets) assert.match(markdown, new RegExp(target.url.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

    const word = await renderAssuranceReport(report);
    const archive = await JSZip.loadAsync(word);
    const xml = await archive.file('word/document.xml')?.async('string') ?? '';
    for (const target of targets) {
      assert.match(xml, new RegExp(target.url.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
      assert.match(xml, new RegExp(target.path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    }
    assert.match(xml, /診断時HTTP証跡 4 \/ 4/u);

    const qaDirectory = process.env.SCOPEPILOT_REPORT_V2_QA;
    if (qaDirectory !== undefined && qaDirectory.trim() !== '') {
      await mkdir(qaDirectory, { recursive: true });
      await writeFile(join(qaDirectory, 'ScopePilot2-report-multi-url-QA.docx'), word);
      await writeFile(join(qaDirectory, 'ScopePilot2-report-multi-url-QA.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
  });

  test('同一脆弱性はHTTPメソッドやパラメータが異なっても1件へ統合する', () => {
    const makeFinding = (id: string, url: string, param: string, evidenceId: string) => ({
      findingId: id, title: 'Cross Site Scripting (Reflected)',
      source: { kind: 'zap-alert' as const, engineVersion: '2.17.0', unverified: true }, url, method: 'GET', param,
      severity: 'high' as const, status: 'candidate' as const, evidenceRefs: [evidenceId], firstSeenAt: '2026-10-24T00:00:00.000Z',
      lastSeenAt: '2026-10-24T00:00:00.000Z', occurrences: 1, enginePluginId: '40012',
    });
    const makeEvidence = (url: string, param: string, attack: string) => JSON.stringify({ alerts: [{
      pluginId: '40012', url, method: 'GET', param, attack, evidenceSummary: attack,
      requestHeader: `GET /search?${param}=${encodeURIComponent(attack)} HTTP/1.1\r\nHost: shop.example.test`,
      responseHeader: 'HTTP/1.1 200 OK\r\nContent-Type: text/html', responseBody: attack,
    }] });
    const report = buildAssuranceReport({
      reportId: 'report-distinct-input', modelHash: '8'.repeat(64), startUrl: 'https://shop.example.test/', forbiddenActions: [], profile: DEFAULT_REPORT_PROFILE,
      model: {
        caseId: 'case-distinct-input', generatedAt: '2026-10-24T00:00:00.000Z', guidelines: [],
        assessmentScope: { caseName: '非統合テスト', allowedOrigins: ['https://shop.example.test'], deniedOrigins: [], limits: { maxRequests: 10, maxPages: 10, maxDurationMinutes: 10 } },
        coverage: { exploredUrlCount: 2, scannedUrlCount: 2, delegatedSteps: [], limitations: [] },
        findings: [
          makeFinding('F-XSS-1', 'https://shop.example.test/search?q=one', 'q', 'e-xss-1'),
          makeFinding('F-XSS-2', 'https://shop.example.test/search?keyword=two', 'keyword', 'e-xss-2'),
        ],
      },
      evidence: [
        { evidenceId: 'e-xss-1', label: 'zap:1', sha256: '1'.repeat(64), savedAt: '2026-10-24T00:00:00.000Z', metadata: { mediaType: 'application/json' } },
        { evidenceId: 'e-xss-2', label: 'zap:2', sha256: '2'.repeat(64), savedAt: '2026-10-24T00:00:00.000Z', metadata: { mediaType: 'application/json' } },
      ],
      evidenceContents: {
        'e-xss-1': makeEvidence('https://shop.example.test/search?q=one', 'q', '<svg/onload=alert(1)>'),
        'e-xss-2': makeEvidence('https://shop.example.test/search?keyword=two', 'keyword', '<img src=x onerror=alert(1)>'),
      },
    });
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]?.parameter, 'q / keyword');
    assert.equal(report.findings[0]?.technicalEvidenceByUrl.length, 2);
    assert.equal(report.findings[0]?.technicalEvidenceByUrl[0]?.method, 'GET');
    assert.equal(report.findings[0]?.technicalEvidenceByUrl[1]?.parameter, 'keyword');
  });

  test('同一指摘を集約し、成立状態を出さずHTTP証跡ごとの自動根拠を保持する', () => {
    const finding = (id: string, param: string, evidenceId: string) => ({
      findingId: id, title: 'SQL Injection', source: { kind: 'zap-alert' as const, engineVersion: '2.17.0', unverified: true },
      url: `https://shop.example.test/search?${param}=x`, method: 'GET', param, severity: 'high' as const,
      status: 'candidate' as const, evidenceRefs: [evidenceId], firstSeenAt: '2026-10-24T00:00:00.000Z',
      lastSeenAt: '2026-10-24T00:00:00.000Z', occurrences: 1, enginePluginId: '40018',
    });
    const evidence = (param: string, attack: string, body: string) => JSON.stringify({ alerts: [{
      pluginId: '40018', url: `https://shop.example.test/search?${param}=x`, method: 'GET', param, attack,
      evidenceSummary: body, requestHeader: `GET /search?${param}=x HTTP/1.1\r\nHost: shop.example.test`,
      responseHeader: 'HTTP/1.1 200 OK\r\nContent-Type: text/html', responseBody: body,
    }] });
    const report = buildAssuranceReport({
      reportId: 'mixed-verdict', modelHash: '9'.repeat(64), startUrl: 'https://shop.example.test/', forbiddenActions: [], profile: DEFAULT_REPORT_PROFILE,
      model: {
        caseId: 'mixed', generatedAt: '2026-10-24T00:00:00.000Z', guidelines: [],
        assessmentScope: { caseName: 'mixed', allowedOrigins: ['https://shop.example.test'], deniedOrigins: [], limits: { maxRequests: 10, maxPages: 10, maxDurationMinutes: 10 } },
        coverage: { exploredUrlCount: 2, scannedUrlCount: 2, delegatedSteps: [], limitations: [] },
        findings: [finding('F-SQL-1', 'id', 'e-sql-1'), finding('F-SQL-2', 'submit', 'e-sql-2')],
      },
      evidence: [
        { evidenceId: 'e-sql-1', label: 'zap:1', sha256: '1'.repeat(64), savedAt: '2026-10-24T00:00:00.000Z', metadata: { mediaType: 'application/json' } },
        { evidenceId: 'e-sql-2', label: 'zap:2', sha256: '2'.repeat(64), savedAt: '2026-10-24T00:00:00.000Z', metadata: { mediaType: 'application/json' } },
      ],
      evidenceContents: {
        'e-sql-1': evidence('id', "'", 'SQL syntax error near quote'),
        'e-sql-2': evidence('submit', 'Search', 'Search'),
      },
    });
    assert.equal(report.findings.length, 1);
    assert.doesNotMatch(JSON.stringify(report), /"(?:validationStatus|humanReview|validationCounts)"/u);
    assert.match(report.findings[0]?.technicalEvidenceByUrl[0]?.automatedRationale ?? '', /SQL syntax error/u);
    assert.match(report.findings[0]?.technicalEvidenceByUrl[1]?.automatedRationale ?? '', /入力反射または操作用パラメータ/u);
  });

  test('診断時のRequestまたはResponseがない指摘を報告書として生成しない', () => {
    assert.throws(() => buildAssuranceReport({
      reportId: 'report-missing-http',
      modelHash: 'c'.repeat(64),
      startUrl: 'https://shop.example.test/',
      forbiddenActions: [],
      profile: DEFAULT_REPORT_PROFILE,
      model: {
        caseId: 'case-missing-http', generatedAt: '2026-10-24T00:00:00.000Z', guidelines: [],
        assessmentScope: {
          caseName: 'HTTP証跡完全性テスト', allowedOrigins: ['https://shop.example.test'], deniedOrigins: [],
          limits: { maxRequests: 10, maxPages: 10, maxDurationMinutes: 10 },
        },
        coverage: { exploredUrlCount: 1, scannedUrlCount: 1, delegatedSteps: [], limitations: [] },
        findings: [{
          findingId: 'F-MISSING', title: 'HTTP証跡がない候補',
          source: { kind: 'zap-alert', engineVersion: '2.17.0', unverified: true },
          url: 'https://shop.example.test/account', method: 'GET', severity: 'high', status: 'candidate',
          evidenceRefs: ['evidence-missing'], firstSeenAt: '2026-10-24T00:00:00.000Z',
          lastSeenAt: '2026-10-24T00:00:00.000Z', occurrences: 1, enginePluginId: '40001',
        }],
      },
      evidence: [{
        evidenceId: 'evidence-missing', label: 'zap-alerts-raw:test', sha256: 'd'.repeat(64),
        savedAt: '2026-10-24T00:00:00.000Z', metadata: { mediaType: 'application/json' },
      }],
      evidenceContents: {
        'evidence-missing': JSON.stringify({ alerts: [{
          pluginId: '40001', url: 'https://shop.example.test/account',
          requestHeader: 'HTTP通信は未収集です',
        }] }),
      },
    }), /指摘 F-MISSING.*Request \/ Responseがありません/u);
  });
});
