import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AiCatalogSnapshot,
  AiCliProvider,
  AiModelOption,
  AiProviderCatalog,
  AppAiSelection,
  AiCliLaunchModes,
  RuntimeToolPaths,
} from '../shared/runtime-settings.ts';
import type { AiAuthService, AuthCommandRunner } from './ai-auth.ts';
import { runAuthCommand } from './ai-auth.ts';

interface CatalogOptions {
  readonly paths: () => RuntimeToolPaths;
  readonly launchModes: () => AiCliLaunchModes;
  readonly selection: () => AppAiSelection;
  readonly auth: AiAuthService;
  readonly runner?: AuthCommandRunner;
  readonly zcodeProviderConfigFile?: string;
  readonly claudeUserConfigFile?: string;
  readonly claudeSettingsFile?: string;
  readonly codexConfigFile?: string;
  readonly now?: () => Date;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maxLength) : '';
}

function uniqueModels(models: readonly AiModelOption[]): readonly AiModelOption[] {
  const seen = new Set<string>();
  return models.filter((model) => model.id === '' || /^[^\s\u0000-\u001f\u007f]{1,240}$/u.test(model.id))
    .filter((model) => !seen.has(model.id) && Boolean(seen.add(model.id)));
}

function zcodeConfigPath(): string {
  const explicit = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim();
  if (explicit) return explicit;
  return join(process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir(), '.zcode', 'v2', 'provider_config.json');
}

function claudeConfigDirectory(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
}

function codexConfigPath(): string {
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'config.toml');
}

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) as unknown; } catch { return null; }
}

async function zcodeModels(path: string): Promise<readonly AiModelOption[]> {
  const root = objectValue(await readJson(path));
  const config = objectValue(root?.config);
  const selection = objectValue(config?.defaultModelSelection);
  const defaultProvider = safeText(selection?.providerId, 160);
  const defaultModel = safeText(selection?.modelId, 160);
  const values: Array<{ provider: string; model: string }> = [];
  if (defaultProvider !== '' && defaultModel !== '') values.push({ provider: defaultProvider, model: defaultModel });

  const providerRules = objectValue(config?.providerConfigRules)?.providerRules;
  if (Array.isArray(providerRules)) {
    for (const entry of providerRules) {
      const rule = objectValue(entry);
      const provider = safeText(rule?.providerId, 160);
      const models = objectValue(rule?.config)?.personalModelIds;
      if (provider !== '' && Array.isArray(models)) {
        for (const model of models) {
          const id = safeText(model, 160);
          if (id !== '') values.push({ provider, model: id });
        }
      }
    }
  }
  for (const groupName of ['providerModelRules', 'manualProviderModelRules']) {
    const rules = objectValue(config?.modelConfigRules)?.[groupName];
    if (!Array.isArray(rules)) continue;
    for (const entry of rules) {
      const rule = objectValue(entry);
      const provider = safeText(rule?.providerId, 160);
      const model = safeText(rule?.modelId, 160);
      if (provider !== '' && model !== '') values.push({ provider, model });
    }
  }
  return uniqueModels(values.map(({ provider, model }) => ({
    id: `${provider}/${model}`,
    label: model,
    description: provider,
    isDefault: provider === defaultProvider && model === defaultModel,
  })));
}

async function codexDefaultModel(path: string): Promise<string> {
  try {
    const text = await readFile(path, 'utf8');
    return /^\s*model\s*=\s*["']([^"']+)["']/mu.exec(text)?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

async function codexModels(executable: string, launchMode: AiCliLaunchModes['codex'], runner: AuthCommandRunner, configPath: string): Promise<readonly AiModelOption[]> {
  const [result, configuredDefault] = await Promise.all([
    runner({ executable, args: ['debug', 'models'], launchMode }),
    codexDefaultModel(configPath),
  ]);
  if (result.exitCode !== 0) return [];
  try {
    const models = objectValue(JSON.parse(result.stdout) as unknown)?.models;
    if (!Array.isArray(models)) return [];
    const parsed = models.flatMap((entry) => {
      const model = objectValue(entry);
      const id = safeText(model?.slug, 240);
      if (id === '' || model?.visibility !== 'list') return [];
      const label = safeText(model?.display_name, 160) || id;
      const description = safeText(model?.description, 400);
      const priority = typeof model?.priority === 'number' ? model.priority : Number.MAX_SAFE_INTEGER;
      return [{ id, label, ...(description === '' ? {} : { description }), priority }];
    }).sort((left, right) => left.priority - right.priority);
    const defaultId = parsed.some((model) => model.id === configuredDefault) ? configuredDefault : parsed[0]?.id ?? '';
    return uniqueModels(parsed.map(({ priority: _priority, ...model }) => ({ ...model, isDefault: model.id === defaultId })));
  } catch {
    return [];
  }
}

function cachedClaudeModels(value: unknown): Array<{ id: string; label: string; description?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [{ id: entry, label: entry }];
    const record = objectValue(entry);
    const id = safeText(record?.value ?? record?.model ?? record?.id, 240);
    if (id === '') return [];
    const label = safeText(record?.label ?? record?.name, 160) || id;
    const description = safeText(record?.description, 400);
    return [{ id, label, ...(description === '' ? {} : { description }) }];
  });
}

async function claudeModels(
  executable: string,
  launchMode: AiCliLaunchModes['claude'],
  runner: AuthCommandRunner,
  userConfigPath: string,
  settingsPath: string,
): Promise<readonly AiModelOption[]> {
  const [help, userConfigValue, settingsValue] = await Promise.all([
    runner({ executable, args: ['--help'], launchMode }),
    readJson(userConfigPath),
    readJson(settingsPath),
  ]);
  const userConfig = objectValue(userConfigValue);
  const settings = objectValue(settingsValue);
  const cached = [
    ...cachedClaudeModels(userConfig?.modelAccessCache),
    ...cachedClaudeModels(userConfig?.additionalModelOptionsCache),
  ];
  const modelHelp = /--model <model>([\s\S]*?)(?:\n\s+-n, --name)/u.exec(help.stdout)?.[1] ?? '';
  const aliases = [...modelHelp.matchAll(/'([a-z][a-z0-9.-]+)'/giu)].map((match) => match[1] ?? '').filter(Boolean);
  const configuredDefault = safeText(settings?.model, 240)
    || safeText(objectValue(userConfig?.orgModelDefaultCache)?.model, 240)
    || safeText(userConfig?.orgModelDefaultCache, 240);
  const discovered = [
    { id: '', label: 'CLI既定モデル', description: 'Claude CLIが選択する既定モデル' },
    ...aliases.map((id) => ({ id, label: id[0]?.toUpperCase() + id.slice(1) })),
    ...cached,
  ];
  return uniqueModels(discovered.map((model) => ({ ...model, isDefault: model.id === configuredDefault || (configuredDefault === '' && model.id === '') })));
}

export class AiCatalogService {
  private readonly options: CatalogOptions;

  constructor(options: CatalogOptions) {
    this.options = options;
  }

  async catalog(): Promise<AiCatalogSnapshot> {
    const auth = await this.options.auth.statuses();
    const authenticated = new Set(auth.filter((status) => status.state === 'authenticated').map((status) => status.provider));
    const paths = this.options.paths();
    const launchModes = this.options.launchModes();
    const runner = this.options.runner ?? runAuthCommand;
    const providers = (await Promise.all((['zcode', 'codex', 'claude'] as const).map(async (provider): Promise<AiProviderCatalog | null> => {
      if (!authenticated.has(provider)) return null;
      let models: readonly AiModelOption[] = [];
      if (provider === 'zcode') {
        models = await zcodeModels(this.options.zcodeProviderConfigFile ?? zcodeConfigPath());
      } else if (provider === 'codex') {
        models = await codexModels(paths.codexCli, launchModes.codex, runner, this.options.codexConfigFile ?? codexConfigPath());
      } else {
        models = await claudeModels(
          paths.claudeCli,
          launchModes.claude,
          runner,
          this.options.claudeUserConfigFile ?? join(homedir(), '.claude.json'),
          this.options.claudeSettingsFile ?? join(claudeConfigDirectory(), 'settings.json'),
        );
      }
      return { provider, label: provider === 'zcode' ? 'ZCode' : provider === 'codex' ? 'Codex' : 'Claude', models };
    }))).filter((provider): provider is AiProviderCatalog => provider !== null);
    return {
      providers,
      selection: this.options.selection(),
      refreshedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
  }
}
