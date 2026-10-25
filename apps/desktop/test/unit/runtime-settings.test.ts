import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, test } from 'node:test';
import { RuntimeSettingsStore } from '../../src/main/runtime-settings.ts';
import { DEFAULT_AI_CLI_LAUNCH_MODES, type RuntimeToolPaths } from '../../src/shared/runtime-settings.ts';

async function fakeCommand(directory: string, name: string): Promise<string> {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const path = join(directory, `${name}${extension}`);
  await writeFile(path, 'test executable', 'utf8');
  return path;
}

describe('runtime settings', () => {
  test('PATH上のコマンドを初期値として検出する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scopepilot-runtime-'));
    try {
      const bin = join(root, 'bin');
      await mkdir(bin);
      const expected = {
        zcodeCli: await fakeCommand(bin, 'zcode-cli'),
        codexCli: await fakeCommand(bin, 'codex'),
        claudeCli: await fakeCommand(bin, 'claude'),
        zapExecutable: await fakeCommand(bin, 'ZAP'),
        nucleiExecutable: await fakeCommand(bin, 'nuclei'),
        nucleiTemplateManifest: '',
        playwrightExecutable: await fakeCommand(bin, 'playwright'),
      } satisfies RuntimeToolPaths;
      const store = new RuntimeSettingsStore({
        filePath: join(root, 'settings', 'runtime-tools.json'),
        applicationDirectory: root,
        pathValue: [bin, ''].join(delimiter),
      });

      const snapshot = await store.load();

      assert.deepEqual(snapshot.paths, expected);
      assert.ok(snapshot.tools.filter((tool) => tool.id !== 'nucleiTemplateManifest').every((tool) => tool.source === 'path' && tool.exists));
      assert.deepEqual(snapshot.tools.find((tool) => tool.id === 'nucleiTemplateManifest'), {
        id: 'nucleiTemplateManifest', path: '', source: 'missing', exists: false,
      });
      assert.deepEqual(snapshot.aiLaunchModes, { zcode: 'file', codex: 'file', claude: 'file' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('選択した絶対パスを保存し、次回起動時にも読み込む', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scopepilot-runtime-'));
    try {
      const bin = join(root, 'custom');
      await mkdir(bin);
      const executable = await fakeCommand(bin, 'tool');
      const filePath = join(root, 'settings', 'runtime-tools.json');
      const paths: RuntimeToolPaths = {
        zcodeCli: executable,
        codexCli: executable,
        claudeCli: executable,
        zapExecutable: executable,
        nucleiExecutable: executable,
        nucleiTemplateManifest: executable,
        playwrightExecutable: executable,
      };
      const first = new RuntimeSettingsStore({ filePath, applicationDirectory: root, pathValue: '' });
      await first.load();
      const saved = await first.save({ paths, aiLaunchModes: DEFAULT_AI_CLI_LAUNCH_MODES });
      await first.saveAiSelection({ provider: 'claude', model: 'sonnet' });
      const reopened = new RuntimeSettingsStore({ filePath, applicationDirectory: root, pathValue: '' });

      assert.deepEqual(saved.paths, paths);
      assert.ok(saved.tools.every((tool) => tool.source === 'saved' && tool.exists));
      const reopenedSnapshot = await reopened.load();
      assert.deepEqual(reopenedSnapshot.paths, paths);
      assert.deepEqual(reopenedSnapshot.aiLaunchModes, DEFAULT_AI_CLI_LAUNCH_MODES);
      assert.deepEqual(reopenedSnapshot.aiSelection, { provider: 'claude', model: 'sonnet' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('旧設定はnpm shimをNode経由、それ以外をファイル実行へ移行する', { skip: process.platform !== 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'scopepilot-runtime-'));
    try {
      const codexShim = join(root, 'codex.ps1');
      const claudeExecutable = join(root, 'claude.exe');
      const filePath = join(root, 'runtime-tools.json');
      await writeFile(codexShim, 'stub', 'utf8');
      await writeFile(claudeExecutable, 'stub', 'utf8');
      await writeFile(filePath, JSON.stringify({
        schemaVersion: 1,
        paths: { codexCli: codexShim, claudeCli: claudeExecutable },
      }), 'utf8');
      const store = new RuntimeSettingsStore({ filePath, applicationDirectory: root, pathValue: '' });

      const snapshot = await store.load();

      assert.equal(snapshot.schemaVersion, 2);
      assert.deepEqual(snapshot.aiLaunchModes, { zcode: 'file', codex: 'node', claude: 'file' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('存在しないパスは保存しない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scopepilot-runtime-'));
    try {
      const store = new RuntimeSettingsStore({
        filePath: join(root, 'settings.json'),
        applicationDirectory: root,
        pathValue: '',
      });
      await store.load();
      const invalid: RuntimeToolPaths = {
        zcodeCli: join(root, 'missing.exe'),
        codexCli: '',
        claudeCli: '',
        zapExecutable: '',
        nucleiExecutable: '',
        nucleiTemplateManifest: '',
        playwrightExecutable: '',
      };

      await assert.rejects(store.save({ paths: invalid, aiLaunchModes: DEFAULT_AI_CLI_LAUNCH_MODES }), /ファイルが見つからない/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
