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
  readonly source: 'saved' | 'environment' | 'path' | 'known-location' | 'missing';
  readonly exists: boolean;
}

export interface RuntimeSettingsSnapshot {
  readonly schemaVersion: 2;
  readonly environment: RuntimeEnvironment;
  readonly paths: RuntimeToolPaths;
  readonly aiLaunchModes: AiCliLaunchModes;
  readonly tools: readonly RuntimeToolStatus[];
  readonly aiSelection: AppAiSelection;
}

export const RuntimeEnvironmentKeys = ['SCOPEPILOT_API_PORT', 'SCOPEPILOT_ZAP_BASE_URL', 'SCOPEPILOT_OAST_SERVER_URL', 'SCOPEPILOT_INTERACTSH_CONFIG'] as const;
export type RuntimeEnvironment = Readonly<Record<(typeof RuntimeEnvironmentKeys)[number], string>>;
export const EMPTY_RUNTIME_ENVIRONMENT: RuntimeEnvironment = {
  SCOPEPILOT_API_PORT: '', SCOPEPILOT_ZAP_BASE_URL: '', SCOPEPILOT_OAST_SERVER_URL: '', SCOPEPILOT_INTERACTSH_CONFIG: '',
};
export interface RuntimeConnectionStatus {
  readonly id: 'zap' | 'nuclei' | 'templates' | 'oast';
  readonly state: 'available' | 'unavailable' | 'unconfigured';
  readonly detail: string;
  readonly checkedAt: string;
}

export interface RuntimeSettingsInput {
  readonly environment?: RuntimeEnvironment;
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
