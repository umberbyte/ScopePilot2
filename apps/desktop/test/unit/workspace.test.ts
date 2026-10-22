import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { DesktopWorkspaceManager } from '../../src/main/workspace.ts';

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
    const report = await manager.saveReport('# 診断報告書\n\n- 案件: case-a\n', 'model-hash-test');
    assert.equal(await readFile(report.markdownPath, 'utf8'), '# 診断報告書\n\n- 案件: case-a\n');
    assert.equal((await readFile(report.wordPath)).subarray(0, 2).toString('ascii'), 'PK', 'DOCXはZIPコンテナで生成する');
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
});

