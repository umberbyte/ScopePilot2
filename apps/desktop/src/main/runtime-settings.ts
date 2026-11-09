import { constants as fsConstants, existsSync } from 'node:fs';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import {
  EMPTY_RUNTIME_ENVIRONMENT, RuntimeEnvironmentKeys, type RuntimeEnvironment,
  AiCliProviders,
  AiCliLaunchModeValues,
  DEFAULT_APP_AI_SELECTION,
  DEFAULT_AI_CLI_LAUNCH_MODES,
  EMPTY_RUNTIME_TOOL_PATHS,
  RuntimeToolIds,
  type AppAiSelection,
  type AiCliLaunchModes,
  type AiCliProvider,
  type RuntimeSettingsInput,
  type RuntimeSettingsSnapshot,
  type RuntimeToolId,
  type RuntimeToolPaths,
  type RuntimeToolStatus,
} from '../shared/runtime-settings.ts';

const TOOL_COMMANDS: Readonly<Record<RuntimeToolId, readonly string[]>> = {
  // zcode-cli is the product-facing name. Existing installations expose zcode.
  zcodeCli: ['zcode-cli', 'zcode'],
  codexCli: ['codex'],
  claudeCli: ['claude'],
  zapExecutable: ['ZAP', 'zap'],
  nucleiExecutable: ['nuclei'],
  nucleiTemplateManifest: [],
  playwrightExecutable: ['playwright'],
};

const WINDOWS_EXTENSIONS = ['.exe', '.ps1', '.cmd', '.bat', ''] as const;

function executableExtensions(): readonly string[] {
  if (process.platform !== 'win32') return [''];
  const fromEnvironment = (process.env.PATHEXT ?? '')
    .split(';')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...WINDOWS_EXTENSIONS, ...fromEnvironment])];
}

function findOnPath(names: readonly string[], pathValue = process.env.PATH ?? ''): string {
  const directories = pathValue.split(delimiter).map((entry) => entry.trim().replace(/^"|"$/gu, '')).filter(Boolean);
  for (const name of names) {
    const hasExtension = extname(name) !== '';
    for (const directory of directories) {
      for (const extension of hasExtension ? [''] : executableExtensions()) {
        const candidate = resolve(directory, `${name}${extension}`);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return '';
}

function knownLocations(id: RuntimeToolId, applicationDirectory: string): readonly string[] {
  if (process.platform !== 'win32') return [];
  switch (id) {
    case 'zapExecutable':
      return [
        'C:\\Program Files\\ZAP\\Zed Attack Proxy\\ZAP.exe',
        'C:\\Program Files (x86)\\ZAP\\Zed Attack Proxy\\ZAP.exe',
      ];
    case 'playwrightExecutable':
      return [
        join(applicationDirectory, 'node_modules', '.bin', 'playwright.cmd'),
        join(applicationDirectory, '..', '..', 'node_modules', '.bin', 'playwright.cmd'),
      ];
    default:
      return [];
  }
}

async function isUsableFile(path: string): Promise<boolean> {
  if (path === '') return false;
  try {
    const details = await stat(path);
    if (!details.isFile()) return false;
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export interface RuntimeSettingsStoreOptions {
  readonly filePath: string;
  readonly applicationDirectory: string;
  readonly pathValue?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export class RuntimeSettingsStore {
  private readonly filePath: string;
  private readonly applicationDirectory: string;
  private readonly pathValue: string;
  private environment: RuntimeEnvironment = EMPTY_RUNTIME_ENVIRONMENT;
  private readonly startupEnvironment: Readonly<Record<string, string | undefined>>;
  private saved: RuntimeToolPaths = EMPTY_RUNTIME_TOOL_PATHS;
  private aiSelection: AppAiSelection = DEFAULT_APP_AI_SELECTION;
  private aiLaunchModes: AiCliLaunchModes = DEFAULT_AI_CLI_LAUNCH_MODES;
  private snapshot: RuntimeSettingsSnapshot | null = null;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: RuntimeSettingsStoreOptions) {
    this.startupEnvironment = options.environment ?? process.env;
    this.filePath = resolve(options.filePath);
    this.applicationDirectory = resolve(options.applicationDirectory);
    this.pathValue = options.pathValue ?? process.env.PATH ?? '';
  }

  async load(): Promise<RuntimeSettingsSnapshot> {
    let loaded: Partial<Record<RuntimeToolId, unknown>> = {};
    let loadedSelection: unknown;
    let loadedLaunchModes: unknown;
    let loadedEnvironment: unknown;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as { paths?: Partial<Record<RuntimeToolId, unknown>>; aiSelection?: unknown; aiLaunchModes?: unknown; environment?: unknown };
      loaded = parsed?.paths ?? {};
      loadedEnvironment = parsed?.environment;
      loadedSelection = parsed?.aiSelection;
      loadedLaunchModes = parsed?.aiLaunchModes;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && !(cause instanceof SyntaxError)) throw cause;
    }
    this.environment = normalizeRuntimeEnvironment(loadedEnvironment ?? EMPTY_RUNTIME_ENVIRONMENT);
    this.saved = Object.fromEntries(RuntimeToolIds.map((id) => [id, typeof loaded[id] === 'string' ? loaded[id].trim() : ''])) as unknown as RuntimeToolPaths;
    if (typeof loadedSelection === 'object' && loadedSelection !== null) {
      const selection = loadedSelection as { provider?: unknown; model?: unknown };
      if (AiCliProviders.includes(selection.provider as AppAiSelection['provider']) && typeof selection.model === 'string') {
        this.aiSelection = { provider: selection.provider as AppAiSelection['provider'], model: selection.model.trim() };
      }
    }
    const launchModeRecord = typeof loadedLaunchModes === 'object' && loadedLaunchModes !== null
      ? loadedLaunchModes as Partial<Record<AiCliProvider, unknown>>
      : {};
    const missingLaunchModes = new Set<AiCliProvider>();
    this.aiLaunchModes = Object.fromEntries(AiCliProviders.map((provider) => {
      const value = launchModeRecord[provider];
      if (AiCliLaunchModeValues.includes(value as AiCliLaunchModes[AiCliProvider])) return [provider, value];
      missingLaunchModes.add(provider);
      return [provider, DEFAULT_AI_CLI_LAUNCH_MODES[provider]];
    })) as unknown as AiCliLaunchModes;
    this.snapshot = await this.resolveSnapshot();
    if (missingLaunchModes.size > 0) {
      this.aiLaunchModes = Object.fromEntries(AiCliProviders.map((provider) => {
        const toolId = `${provider}Cli` as 'zcodeCli' | 'codexCli' | 'claudeCli';
        return [provider, missingLaunchModes.has(provider) ? inferAiLaunchMode(this.snapshot?.paths[toolId] ?? '') : this.aiLaunchModes[provider]];
      })) as unknown as AiCliLaunchModes;
      this.snapshot = { ...this.snapshot, aiLaunchModes: this.aiLaunchModes };
    }
    return this.snapshot;
  }

  current(): RuntimeSettingsSnapshot {
    if (this.snapshot === null) throw new Error('runtime settings have not been loaded');
    return this.snapshot;
  }

  async save(input: RuntimeSettingsInput): Promise<RuntimeSettingsSnapshot> {
    const { paths, aiLaunchModes } = input;
    const environment = normalizeRuntimeEnvironment(input.environment ?? this.environment);
    const normalizedEntries: [RuntimeToolId, string][] = [];
    for (const id of RuntimeToolIds) {
      const value = paths[id].trim();
      if (value !== '' && !isAbsolute(value)) throw new Error(`${id} は絶対パスで指定してください`);
      if (value !== '' && !(await isUsableFile(value))) throw new Error(`${id} のファイルが見つからないか、読み取れません: ${value}`);
      normalizedEntries.push([id, value === '' ? '' : resolve(value)]);
    }
    for (const provider of AiCliProviders) {
      if (!AiCliLaunchModeValues.includes(aiLaunchModes[provider])) throw new Error(`${provider} の起動方式が不正です`);
    }
    runtimeEnvironment({ ...this.current(), environment }, this.startupEnvironment);
    if (environment.SCOPEPILOT_INTERACTSH_CONFIG !== '' && !(await isUsableFile(environment.SCOPEPILOT_INTERACTSH_CONFIG))) throw new Error('Interactsh設定ファイルが見つからないか読み取れません');
    this.saved = Object.fromEntries(normalizedEntries) as unknown as RuntimeToolPaths;
    this.aiLaunchModes = { ...aiLaunchModes };
    this.environment = environment;
    await this.persist();
    this.snapshot = await this.resolveSnapshot();
    return this.snapshot;
  }

  async saveAiSelection(selection: AppAiSelection): Promise<AppAiSelection> {
    if (!AiCliProviders.includes(selection.provider)) throw new Error('AIプロバイダーが不正です');
    const model = selection.model.trim();
    if (model.length > 240 || /[\u0000-\u001f\u007f]/u.test(model)) throw new Error('AIモデル名が不正です');
    this.aiSelection = { provider: selection.provider, model };
    await this.persist();
    this.snapshot = await this.resolveSnapshot();
    return this.aiSelection;
  }

  private async persist(): Promise<void> {
    const next = this.persistQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify({ schemaVersion: 2, environment: this.environment, paths: this.saved, aiLaunchModes: this.aiLaunchModes, aiSelection: this.aiSelection }, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, this.filePath);
    });
    this.persistQueue = next;
    await next;
  }

  private async resolveSnapshot(): Promise<RuntimeSettingsSnapshot> {
    const tools: RuntimeToolStatus[] = [];
    for (const id of RuntimeToolIds) {
      const configured = this.saved[id];
      if (configured !== '') {
        tools.push({ id, path: configured, source: 'saved', exists: await isUsableFile(configured) });
        continue;
      }
      const envKey = ({ zapExecutable: 'SCOPEPILOT_ZAP_EXECUTABLE', nucleiExecutable: 'SCOPEPILOT_NUCLEI_EXECUTABLE', nucleiTemplateManifest: 'SCOPEPILOT_NUCLEI_TEMPLATE_MANIFEST' } as Partial<Record<RuntimeToolId, string>>)[id];
      const fromEnvironment = envKey === undefined ? '' : this.startupEnvironment[envKey]?.trim() ?? '';
      if (fromEnvironment !== '') {
        tools.push({ id, path: fromEnvironment, source: 'environment', exists: await isUsableFile(fromEnvironment) });
        continue;
      }
      const fromPath = findOnPath(TOOL_COMMANDS[id], this.pathValue);
      if (fromPath !== '') {
        tools.push({ id, path: fromPath, source: 'path', exists: true });
        continue;
      }
      const known = knownLocations(id, this.applicationDirectory).find((candidate) => existsSync(candidate));
      tools.push(known === undefined
        ? { id, path: '', source: 'missing', exists: false }
        : { id, path: resolve(known), source: 'known-location', exists: true });
    }
    const paths = Object.fromEntries(tools.map((tool) => [tool.id, tool.path])) as unknown as RuntimeToolPaths;
    return { schemaVersion: 2, environment: this.environment, paths, aiLaunchModes: this.aiLaunchModes, tools, aiSelection: this.aiSelection };
  }
}

function inferAiLaunchMode(path: string): AiCliLaunchModes[AiCliProvider] {
  return /\.(?:ps1|cmd|bat)$/iu.test(path) ? 'node' : 'file';
}

/** Only supported non-secret settings are persisted; blank values inherit startup environment. */
export function normalizeRuntimeEnvironment(input: unknown): RuntimeEnvironment {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('環境設定の形式が不正です');
  const record = input as Record<string, unknown>;
  const values = Object.fromEntries(RuntimeEnvironmentKeys.map((key) => {
    const value = record[key] ?? '';
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${key} が不正です`);
    return [key, value.trim()];
  })) as unknown as RuntimeEnvironment;
  const port = values.SCOPEPILOT_API_PORT;
  if (port !== '' && (!/^\d+$/u.test(port) || Number(port) > 65535)) throw new Error('APIポートは0〜65535の整数で指定してください');
  for (const key of ['SCOPEPILOT_ZAP_BASE_URL', 'SCOPEPILOT_OAST_SERVER_URL'] as const) {
    const value = values[key];
    if (value === '') continue;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`${key} は認証情報を含まないHTTP(S) Originで指定してください`);
    if (key === 'SCOPEPILOT_OAST_SERVER_URL' && url.protocol !== 'https:') throw new Error('OASTサーバーはHTTPSで指定してください');
  }
  const config = values.SCOPEPILOT_INTERACTSH_CONFIG;
  if (config !== '' && !isAbsolute(config)) throw new Error('Interactsh設定ファイルは絶対パスで指定してください');
  return values;
}

export function runtimeEnvironment(snapshot: RuntimeSettingsSnapshot, inherited: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const env = { ...inherited };
  for (const key of RuntimeEnvironmentKeys) if (snapshot.environment[key] !== '') env[key] = snapshot.environment[key];
  for (const [id, key] of Object.entries({ zapExecutable: 'SCOPEPILOT_ZAP_EXECUTABLE', nucleiExecutable: 'SCOPEPILOT_NUCLEI_EXECUTABLE', nucleiTemplateManifest: 'SCOPEPILOT_NUCLEI_TEMPLATE_MANIFEST' })) {
    const value = snapshot.paths[id as RuntimeToolId];
    if (value !== '') env[key] = value;
  }
  if (inherited.SCOPEPILOT_DISABLE_NUCLEI === '1') {
    delete env.SCOPEPILOT_NUCLEI_EXECUTABLE;
    delete env.SCOPEPILOT_NUCLEI_TEMPLATE_MANIFEST;
  }
  if (env.SCOPEPILOT_OAST_SERVER_URL && !env.SCOPEPILOT_INTERACTSH_CONFIG) throw new Error('OASTサーバーにはInteractsh設定ファイルが必要です');
  return env;
}
