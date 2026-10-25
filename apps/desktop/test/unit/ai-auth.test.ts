import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { AiAuthService, type AuthCommandRunner, type InteractiveLoginLauncher } from '../../src/main/ai-auth.ts';
import { DEFAULT_AI_CLI_LAUNCH_MODES, type AiCliProvider, type RuntimeToolPaths } from '../../src/shared/runtime-settings.ts';

describe('AI CLI authentication', () => {
  test('各CLIの出力から秘密値を返さずログイン状態だけを取得する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scopepilot-ai-auth-'));
    try {
      const executable = join(root, process.platform === 'win32' ? 'cli.exe' : 'cli');
      const credentials = join(root, 'credentials.json');
      await writeFile(executable, 'stub', 'utf8');
      await writeFile(credentials, JSON.stringify({ 'oauth:zai:access_token': 'secret-token' }), 'utf8');
      const paths: RuntimeToolPaths = {
        zcodeCli: executable,
        codexCli: executable,
        claudeCli: executable,
        zapExecutable: '',
        nucleiExecutable: '',
        nucleiTemplateManifest: '',
        playwrightExecutable: '',
      };
      const runner: AuthCommandRunner = async ({ args }) => args[0] === 'login'
        ? { exitCode: 0, stdout: 'Logged in using ChatGPT', stderr: '' }
        : { exitCode: 0, stdout: JSON.stringify({ loggedIn: false, email: 'secret@example.test' }), stderr: '' };
      const service = new AiAuthService({
        paths: () => paths,
        launchModes: () => DEFAULT_AI_CLI_LAUNCH_MODES,
        runner,
        zcodeCredentialsFile: credentials,
        now: () => new Date('2026-10-20T00:00:00.000Z'),
      });

      const statuses = await service.statuses();

      assert.deepEqual(statuses.map(({ provider, state }) => ({ provider, state })), [
        { provider: 'zcode', state: 'authenticated' },
        { provider: 'codex', state: 'authenticated' },
        { provider: 'claude', state: 'unauthenticated' },
      ]);
      assert.ok(statuses.every((status) => status.checkedAt === '2026-10-20T00:00:00.000Z'));
      assert.doesNotMatch(JSON.stringify(statuses), /secret-token|secret@example/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ログインボタンは保存済みCLIパスを対話ランチャーへ渡す', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scopepilot-ai-auth-'));
    try {
      const executable = join(root, process.platform === 'win32' ? 'claude.exe' : 'claude');
      await writeFile(executable, 'stub', 'utf8');
      const paths: RuntimeToolPaths = {
        zcodeCli: '', codexCli: '', claudeCli: executable,
        zapExecutable: '', nucleiExecutable: '', nucleiTemplateManifest: '', playwrightExecutable: '',
      };
      const launched: Array<{ provider: AiCliProvider; executable: string; launchMode: string }> = [];
      const launcher: InteractiveLoginLauncher = (provider, path, launchMode) => { launched.push({ provider, executable: path, launchMode }); };
      const service = new AiAuthService({ paths: () => paths, launchModes: () => DEFAULT_AI_CLI_LAUNCH_MODES, loginLauncher: launcher });

      service.launchLogin('claude');

      assert.deepEqual(launched, [{ provider: 'claude', executable, launchMode: 'file' }]);
      assert.throws(() => service.launchLogin('codex'), /有効なパス/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
