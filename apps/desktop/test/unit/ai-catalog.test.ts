import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { AiAuthService, type AuthCommandRunner } from '../../src/main/ai-auth.ts';
import { AiCatalogService } from '../../src/main/ai-catalog.ts';
import { DEFAULT_AI_CLI_LAUNCH_MODES, type RuntimeToolPaths } from '../../src/shared/runtime-settings.ts';

describe('AI model catalog', () => {
  test('ログイン済みCLIからモデル候補を取得して正規化する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scopepilot-ai-catalog-'));
    try {
      const executable = join(root, process.platform === 'win32' ? 'cli.exe' : 'cli');
      const credentials = join(root, 'credentials.json');
      const zcodeConfig = join(root, 'provider_config.json');
      const claudeUser = join(root, 'claude.json');
      const claudeSettings = join(root, 'claude-settings.json');
      const codexConfig = join(root, 'config.toml');
      await writeFile(executable, 'stub', 'utf8');
      await writeFile(credentials, JSON.stringify({ 'oauth:zai:access_token': 'secret' }), 'utf8');
      await writeFile(zcodeConfig, JSON.stringify({
        schemaVersion: 1,
        config: {
          defaultModelSelection: { providerId: 'account:zai', modelId: 'GLM-5.3' },
          providerConfigRules: { providerRules: [] },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        },
      }), 'utf8');
      await writeFile(claudeUser, JSON.stringify({ additionalModelOptionsCache: [{ value: 'claude-fable-5-1', label: 'Fable 5.1' }] }), 'utf8');
      await writeFile(claudeSettings, '{}', 'utf8');
      await writeFile(codexConfig, 'model = "gpt-test-b"\n', 'utf8');
      const paths: RuntimeToolPaths = {
        zcodeCli: executable, codexCli: executable, claudeCli: executable,
        zapExecutable: '', nucleiExecutable: '', nucleiTemplateManifest: '', playwrightExecutable: '',
      };
      const runner: AuthCommandRunner = async ({ args }) => {
        if (args.join(' ') === 'login status') return { exitCode: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
        if (args.join(' ') === 'auth status --json') return { exitCode: 0, stdout: '{"loggedIn":true}', stderr: '' };
        if (args.join(' ') === 'debug models') return {
          exitCode: 0,
          stdout: JSON.stringify({ models: [
            { slug: 'gpt-test-a', display_name: 'GPT Test A', description: 'A', visibility: 'list', priority: 2 },
            { slug: 'gpt-test-b', display_name: 'GPT Test B', description: 'B', visibility: 'list', priority: 1 },
            { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden', priority: 0 },
          ] }),
          stderr: '',
        };
        if (args[0] === '--help') return {
          exitCode: 0,
          stdout: "  --model <model>  Provide an alias (e.g. 'fable', 'opus', or 'sonnet')\n  -n, --name <name>",
          stderr: '',
        };
        return { exitCode: 1, stdout: '', stderr: '' };
      };
      const auth = new AiAuthService({ paths: () => paths, launchModes: () => DEFAULT_AI_CLI_LAUNCH_MODES, runner, zcodeCredentialsFile: credentials });
      const catalog = new AiCatalogService({
        paths: () => paths,
        launchModes: () => DEFAULT_AI_CLI_LAUNCH_MODES,
        selection: () => ({ provider: 'codex', model: 'gpt-test-b' }),
        auth,
        runner,
        zcodeProviderConfigFile: zcodeConfig,
        claudeUserConfigFile: claudeUser,
        claudeSettingsFile: claudeSettings,
        codexConfigFile: codexConfig,
        now: () => new Date('2026-10-20T00:00:00.000Z'),
      });

      const snapshot = await catalog.catalog();

      assert.deepEqual(snapshot.providers.map((provider) => provider.provider), ['zcode', 'codex', 'claude']);
      assert.deepEqual(snapshot.providers[0]?.models.map((model) => model.id), ['account:zai/GLM-5.3']);
      assert.deepEqual(snapshot.providers[1]?.models.map((model) => [model.id, model.isDefault]), [
        ['gpt-test-b', true], ['gpt-test-a', false],
      ]);
      assert.deepEqual(snapshot.providers[2]?.models.map((model) => model.id), ['', 'fable', 'opus', 'sonnet', 'claude-fable-5-1']);
      assert.equal(snapshot.refreshedAt, '2026-10-20T00:00:00.000Z');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
