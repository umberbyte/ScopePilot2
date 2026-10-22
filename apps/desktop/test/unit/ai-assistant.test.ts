import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AiInvocationRepository, migrate, openDatabase } from '@scopepilot2/storage';
import { DesktopAiAssistant, parseAiJson, type AiCommandRunner } from '../../src/main/ai-assistant.ts';

describe('desktop AI assistant', () => {
  test('CLIのJSON envelopeとfenced JSONを抽出できる', () => {
    assert.deepEqual(parseAiJson('{"result":"{\\"documents\\":[]}"}'), { documents: [] });
    assert.deepEqual(parseAiJson('answer\n```json\n{"documents":[]}\n```'), { documents: [] });
  });

  test('文書解析をscope・秘密値フィルターへ通し、報告原本を保持して監査記録する', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const invocations = new AiInvocationRepository(db);
    const outputs = [
      {
        structured_output: {
          documents: [{
            sourceId: 'input-1',
            summary: '管理画面とAPI仕様。password=hunter2',
            urls: ['https://app.example.test/admin?token=secret', 'https://outside.test/'],
            authHints: [{ role: 'admin', authMethod: 'Form', documentLocation: 'p.2 password=hunter2' }],
            priorityRules: [{ urlIncludes: '/payment', category: 'payment' }],
            parameters: [{ name: 'mode', values: ['summary', 'detail'] }, { name: 'token', values: ['secret'] }],
            warnings: [],
          }],
        },
      },
      {
        structured_output: {
          executiveSummary: '確認済み原本に基づく概要です。',
          riskAssessment: '未確認項目を含むため担当者レビューが必要です。',
          recommendations: ['確認された所見に対応する修正を優先してください。'],
          limitations: ['AI文章案は要レビューです。'],
        },
      },
      {
        structured_output: {
          summary: 'DVWA security level Low',
          steps: [
            { kind: 'navigate', target: 'https://app.example.test/security.php', value: '' },
            { kind: 'select', target: 'select[name="security"]', value: 'low' },
            { kind: 'click', target: 'input[name="seclev_submit"]', value: '' },
            { kind: 'assertValue', target: 'select[name="security"]', value: 'low' },
          ],
          warnings: [],
        },
      },
      {
        structured_output: {
          summary: '保存型入力をブラウザーで確認する',
          items: [{
            track: 'workflow-state',
            targetUrl: 'https://app.example.test/comment',
            role: 'admin',
            roles: [],
            summary: 'マーカーを保存して再表示を確認する',
            steps: [
              { kind: 'navigate', target: 'https://app.example.test/comment', value: '', inputRef: '' },
              { kind: 'fill', target: 'textarea[name="comment"]', value: 'scopepilot-marker', inputRef: '' },
              { kind: 'click', target: 'button[type="submit"]', value: '', inputRef: '' },
              { kind: 'assert', target: 'scopepilot-marker', value: '', inputRef: '' },
            ],
            samples: 100,
            tokenSource: 'body',
            tokenName: '',
            expectation: 'different',
            requiredInputs: [],
          }],
          warnings: [],
        },
      },
    ];
    const configuredClaude = process.platform === 'win32' ? 'C:\\tools\\claude.exe' : '/tools/claude';
    const invokedExecutables: string[] = [];
    const invokedLaunchModes: string[] = [];
    const runner: AiCommandRunner = async (command) => {
      invokedExecutables.push(command.executable);
      invokedLaunchModes.push(command.launchMode ?? 'missing');
      return JSON.stringify(outputs.shift());
    };
    const assistant = new DesktopAiAssistant({
      directory: process.cwd(),
      settings: {
        startUrl: 'https://app.example.test/', supportingOrigins: [], targetRoles: ['admin'],
        forbiddenActions: ['delete'], aiProvider: 'claude', aiModel: 'test-model', updatedAt: '2026-10-20T00:00:00.000Z',
      },
      inputs: [{ inputId: 'input-1', relativePath: 'inputs/a.txt', originalName: 'manual.txt', sha256: 'a'.repeat(64), sizeBytes: 10, importedAt: '2026-10-20T00:00:00.000Z' }],
      allowedOrigins: ['https://app.example.test'],
      invocations,
      executablePaths: { claude: configuredClaude },
      launchModes: { claude: 'file' },
    }, runner);

    const analysis = await assistant.analyzeDocuments();
    assert.deepEqual(analysis.documents[0]?.urls, ['https://app.example.test/admin']);
    assert.equal(analysis.documents[0]?.summary, '管理画面とAPI仕様。password=[REDACTED]');
    assert.equal(analysis.documents[0]?.authHints[0]?.documentLocation, 'p.2 password=[REDACTED]');
    assert.deepEqual(analysis.documents[0]?.parameters, [{ name: 'mode', values: ['summary', 'detail'] }]);

    const report = await assistant.draftReport('# 診断報告書\n\n- 案件: case-1\n- URL: https://app.example.test/admin\n', 'base-hash', ['OWASP WSTG']);
    assert.match(report.content, /AIによるエグゼクティブサマリー/u);
    assert.match(report.content, /ScopePilot検証済み原本/u);
    assert.match(report.content, /案件: case-1/u);
    const browserPlan = await assistant.planBrowserActions('Open security.php, select Low, and submit.');
    assert.deepEqual(browserPlan.steps, [
      { kind: 'navigate', target: 'https://app.example.test/security.php' },
      { kind: 'select', target: 'select[name="security"]', value: 'low' },
      { kind: 'click', target: 'input[name="seclev_submit"]' },
      { kind: 'assertValue', target: 'select[name="security"]', value: 'low' },
    ]);
    assert.equal(browserPlan.expectedUrlPrefix, 'https://app.example.test');
    const interactivePlan = await assistant.planInteractiveDiagnostics({
      instruction: 'コメントを保存して再表示を確認してください',
      roles: ['admin'],
      candidates: [{
        url: 'https://app.example.test/comment',
        method: 'POST',
        diagnosticTracks: ['workflow-state'],
        inputPoints: [{ location: 'body', name: 'comment' }],
      }],
    });
    assert.equal(interactivePlan.items[0]?.track, 'workflow-state');
    assert.deepEqual(interactivePlan.items[0]?.steps[1], { kind: 'fill', target: 'textarea[name="comment"]', value: 'scopepilot-marker' });
    assert.deepEqual(invokedExecutables, [configuredClaude, configuredClaude, configuredClaude, configuredClaude]);
    assert.deepEqual(invokedLaunchModes, ['file', 'file', 'file', 'file']);
    assert.deepEqual(invocations.list().map((entry) => [entry.taskKind, entry.status]), [
      ['DocumentExtract', 'succeeded'],
      ['ReportDraft', 'succeeded'],
      ['BrowserActionPlan', 'succeeded'],
      ['InteractiveDiagnosticPlan', 'succeeded'],
    ]);
    db.close();
  });
});

