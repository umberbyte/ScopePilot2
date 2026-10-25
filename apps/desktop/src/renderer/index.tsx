/**
 * renderer の入口。Fluent UI v9 の shell を mount し、Core API の稼働状態を表示する。
 * renderer は契約 client と view model のみに依存し、DB・外部エンジンへ直接接続しない
 * (`docs/detailed-design/01-system-components.md` §1)。
 */
import { createRoot } from 'react-dom/client';
import { AdvancedApp } from './advanced.tsx';
import { setLocale, t, type Locale } from './resources.ts';
import { WizardApp } from './wizard.tsx';
import { RuntimeSettingsWindow } from './runtime-settings-window.tsx';
import type { RendererReportProfile } from './report-profile.ts';
import type {
  AiCliAuthStatus,
  AiCatalogSnapshot,
  AiCliProvider,
  RuntimeSettingsInput,
  AppAiSelection,
  RuntimeSettingsSnapshot,
  RuntimeToolId,
} from '../shared/runtime-settings.ts';
import {
  Badge,
  Button,
  FluentProvider,
  Select,
  Text,
  makeStyles,
  tokens,
  webDarkTheme,
  webLightTheme,
} from '@fluentui/react-components';
import React, { useEffect, useState } from 'react';
import type { ReportModel } from '@scopepilot2/contracts';

interface DesktopBridge {
  apiBase: string;
  selectCaseDirectory(mode: 'create' | 'open'): Promise<DesktopPath | null>;
  selectMaterialFiles(): Promise<readonly DesktopPath[]>;
  activateCaseWorkspace(request: {
    readonly directory: string;
    readonly mode: 'create' | 'open';
    readonly materialPaths: readonly string[];
    readonly settings: {
      readonly startUrl: string;
      readonly supportingOrigins: readonly string[];
      readonly targetRoles: readonly string[];
      readonly forbiddenActions: readonly string[];
      readonly aiProvider: 'zcode' | 'codex' | 'claude';
      readonly aiModel: string;
    };
  }): Promise<{
    readonly directory: string;
    readonly dbPath: string;
    readonly existingCase: { readonly name: string; readonly revision: number; readonly scope: { readonly allowedOrigins: readonly string[] } } | null;
    readonly settings: {
      readonly startUrl: string;
      readonly supportingOrigins: readonly string[];
      readonly targetRoles: readonly string[];
      readonly forbiddenActions: readonly string[];
      readonly aiProvider: 'zcode' | 'codex' | 'claude';
      readonly aiModel: string;
    };
    readonly inputs: readonly (DesktopPath & { readonly sha256: string; readonly relativePath: string })[];
    readonly reportProfile?: RendererReportProfile;
  }>;
  saveCaseWorkspaceSettings(request: {
    readonly startUrl: string;
    readonly allowedOrigins: readonly string[];
    readonly supportingOrigins: readonly string[];
    readonly targetRoles: readonly string[];
    readonly forbiddenActions: readonly string[];
    readonly aiProvider: 'zcode' | 'codex' | 'claude';
    readonly aiModel: string;
  }): Promise<{
    readonly settings: {
      readonly startUrl: string;
      readonly supportingOrigins: readonly string[];
      readonly targetRoles: readonly string[];
      readonly forbiddenActions: readonly string[];
      readonly aiProvider: 'zcode' | 'codex' | 'claude';
      readonly aiModel: string;
    };
    readonly allowedOrigins: readonly string[];
  }>;
  removeCaseInput(inputId: string): Promise<readonly (DesktopPath & { readonly inputId: string; readonly sha256: string; readonly relativePath: string })[]>;
  importCaseInputs(materialPaths: readonly string[]): Promise<readonly (DesktopPath & { readonly inputId: string; readonly sha256: string; readonly relativePath: string })[]>;
  saveReport(request: {
    readonly content: string;
    readonly modelHash: string;
    readonly reportId: string;
    readonly model: ReportModel;
    readonly profile: RendererReportProfile;
    readonly findingNarratives?: readonly {
      readonly findingId: string;
      readonly summary: string;
      readonly conditions: string;
      readonly cause: string;
      readonly reproductionSteps: readonly string[];
      readonly remediation: string;
      readonly verificationCriteria: string;
    }[];
  }): Promise<{
    readonly markdownPath: string;
    readonly wordPath: string;
    readonly structuredJsonPath: string;
  }>;
  analyzeMaterials(): Promise<{
    readonly provider: 'zcode' | 'codex' | 'claude';
    readonly model: string;
    readonly invocationId: string;
    readonly documents: readonly {
      readonly sourceId: string;
      readonly documentLabel: string;
      readonly summary: string;
      readonly urls: readonly string[];
      readonly authHints: readonly { readonly role: string; readonly authMethod: 'Form' | 'Bearer' | 'Basic' | 'ApiKey' | 'Cookie'; readonly documentLocation: string }[];
      readonly priorityRules: readonly { readonly urlIncludes: string; readonly category: 'pii' | 'payment' }[];
      readonly parameters: readonly { readonly name: string; readonly values: readonly string[] }[];
      readonly warnings: readonly string[];
    }[];
  }>;
  inferLoginForm(request: { readonly loginUrl: string }): Promise<{
    readonly provider: 'zcode' | 'codex' | 'claude';
    readonly model: string;
    readonly loginUrl: string;
    readonly usernameSelector: string;
    readonly passwordSelector: string;
    readonly submitSelector: string;
    readonly expectedUrlPrefix: string;
    readonly successMarker: string;
    readonly confidence: number;
    readonly summary: string;
    readonly warnings: readonly string[];
    readonly invocationId: string;
  }>;
  planPostLoginActions(request: { readonly instruction: string }): Promise<{
    readonly provider: 'zcode' | 'codex' | 'claude';
    readonly model: string;
    readonly summary: string;
    readonly steps: readonly (
      | { readonly kind: 'navigate' | 'click' | 'wait' | 'assert'; readonly target: string }
      | { readonly kind: 'select' | 'assertValue'; readonly target: string; readonly value: string }
    )[];
    readonly warnings: readonly string[];
    readonly expectedUrlPrefix?: string;
    readonly invocationId: string;
  }>;
  planInteractiveDiagnostics(request: {
    readonly instruction: string;
    readonly roles: readonly string[];
    readonly candidates: readonly {
      readonly url: string;
      readonly method: string;
      readonly diagnosticTracks: readonly string[];
      readonly inputPoints: readonly { readonly location: string; readonly name: string }[];
    }[];
  }): Promise<{
    readonly provider: 'zcode' | 'codex' | 'claude';
    readonly model: string;
    readonly summary: string;
    readonly items: readonly {
      readonly itemId: string;
      readonly track: 'workflow-state' | 'session-analysis' | 'authorization-differential' | 'upload-workflow' | 'api-schema' | 'cryptography-review';
      readonly targetUrl: string;
      readonly role: string;
      readonly roles: readonly string[];
      readonly summary: string;
      readonly steps: readonly (
        | { readonly kind: 'navigate' | 'click' | 'wait' | 'assert'; readonly target: string }
        | { readonly kind: 'fill' | 'select' | 'assertValue'; readonly target: string; readonly value: string }
        | { readonly kind: 'upload'; readonly target: string; readonly inputRef: 'upload-file' }
      )[];
      readonly samples: number;
      readonly tokenSource: 'body' | 'cookie' | 'hidden' | 'bearer' | 'custom';
      readonly tokenName: string;
      readonly expectation: 'same' | 'different';
      readonly requiredInputs: readonly ('upload-file' | 'api-spec' | 'additional-role-session')[];
    }[];
    readonly warnings: readonly string[];
    readonly invocationId: string;
  }>;
  selectInteractiveInput(kind: 'upload-file'): Promise<{ readonly kind: 'upload-file'; readonly inputRef: 'upload-file'; readonly name: string; readonly mimeType: string; readonly dataBase64: string } | null>;
  selectInteractiveInput(kind: 'api-spec'): Promise<{ readonly kind: 'api-spec'; readonly inputRef: 'api-spec'; readonly name: string; readonly document: unknown } | null>;
  generateAiReport(request: {
    readonly baseContent: string;
    readonly baseModelHash: string;
    readonly guidelines: readonly string[];
    readonly findings: readonly { readonly findingId: string; readonly title: string; readonly url: string; readonly method: string; readonly parameter: string }[];
  }): Promise<{
    readonly provider: 'zcode' | 'codex' | 'claude';
    readonly model: string;
    readonly content: string;
    readonly modelHash: string;
    readonly invocationId: string;
    readonly findingNarratives: readonly {
      readonly findingId: string;
      readonly summary: string;
      readonly conditions: string;
      readonly cause: string;
      readonly reproductionSteps: readonly string[];
      readonly remediation: string;
      readonly verificationCriteria: string;
    }[];
  }>;
  openSelectedPath(path: string): Promise<void>;
  openSettings(): Promise<void>;
  getRuntimeSettings(): Promise<RuntimeSettingsSnapshot>;
  saveRuntimeSettings(settings: RuntimeSettingsInput): Promise<RuntimeSettingsSnapshot>;
  selectRuntimeToolFile(toolId: RuntimeToolId, currentPath: string): Promise<string | null>;
  getAiAuthStatuses(): Promise<readonly AiCliAuthStatus[]>;
  launchAiLogin(provider: AiCliProvider): Promise<void>;
  getAiCatalog(): Promise<AiCatalogSnapshot>;
  saveAiSelection(selection: AppAiSelection): Promise<AppAiSelection>;
  closeSettings(): Promise<void>;
}

interface DesktopPath {
  readonly path: string;
  readonly name: string;
}

declare global {
  interface Window {
    scopepilotDesktop?: DesktopBridge;
  }
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    minHeight: '100vh',
    flexDirection: 'column',
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  appBar: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    display: 'flex',
    minHeight: '64px',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '20px',
    padding: '10px 24px',
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow2,
  },
  brand: { display: 'flex', minWidth: '244px', alignItems: 'center', gap: '12px' },
  brandMark: {
    display: 'grid',
    width: '36px',
    height: '36px',
    placeItems: 'center',
    borderRadius: '8px',
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundColor: tokens.colorBrandBackground,
    fontSize: '18px',
    fontWeight: 700,
    letterSpacing: '-0.04em',
  },
  brandCopy: { display: 'flex', flexDirection: 'column', lineHeight: 1.1 },
  brandSubtitle: { color: tokens.colorNeutralForeground3 },
  commandBar: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '12px',
    flexWrap: 'wrap',
  },
  modeSwitch: {
    padding: '2px 6px',
    borderRadius: '8px',
    backgroundColor: tokens.colorNeutralBackground3,
  },
  connection: { display: 'flex', alignItems: 'center', gap: '8px' },
  controls: { display: 'flex', alignItems: 'center', gap: '8px' },
  themeSelect: { minWidth: '112px' },
  workspace: { display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column' },
  hidden: { display: 'none' },
  '@media (max-width: 900px)': {
    appBar: { position: 'static', alignItems: 'flex-start', padding: '12px 16px' },
    brand: { minWidth: 'auto' },
    brandSubtitle: { display: 'none' },
    commandBar: { gap: '8px' },
    connection: { display: 'none' },
  },
});

type ThemePreference = 'system' | 'light' | 'dark';

/** OS の明暗設定に追従する (design/28 §8.1 MUST 3。Electron では nativeTheme が反映される)。 */
function usePrefersLight(): boolean {
  const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const [light, setLight] = useState(query === null || !query.matches);
  useEffect(() => {
    if (query === null) {
      return;
    }
    const onChange = (event: MediaQueryListEvent): void => {
      setLight(!event.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, [query]);
  return light;
}

function App({ themePreference, onThemePreferenceChange }: {
  themePreference: ThemePreference;
  onThemePreferenceChange: (preference: ThemePreference) => void;
}): React.ReactElement {
  const styles = useStyles();
  const [status, setStatus] = useState<string>(t('app.status.connecting'));
  const [connectionState, setConnectionState] = useState<'connecting' | 'online' | 'offline'>('connecting');
  // モードは表示と編集範囲だけを変える (design/02 §0)。wizard 側の状態はモード切替で
  // 失われないよう、Simple を隠すだけで mount を維持する。
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple');
  // 言語切替 (design/28 §8.1)。setLocale は即座に t() へ反映するため、
  // 再描画の trigger として locale state を併せて持つ。
  const [locale, setLocaleState] = useState<Locale>('ja');
  const apiBase = window.scopepilotDesktop?.apiBase;

  useEffect(() => {
    if (apiBase === undefined) {
      setStatus(t('app.status.bridgeMissing'));
      setConnectionState('offline');
      return;
    }
    fetch(`${apiBase}/api/health`)
      .then((response) => response.json() as Promise<{ status: string; schemaVersion: string }>)
      .then((body) => {
        setStatus(t('app.status.apiOk', { status: body.status, schemaVersion: body.schemaVersion }));
        setConnectionState('online');
      })
      .catch(() => {
        setStatus(t('app.status.apiUnreachable'));
        setConnectionState('offline');
      });
  }, [apiBase]);

  return (
    <div className={styles.root}>
      <header className={styles.appBar}>
        <div className={styles.brand}>
          <div className={styles.brandMark} aria-hidden="true">SP</div>
          <div className={styles.brandCopy}>
            <Text size={400} weight="semibold">ScopePilot2</Text>
            <Text size={200} className={styles.brandSubtitle}>{t('app.subtitle')}</Text>
          </div>
        </div>

        <div className={styles.commandBar}>
          <div className={styles.connection} title={status}>
            <Badge
              appearance="tint"
              color={connectionState === 'online' ? 'success' : connectionState === 'offline' ? 'danger' : 'informative'}
            >
              {connectionState === 'online' ? t('app.connection.online') : connectionState === 'offline' ? t('app.connection.offline') : t('app.connection.connecting')}
            </Badge>
          </div>

          <div className={styles.modeSwitch} role="group" aria-label={t('app.mode.label')}>
            <Button
              appearance={mode === 'simple' ? 'primary' : 'subtle'}
              size="small"
              aria-pressed={mode === 'simple'}
              onClick={() => setMode('simple')}
            >
              {t('app.mode.simple')}
            </Button>
            <Button
              appearance={mode === 'advanced' ? 'primary' : 'subtle'}
              size="small"
              aria-pressed={mode === 'advanced'}
              onClick={() => setMode('advanced')}
            >
              {t('app.mode.advanced')}
            </Button>
          </div>

          <div className={styles.controls}>
            <Button
              appearance="subtle"
              size="small"
              onClick={() => void window.scopepilotDesktop?.openSettings()}
            >
              {t('app.settings')}
            </Button>
            <Select
              className={styles.themeSelect}
              aria-label={t('app.theme.label')}
              value={themePreference}
              onChange={(_event, data) => onThemePreferenceChange(data.value as ThemePreference)}
              size="small"
            >
              <option value="system">{t('app.theme.system')}</option>
              <option value="light">{t('app.theme.light')}</option>
              <option value="dark">{t('app.theme.dark')}</option>
            </Select>
            <Button
              appearance="subtle"
              size="small"
              onClick={() => {
                const next: Locale = locale === 'ja' ? 'en' : 'ja';
                setLocale(next);
                setLocaleState(next);
              }}
            >
              {t('app.language')}
            </Button>
          </div>
        </div>
      </header>

      <main className={styles.workspace}>
        {apiBase !== undefined && (
          <>
            <div className={mode === 'simple' ? styles.workspace : styles.hidden}>
              <WizardApp apiBase={apiBase} />
            </div>
            {mode === 'advanced' && <AdvancedApp apiBase={apiBase} />}
          </>
        )}
      </main>
    </div>
  );
}

const container = document.getElementById('root');
if (container === null) {
  throw new Error('root element not found');
}

interface RendererErrorBoundaryState {
  readonly error: Error | null;
}

class RendererErrorBoundary extends React.Component<React.PropsWithChildren, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = { error: null };

  static getDerivedStateFromError(cause: unknown): RendererErrorBoundaryState {
    return { error: cause instanceof Error ? cause : new Error(String(cause)) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('ScopePilot2 renderer error', error, info);
  }

  render(): React.ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '32px',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', maxWidth: '640px', flexDirection: 'column', gap: '16px' }}>
          <Text as="h1" size={600} weight="semibold">{t('app.unexpectedError.title')}</Text>
          <Text>{t('app.unexpectedError.description')}</Text>
          <Text size={200}>{this.state.error.message}</Text>
          <Button appearance="primary" onClick={() => window.location.reload()}>
            {t('app.unexpectedError.reload')}
          </Button>
        </div>
      </div>
    );
  }
}

/** provider の外で明暗を決める wrapper (FluentProvider の theme を切替)。 */
function ThemedApp(): React.ReactElement {
  const prefersLight = usePrefersLight();
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    const saved = window.localStorage.getItem('scopepilot.theme');
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  });
  const isLight = themePreference === 'light' || (themePreference === 'system' && prefersLight);
  const theme = isLight ? webLightTheme : webDarkTheme;

  useEffect(() => {
    window.localStorage.setItem('scopepilot.theme', themePreference);
    document.documentElement.style.colorScheme = isLight ? 'light' : 'dark';
  }, [isLight, themePreference]);

  return (
    <FluentProvider
      theme={theme}
      style={{
        minHeight: '100vh',
        color: theme.colorNeutralForeground1,
        backgroundColor: theme.colorNeutralBackground2,
      }}
    >
      <RendererErrorBoundary>
        {new URLSearchParams(window.location.search).get('window') === 'settings'
          ? <RuntimeSettingsWindow />
          : <App themePreference={themePreference} onThemePreferenceChange={setThemePreference} />}
      </RendererErrorBoundary>
    </FluentProvider>
  );
}

createRoot(container).render(<ThemedApp />);
