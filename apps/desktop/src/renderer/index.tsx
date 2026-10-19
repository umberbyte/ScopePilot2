/**
 * renderer の入口。Fluent UI v9 の shell を mount し、Core API の稼働状態を表示する。
 * renderer は契約 client と view model のみに依存し、DB・外部エンジンへ直接接続しない
 * (`docs/detailed-design/01-system-components.md` §1)。
 */
import { createRoot } from 'react-dom/client';
import { AdvancedApp } from './advanced.tsx';
import { t } from './resources.ts';
import { WizardApp } from './wizard.tsx';
import { FluentProvider, webDarkTheme, webLightTheme, Text, Spinner, makeStyles, Button } from '@fluentui/react-components';
import React, { useEffect, useState } from 'react';

interface DesktopBridge {
  apiBase: string;
}

declare global {
  interface Window {
    scopepilotDesktop?: DesktopBridge;
  }
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px' },
  modebar: { display: 'flex', gap: '8px', alignItems: 'center' },
});

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

function App(): React.ReactElement {
  const styles = useStyles();
  const [status, setStatus] = useState<string>(t('app.status.connecting'));
  // モードは表示と編集範囲だけを変える (design/02 §0)。wizard 側の状態はモード切替で
  // 失われないよう、Simple を隠すだけで mount を維持する。
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple');
  const apiBase = window.scopepilotDesktop?.apiBase;

  useEffect(() => {
    if (apiBase === undefined) {
      setStatus(t('app.status.bridgeMissing'));
      return;
    }
    fetch(`${apiBase}/api/health`)
      .then((response) => response.json() as Promise<{ status: string; schemaVersion: string }>)
      .then((body) => {
        setStatus(t('app.status.apiOk', { status: body.status, schemaVersion: body.schemaVersion }));
      })
      .catch(() => {
        setStatus(t('app.status.apiUnreachable'));
      });
  }, [apiBase]);

  return (
    <div className={styles.root}>
      <Text size={500} weight="semibold">
        ScopePilot2
      </Text>
      <Text>{status}</Text>
      <div className={styles.modebar}>
        <Text>{t('app.mode.label')}</Text>
        <Button appearance={mode === 'simple' ? 'primary' : 'secondary'} onClick={() => setMode('simple')}>
          {t('app.mode.simple')}
        </Button>
        <Button appearance={mode === 'advanced' ? 'primary' : 'secondary'} onClick={() => setMode('advanced')}>
          {t('app.mode.advanced')}
        </Button>
      </div>
      <Spinner size="tiny" label={t('app.harnessLabel')} />
      {apiBase !== undefined && (
        <>
          <div style={{ display: mode === 'simple' ? 'block' : 'none' }}>
            <WizardApp apiBase={apiBase} />
          </div>
          {mode === 'advanced' && <AdvancedApp apiBase={apiBase} />}
        </>
      )}
    </div>
  );
}

const container = document.getElementById('root');
if (container === null) {
  throw new Error('root element not found');
}
/** provider の外で明暗を決める wrapper (FluentProvider の theme を切替)。 */
function ThemedApp(): React.ReactElement {
  const prefersLight = usePrefersLight();
  return (
    <FluentProvider theme={prefersLight ? webLightTheme : webDarkTheme}>
      <App />
    </FluentProvider>
  );
}

createRoot(container).render(<ThemedApp />);
