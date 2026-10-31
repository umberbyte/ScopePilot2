import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { DesktopWorkspaceManager } from '../../src/main/workspace.ts';
import { DEFAULT_REPORT_PROFILE } from '../../src/main/assurance-report.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop case workspace', () => {
  test('案件DBと標準ディレクトリを作り、資料をSHA-256付きでinputsへ複製して再オープンできる', async () => {
    const base = await mkdtemp(join(tmpdir(), 'scopepilot2-workspace-'));
    roots.push(base);
    const caseDirectory = join(base, 'case-a');
    const source = join(base, 'director-notes.txt');
    const sameContentSource = join(base, 'director-notes-copy.txt');
    await writeFile(source, 'scope and operation notes', 'utf8');
    await writeFile(sameContentSource, 'scope and operation notes', 'utf8');
    const manager = new DesktopWorkspaceManager();
    const settings = {
      startUrl: 'https://example.test/start',
      supportingOrigins: ['https://id.example.test'],
      targetRoles: ['unauthenticated', 'member'],
      forbiddenActions: ['delete'],
      aiProvider: 'codex' as const,
      aiModel: '',
    };

    const first = await manager.activate(caseDirectory, [source, sameContentSource], settings, 'create');
    assert.equal(first.existingCase, null);
    assert.equal(first.inputs.length, 2);
    assert.notEqual(first.inputs[0]?.inputId, first.inputs[1]?.inputId, '同一内容・別名の資料は異なる入力IDを持つ');
    assert.match(first.inputs[0]?.sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(await readFile(join(caseDirectory, first.inputs[0]!.relativePath), 'utf8'), 'scope and operation notes');
    assert.equal(first.settings.startUrl, settings.startUrl);
    const httpEvidence = await manager.repositories()!.evidence.saveText('zap-alerts-raw:fixture', JSON.stringify({ alerts: [{
      pluginId: '40001', url: 'https://example.test/profile?id=2', method: 'GET', param: 'id',
      requestHeader: 'GET /profile?id=2 HTTP/1.1\r\nHost: example.test\r\nCookie: session=secret', requestBody: '',
      responseHeader: 'HTTP/1.1 200 OK\r\nContent-Type: application/json', responseBody: '{"id":2}',
    }] }));
    const report = await manager.saveReport('# 診断報告書\n\n- 案件: case-a\n', 'model-hash-test', 'report-test', {
      caseId: 'case-a', generatedAt: '2026-10-23T00:00:00.000Z', guidelines: ['OWASP WSTG 4.2'], findings: [{
        findingId: 'F-001', title: '他利用者情報の参照', source: { kind: 'zap-alert', engineVersion: '2.17.0', unverified: true },
        url: 'https://example.test/profile?id=2', method: 'GET', param: 'id', severity: 'high', status: 'candidate',
        evidenceRefs: [httpEvidence.evidenceId], firstSeenAt: '2026-10-23T00:00:00.000Z', lastSeenAt: '2026-10-23T00:00:00.000Z',
        occurrences: 1, enginePluginId: '40001',
      }],
      coverage: { exploredUrlCount: 1, scannedUrlCount: 1, delegatedSteps: [], limitations: ['fixture limitation'] },
      assessmentScope: {
        caseName: 'case-a', allowedOrigins: ['https://example.test'], deniedOrigins: [],
        limits: { maxRequests: 10, maxPages: 10, maxDurationMinutes: 10 },
      },
    }, { ...DEFAULT_REPORT_PROFILE, systemName: 'サンプルシステム', clientName: 'サンプル株式会社' }, [{
      findingId: 'F-001',
      summary: '選択されたAIが作成した、他利用者情報の参照につながる認可不備の具体的な概要です。',
      conditions: 'memberロールで GET https://example.test/profile?id=2 を送信し、所有者確認がない場合に成立します。',
      cause: '推定として、ProfileServiceがプロフィールIDだけを検索条件に使用し、セッションの利用者IDによる所有者条件を追加していない可能性があります。',
      reproductionSteps: [
        'memberロールで https://example.test/profile?id=2 を開きます。',
        'GET /profile?id=2 HTTP/1.1 をCookie付きで送信します。',
      ],
      remediation: 'ProfileServiceでセッションの利用者IDと対象プロフィールの所有者IDを照合し、不一致の場合は403を返してください。',
      verificationCriteria: '別利用者のIDでは403となり、自分のIDでは200となることを確認します。',
    }]);
    const markdown = await readFile(report.markdownPath, 'utf8');
    assert.match(markdown, /^# 診断報告書\n\n- 案件: case-a/mu);
    assert.match(markdown, /### F-001 他利用者情報の参照[\s\S]*GET \/profile\?id=2 HTTP\/1\.1/u);
    assert.match(markdown, /\*\*観測した Response\*\*[\s\S]*HTTP\/1\.1 200 OK/u);
    assert.match(markdown, /session=\[redacted\]/u);
    assert.doesNotMatch(markdown, /session=secret/u);
    assert.equal((await readFile(report.wordPath)).subarray(0, 2).toString('ascii'), 'PK', 'DOCXはZIPコンテナで生成する');
    const technicalAnnexHtml = await readFile(report.technicalAnnexHtmlPath, 'utf8');
    assert.match(technicalAnnexHtml, /^<!doctype html>/u, '技術証跡別冊はHTMLで生成する');
    assert.match(technicalAnnexHtml, /position: fixed/u, '技術証跡別冊は固定ナビゲーションを持つ');
    assert.match(technicalAnnexHtml, /href="#finding-1"/u, '指摘索引から詳細へ移動できる');
    assert.match(technicalAnnexHtml, /GET \/profile\?id=2 HTTP\/1\.1/u);
    assert.doesNotMatch(technicalAnnexHtml, /session=secret/u);
    const manifest = JSON.parse(await readFile(report.manifestPath, 'utf8')) as {
      modelHash: string;
      counts: { executiveFindingFamilies: number; technicalFindings: number };
      artifacts: readonly { role: string; fileName: string; sha256: string }[];
    };
    assert.equal(manifest.modelHash, 'model-hash-test');
    assert.equal(manifest.counts.executiveFindingFamilies, 1);
    assert.equal(manifest.counts.technicalFindings, 1);
    assert.deepEqual(manifest.artifacts.map((artifact) => artifact.role), ['executive-report', 'technical-annex', 'technical-markdown', 'structured-report']);
    assert.match(manifest.artifacts.find((artifact) => artifact.role === 'technical-annex')?.fileName ?? '', /-technical-annex\.html$/u);
    assert.ok(manifest.artifacts.every((artifact) => /^[0-9a-f]{64}$/u.test(artifact.sha256)));
    const structured = JSON.parse(await readFile(report.structuredJsonPath, 'utf8')) as {
      templateId: string;
      engagement: { systemName: string };
      findings: readonly { summary: string; cause: string; technicalEvidence: { request: string; response: string } }[];
    };
    assert.equal(structured.templateId, 'scopepilot2-assurance-ja-v2');
    assert.equal(structured.engagement.systemName, 'サンプルシステム');
    assert.match(structured.findings[0]?.summary ?? '', /選択されたAIが作成した/u);
    assert.match(structured.findings[0]?.cause ?? '', /ProfileService/u);
    assert.match(structured.findings[0]?.technicalEvidence.request ?? '', /^GET \/profile\?id=2 HTTP\/1\.1/mu);
    assert.match(structured.findings[0]?.technicalEvidence.response ?? '', /^HTTP\/1\.1 200 OK/mu);
    assert.match(structured.findings[0]?.technicalEvidence.request ?? '', /session=\[redacted\]/u);
    assert.doesNotMatch(structured.findings[0]?.technicalEvidence.request ?? '', /session=secret/u);
    manager.close();

    const resumed = new DesktopWorkspaceManager();
    const resumedWorkspace = await resumed.activate(caseDirectory, [], settings, 'create');
    assert.equal(resumedWorkspace.existingCase, null, '案件作成前に入力検証で失敗したworkspaceは同じフォルダで再開できる');
    resumed.repositories()!.cases.save({
      caseId: 'case-reopen',
      name: 'case-a',
      revision: 1,
      scope: { allowedOrigins: ['https://example.test'], deniedOrigins: [], limits: { maxRequests: 10, maxPages: 10, maxDurationMinutes: 10 } },
      createdAt: new Date().toISOString(),
    });
    resumed.close();

    const reopened = new DesktopWorkspaceManager();
    const second = await reopened.activate(caseDirectory, [], {
      ...settings,
      startUrl: 'https://overwrite.invalid/',
      aiProvider: 'claude',
      aiModel: 'sonnet',
    }, 'open');
    assert.equal(second.settings.startUrl, settings.startUrl, '既存案件の保存済み設定を選択時の既定値で上書きしない');
    assert.equal(second.settings.aiProvider, 'claude', 'AI選択は案件設定ではなくアプリ共通選択を反映する');
    assert.equal(second.settings.aiModel, 'sonnet');
    assert.equal(second.inputs.length, 2);
    const updated = reopened.updateSettings({
      ...settings,
      startUrl: 'https://example.test/updated-start',
      allowedOrigins: ['https://example.test'],
    });
    assert.equal(updated.settings.startUrl, 'https://example.test/updated-start');
    assert.deepEqual(updated.existingCase?.scope.allowedOrigins, ['https://example.test']);
    const originalInput = second.inputs.find((input) => input.originalName === 'director-notes.txt')!;
    const importedPath = join(caseDirectory, originalInput.relativePath);
    const remaining = await reopened.removeInput(originalInput.inputId);
    assert.equal(remaining.length, 1);
    await assert.rejects(readFile(importedPath));
    const reimported = await reopened.importInputs([source]);
    assert.equal(reimported.length, 2);
    assert.equal(await readFile(join(caseDirectory, reimported.find((input) => input.originalName === 'director-notes.txt')!.relativePath), 'utf8'), 'scope and operation notes');
    reopened.close();

    const verified = new DesktopWorkspaceManager();
    const persisted = await verified.activate(caseDirectory, [], settings, 'open');
    assert.equal(persisted.settings.startUrl, 'https://example.test/updated-start');
    assert.deepEqual(persisted.existingCase?.scope.allowedOrigins, ['https://example.test']);
    assert.equal(persisted.inputs.length, 2);
    verified.close();
  });

  test('HTTP証跡が不完全なら提出用ファイルを一つも作らない', async () => {
    const base = await mkdtemp(join(tmpdir(), 'scopepilot2-workspace-report-gate-'));
    roots.push(base);
    const caseDirectory = join(base, 'case-http-gate');
    const manager = new DesktopWorkspaceManager();
    await manager.activate(caseDirectory, [], {
      startUrl: 'https://example.test/', supportingOrigins: [], targetRoles: ['unauthenticated'],
      forbiddenActions: [], aiProvider: 'codex', aiModel: '',
    }, 'create');

    await assert.rejects(manager.saveReport('# report', 'model-hash', 'report-http-gate', {
      caseId: 'case-http-gate', generatedAt: '2026-10-24T00:00:00.000Z', guidelines: [],
      assessmentScope: {
        caseName: 'HTTP証跡完全性テスト', allowedOrigins: ['https://example.test'], deniedOrigins: [],
        limits: { maxRequests: 10, maxPages: 10, maxDurationMinutes: 10 },
      },
      coverage: { exploredUrlCount: 1, scannedUrlCount: 1, delegatedSteps: [], limitations: [] },
      findings: [{
        findingId: 'F-NO-HTTP', title: '通信が保存されていない候補',
        source: { kind: 'zap-alert', engineVersion: '2.17.0', unverified: true },
        url: 'https://example.test/account', method: 'GET', severity: 'high', status: 'candidate',
        evidenceRefs: [], firstSeenAt: '2026-10-24T00:00:00.000Z', lastSeenAt: '2026-10-24T00:00:00.000Z',
        occurrences: 1, enginePluginId: '40001',
      }],
    }, DEFAULT_REPORT_PROFILE), /指摘 F-NO-HTTP.*Request.*Responseがありません/u);

    assert.deepEqual(await readdir(join(caseDirectory, 'reports')), []);
    manager.close();
  });

  test('旧診断のHTTP証跡をZAP履歴から回収して案件へ保存する', async () => {
    const base = await mkdtemp(join(tmpdir(), 'scopepilot2-workspace-report-recovery-'));
    roots.push(base);
    const caseDirectory = join(base, 'case-http-recovery');
    let recoveryCalls = 0;
    const manager = new DesktopWorkspaceManager(async (lookups) => {
      recoveryCalls += 1;
      assert.equal(lookups.length, 1);
      return [{
        pluginId: '40001', name: 'Recovered alert', url: lookups[0]!.url,
        recoveredFromUrl: lookups[0]!.url, method: 'GET', messageId: '501', recoveryStrategy: 'alert-exact',
        requestHeader: 'GET https://example.test/account HTTP/1.1\r\nHost: example.test\r\nCookie: session=secret',
        responseHeader: 'HTTP/1.1 200 OK\r\nContent-Type: text/html', responseBody: '<html>account</html>',
      }];
    });
    await manager.activate(caseDirectory, [], {
      startUrl: 'https://example.test/', supportingOrigins: [], targetRoles: ['unauthenticated'],
      forbiddenActions: [], aiProvider: 'codex', aiModel: '',
    }, 'create');
    const model = {
      caseId: 'case-http-recovery', generatedAt: '2026-10-24T00:00:00.000Z', guidelines: [],
      assessmentScope: {
        caseName: 'HTTP証跡回収テスト', allowedOrigins: ['https://example.test'], deniedOrigins: [],
        limits: { maxRequests: 10, maxPages: 10, maxDurationMinutes: 10 },
      },
      coverage: { exploredUrlCount: 1, scannedUrlCount: 1, delegatedSteps: [], limitations: [] },
      findings: [{
        findingId: 'F-RECOVER', title: '旧形式の候補',
        source: { kind: 'zap-alert' as const, engineVersion: '2.17.0', unverified: true },
        url: 'https://example.test/account', method: 'GET', severity: 'high' as const, status: 'candidate' as const,
        evidenceRefs: [], firstSeenAt: '2026-10-24T00:00:00.000Z', lastSeenAt: '2026-10-24T00:00:00.000Z',
        occurrences: 1, enginePluginId: '40001',
      }],
    };

    const first = await manager.saveReport('# report', 'model-hash', 'report-http-recovery', model, DEFAULT_REPORT_PROFILE);
    const structured = JSON.parse(await readFile(first.structuredJsonPath, 'utf8')) as {
      findings: readonly { technicalEvidence: { request: string; response: string; collectionStatus: string } }[];
    };
    assert.match(structured.findings[0]?.technicalEvidence.request ?? '', /^GET https:\/\/example\.test\/account HTTP\/1\.1/mu);
    assert.match(structured.findings[0]?.technicalEvidence.response ?? '', /^HTTP\/1\.1 200 OK/mu);
    assert.match(structured.findings[0]?.technicalEvidence.request ?? '', /session=\[redacted\]/u);
    assert.doesNotMatch(structured.findings[0]?.technicalEvidence.request ?? '', /session=secret/u);
    assert.match(structured.findings[0]?.technicalEvidence.collectionStatus ?? '', /ZAPの保存済みHTTP履歴/u);
    assert.equal(manager.repositories()!.evidence.list().filter((item) => item.label === 'report-http-recovery:F-RECOVER').length, 1);

    await manager.saveReport('# report', 'model-hash', 'report-http-recovery-2', model, DEFAULT_REPORT_PROFILE);
    assert.equal(recoveryCalls, 1, '保存済みの回収証跡を再利用し、ZAPへ重複照会しない');
    manager.close();
  });
});

