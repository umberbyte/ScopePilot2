/**
 * renderer の入口。Fluent UI v9 の shell を mount し、Core API の稼働状態を表示する。
 * renderer は契約 client と view model のみに依存し、DB・外部エンジンへ直接接続しない
 * (`docs/detailed-design/01-system-components.md` §1)。
 */
import { createRoot } from 'react-dom/client';
import { AdvancedApp } from './advanced.tsx';
import { WizardApp } from './wizard.tsx';
import { FluentProvider, webLightTheme, Text, Spinner, makeStyles, Button } from '@fluentui/react-components';
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

function App(): React.ReactElement {
  const styles = useStyles();
  const [status, setStatus] = useState<string>('接続中…');
  // モードは表示と編集範囲だけを変える (design/02 §0)。wizard 側の状態はモード切替で
  // 失われないよう、Simple を隠すだけで mount を維持する。
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple');
  const apiBase = window.scopepilotDesktop?.apiBase;

  useEffect(() => {
    if (apiBase === undefined) {
      setStatus('API 橋渡しが見つかりません (preload 未構成)');
      return;
    }
    fetch(`${apiBase}/api/health`)
      .then((response) => response.json() as Promise<{ status: string; schemaVersion: string }>)
      .then((body) => {
        setStatus(`Core API: ${body.status} (${body.schemaVersion})`);
      })
      .catch(() => {
        setStatus('Core API へ接続できません');
      });
  }, [apiBase]);

  return (
    <div className={styles.root}>
      <Text size={500} weight="semibold">
        ScopePilot2
      </Text>
      <Text>{status}</Text>
      <div className={styles.modebar}>
        <Text>モード:</Text>
        <Button appearance={mode === 'simple' ? 'primary' : 'secondary'} onClick={() => setMode('simple')}>
          シンプル
        </Button>
        <Button appearance={mode === 'advanced' ? 'primary' : 'secondary'} onClick={() => setMode('advanced')}>
          アドバンスド
        </Button>
      </div>
      <Spinner size="tiny" label="fixture harness" />
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
createRoot(container).render(
  <FluentProvider theme={webLightTheme}>
    <App />
  </FluentProvider>,
);
