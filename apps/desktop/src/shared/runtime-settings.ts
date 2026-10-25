export const RuntimeToolIds = [
  'zcodeCli',
  'codexCli',
  'claudeCli',
  'zapExecutable',
  'nucleiExecutable',
  'nucleiTemplateManifest',
  'playwrightExecutable',
] as const;

export const AiCliProviders = ['zcode', 'codex', 'claude'] as const;
export type AiCliProvider = (typeof AiCliProviders)[number];

export const AiCliLaunchModeValues = ['node', 'file'] as const;
export type AiCliLaunchMode = (typeof AiCliLaunchModeValues)[number];
export type AiCliLaunchModes = Readonly<Record<AiCliProvider, AiCliLaunchMode>>;

export interface AiCliAuthStatus {
  readonly provider: AiCliProvider;
  readonly state: 'authenticated' | 'unauthenticated' | 'unavailable' | 'unknown';
  readonly detail: string;
  readonly checkedAt: string;
}

export interface AppAiSelection {
  readonly provider: AiCliProvider;
  readonly model: string;
}

export interface AiModelOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault: boolean;
}

export interface AiProviderCatalog {
  readonly provider: AiCliProvider;
  readonly label: string;
  readonly models: readonly AiModelOption[];
}

export interface AiCatalogSnapshot {
  readonly providers: readonly AiProviderCatalog[];
  readonly selection: AppAiSelection;
  readonly refreshedAt: string;
}

export type RuntimeToolId = (typeof RuntimeToolIds)[number];

export type RuntimeToolPaths = Readonly<Record<RuntimeToolId, string>>;

export interface RuntimeToolStatus {
  readonly id: RuntimeToolId;
  readonly path: string;
  readonly source: 'saved' | 'path' | 'known-location' | 'missing';
  readonly exists: boolean;
}

export interface RuntimeSettingsSnapshot {
  readonly schemaVersion: 2;
  readonly paths: RuntimeToolPaths;
  readonly aiLaunchModes: AiCliLaunchModes;
  readonly tools: readonly RuntimeToolStatus[];
  readonly aiSelection: AppAiSelection;
}

export interface RuntimeSettingsInput {
  readonly paths: RuntimeToolPaths;
  readonly aiLaunchModes: AiCliLaunchModes;
}

export const EMPTY_RUNTIME_TOOL_PATHS: RuntimeToolPaths = {
  zcodeCli: '',
  codexCli: '',
  claudeCli: '',
  zapExecutable: '',
  nucleiExecutable: '',
  nucleiTemplateManifest: '',
  playwrightExecutable: '',
};

export const DEFAULT_APP_AI_SELECTION: AppAiSelection = { provider: 'codex', model: '' };

export const DEFAULT_AI_CLI_LAUNCH_MODES: AiCliLaunchModes = {
  zcode: 'node',
  codex: 'node',
  claude: 'file',
};
