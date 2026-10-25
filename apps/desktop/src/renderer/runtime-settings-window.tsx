import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Field, Input, MessageBar, Select, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import {
  DEFAULT_AI_CLI_LAUNCH_MODES,
  EMPTY_RUNTIME_TOOL_PATHS,
  type AiCliAuthStatus,
  type AiCliProvider,
  type AiCliLaunchModes,
  type RuntimeSettingsSnapshot,
  type RuntimeToolId,
  type RuntimeToolPaths,
} from '../shared/runtime-settings.ts';

const TOOL_META: Readonly<Record<RuntimeToolId, { readonly label: string; readonly description: string }>> = {
  zcodeCli: { label: 'zcode-cli', description: '資料解析と報告書文章生成に使用する zcode CLI' },
  codexCli: { label: 'Codex CLI', description: '資料解析と報告書文章生成に使用する codex コマンド' },
  claudeCli: { label: 'Claude CLI', description: '資料解析と報告書文章生成に使用する claude コマンド' },
  zapExecutable: { label: 'OWASP ZAP', description: 'Active Scan用のZAP実行ファイル。変更は次回起動時に反映されます' },
  nucleiExecutable: { label: 'Nuclei', description: '既知脆弱性テンプレート診断に使用するnuclei実行ファイル' },
  nucleiTemplateManifest: { label: 'Nuclei審査済みテンプレート', description: '実行を許可するHTTP-onlyテンプレートのパスとSHA-256を固定したScopePilotマニフェスト' },
  playwrightExecutable: { label: 'Playwright CLI', description: 'ブラウザー環境の確認・管理に使用するplaywrightコマンド' },
};

const AI_TOOLS: readonly RuntimeToolId[] = ['zcodeCli', 'codexCli', 'claudeCli'];
const ENGINE_TOOLS: readonly RuntimeToolId[] = ['zapExecutable', 'nucleiExecutable', 'nucleiTemplateManifest', 'playwrightExecutable'];
const AI_PROVIDER_BY_TOOL: Readonly<Partial<Record<RuntimeToolId, AiCliProvider>>> = {
  zcodeCli: 'zcode',
  codexCli: 'codex',
  claudeCli: 'claude',
};

const useStyles = makeStyles({
  root: {
    display: 'flex',
    minHeight: '100vh',
    flexDirection: 'column',
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    padding: '24px 28px 20px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  mark: {
    display: 'grid',
    width: '40px',
    height: '40px',
    placeItems: 'center',
    borderRadius: '8px',
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundColor: tokens.colorBrandBackground,
    fontWeight: tokens.fontWeightBold,
  },
  heading: { display: 'flex', flexDirection: 'column', gap: '2px' },
  subtitle: { color: tokens.colorNeutralForeground3 },
  content: {
    display: 'flex',
    width: '100%',
    maxWidth: '920px',
    flex: 1,
    alignSelf: 'center',
    flexDirection: 'column',
    gap: '18px',
    padding: '24px 28px 96px',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '18px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '10px',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  sectionIntro: { marginBottom: '10px', color: tokens.colorNeutralForeground3 },
  toolRow: {
    display: 'grid',
    gridTemplateColumns: '148px minmax(0, 1fr) auto',
    alignItems: 'end',
    gap: '10px',
    padding: '10px 0',
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  toolIdentity: { display: 'flex', gridRow: '1 / span 2', flexDirection: 'column', alignSelf: 'center', gap: '4px' },
  launchMode: { gridColumn: '2 / -1' },
  description: { color: tokens.colorNeutralForeground3, lineHeight: tokens.lineHeightBase200 },
  input: { width: '100%' },
  browse: { minWidth: '78px' },
  authRow: {
    display: 'flex',
    gridColumn: '2 / -1',
    minHeight: '32px',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },
  authDetail: { flex: 1, minWidth: '180px', color: tokens.colorNeutralForeground3 },
  footer: {
    position: 'fixed',
    right: 0,
    bottom: 0,
    left: 0,
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    padding: '14px 28px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow8,
  },
  loading: { display: 'grid', flex: 1, placeItems: 'center' },
  '@media (max-width: 720px)': {
    toolRow: { gridTemplateColumns: '1fr auto' },
    toolIdentity: { gridColumn: '1 / -1', gridRow: 'auto' },
    launchMode: { gridColumn: '1 / -1' },
    authRow: { gridColumn: '1 / -1' },
  },
});

function sourceLabel(source: RuntimeSettingsSnapshot['tools'][number]['source']): string {
  switch (source) {
    case 'saved': return '保存済み';
    case 'path': return 'PATHで検出';
    case 'known-location': return '標準位置で検出';
    case 'missing': return '未検出';
  }
}

export function RuntimeSettingsWindow(): React.ReactElement {
  const styles = useStyles();
  const bridge = window.scopepilotDesktop;
  const [snapshot, setSnapshot] = useState<RuntimeSettingsSnapshot | null>(null);
  const [paths, setPaths] = useState<RuntimeToolPaths>(EMPTY_RUNTIME_TOOL_PATHS);
  const [aiLaunchModes, setAiLaunchModes] = useState<AiCliLaunchModes>(DEFAULT_AI_CLI_LAUNCH_MODES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [authStatuses, setAuthStatuses] = useState<readonly AiCliAuthStatus[]>([]);
  const [authChecking, setAuthChecking] = useState(false);
  const [loginPending, setLoginPending] = useState<AiCliProvider | null>(null);

  const refreshAuth = useCallback(async (): Promise<readonly AiCliAuthStatus[]> => {
    if (bridge === undefined) return [];
    setAuthChecking(true);
    try {
      const loaded = await bridge.getAiAuthStatuses();
      setAuthStatuses(loaded);
      return loaded;
    } catch (cause) {
      setError(String(cause));
      return [];
    } finally {
      setAuthChecking(false);
    }
  }, [bridge]);

  useEffect(() => {
    if (bridge === undefined) {
      setError('デスクトップ連携を初期化できませんでした。');
      return;
    }
    bridge.getRuntimeSettings()
      .then((loaded) => { setSnapshot(loaded); setPaths(loaded.paths); setAiLaunchModes(loaded.aiLaunchModes); })
      .catch((cause: unknown) => setError(String(cause)));
    void refreshAuth();
  }, [bridge, refreshAuth]);

  useEffect(() => {
    if (loginPending === null) return;
    const timer = window.setInterval(() => {
      void refreshAuth().then((loaded) => {
        if (loaded.some((status) => status.provider === loginPending && status.state === 'authenticated')) {
          setLoginPending(null);
          setNotice(`${loginPending} のログインを確認しました。`);
        }
      });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [loginPending, refreshAuth]);

  const save = useCallback(async () => {
    if (bridge === undefined) return;
    setBusy(true);
    setError('');
    try {
      await bridge.saveRuntimeSettings({ paths, aiLaunchModes });
      await bridge.closeSettings();
    } catch (cause) {
      setError(String(cause));
      setBusy(false);
    }
  }, [aiLaunchModes, bridge, paths]);

  const cancel = useCallback(() => { void bridge?.closeSettings(); }, [bridge]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancel();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancel, save]);

  const statuses = useMemo(() => new Map(snapshot?.tools.map((tool) => [tool.id, tool]) ?? []), [snapshot]);
  const aiStatuses = useMemo(() => new Map(authStatuses.map((status) => [status.provider, status])), [authStatuses]);

  const renderAuth = (id: RuntimeToolId, unchanged: boolean): React.ReactElement | null => {
    const provider = AI_PROVIDER_BY_TOOL[id];
    if (provider === undefined) return null;
    const auth = aiStatuses.get(provider);
    if (!unchanged) {
      return <div className={styles.authRow}><Badge appearance="tint" color="warning">パス変更あり</Badge><Text className={styles.authDetail}>保存後にログイン状態を確認します。</Text></div>;
    }
    const state = auth?.state;
    const badge = state === 'authenticated' ? 'ログイン済み'
      : state === 'unauthenticated' ? '未ログイン'
        : state === 'unavailable' ? '利用不可'
          : '状態不明';
    const color: 'success' | 'danger' | 'subtle' | 'warning' = state === 'authenticated' ? 'success'
      : state === 'unauthenticated' ? 'danger'
        : state === 'unavailable' ? 'subtle'
          : 'warning';
    const mayLogin = auth !== undefined && (state === 'unauthenticated' || state === 'unknown');
    return (
      <div className={styles.authRow} aria-label={`${TOOL_META[id].label} 認証状態`}>
        <Badge appearance="tint" color={color}>{authChecking && auth === undefined ? '確認中…' : badge}</Badge>
        <Text className={styles.authDetail}>{auth?.detail ?? 'ログイン状態を確認しています。'}</Text>
        {mayLogin && (
          <Button
            appearance="primary"
            size="small"
            disabled={busy || loginPending === provider}
            onClick={() => {
              setError('');
              setNotice('');
              void bridge?.launchAiLogin(provider).then(() => {
                setLoginPending(provider);
                setNotice(`${TOOL_META[id].label} のログイン用シェルを開きました。画面の案内に従ってログインしてください。`);
              }).catch((cause: unknown) => setError(String(cause)));
            }}
          >
            {loginPending === provider ? 'ログイン待機中…' : 'ログイン'}
          </Button>
        )}
        <Button appearance="subtle" size="small" disabled={authChecking} onClick={() => void refreshAuth()}>
          状態を再確認
        </Button>
      </div>
    );
  };

  const renderTool = (id: RuntimeToolId): React.ReactElement => {
    const status = statuses.get(id);
    const current = paths[id];
    const provider = AI_PROVIDER_BY_TOOL[id];
    const unchanged = status !== undefined && current === status.path
      && (provider === undefined || aiLaunchModes[provider] === snapshot?.aiLaunchModes[provider]);
    const badgeText = current === '' ? '未設定' : unchanged ? sourceLabel(status.source) : '変更あり';
    const badgeColor: 'danger' | 'success' | 'warning' = current === '' ? 'danger' : unchanged && status?.exists === true ? 'success' : 'warning';
    return (
      <div className={styles.toolRow} key={id}>
        <div className={styles.toolIdentity}>
          <Text weight="semibold">{TOOL_META[id].label}</Text>
          <Badge appearance="tint" color={badgeColor}>{badgeText}</Badge>
        </div>
        {provider !== undefined && (
          <Field
            className={styles.launchMode}
            label={`${TOOL_META[id].label} の起動方式`}
            hint={aiLaunchModes[provider] === 'node'
              ? 'npmのCLI shimから実体を解決し、Node.jsで起動します。'
              : '指定した実行ファイルまたはスクリプトをそのまま起動します。'}
          >
            <Select
              aria-label={`${TOOL_META[id].label} の起動方式`}
              value={aiLaunchModes[provider]}
              disabled={busy}
              onChange={(_event, data) => setAiLaunchModes((previous) => ({ ...previous, [provider]: data.value as 'node' | 'file' }))}
            >
              <option value="node">Node.js経由（npm CLI）</option>
              <option value="file">指定ファイルを実行</option>
            </Select>
          </Field>
        )}
        <Field label={`${TOOL_META[id].label} のパス`} hint={TOOL_META[id].description}>
          <Input
            className={styles.input}
            value={current}
            disabled={busy}
            placeholder="実行ファイルの絶対パス"
            onChange={(_event, data) => setPaths((previous) => ({ ...previous, [id]: data.value }))}
          />
        </Field>
        <Button
          className={styles.browse}
          disabled={busy}
          onClick={() => {
            void bridge?.selectRuntimeToolFile(id, current).then((selected) => {
              if (selected !== null) setPaths((previous) => ({ ...previous, [id]: selected }));
            }).catch((cause: unknown) => setError(String(cause)));
          }}
        >
          参照…
        </Button>
        {renderAuth(id, unchanged)}
      </div>
    );
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.mark} aria-hidden="true">SP</div>
        <div className={styles.heading}>
          <Text as="h1" size={600} weight="semibold">実行環境の設定</Text>
          <Text className={styles.subtitle}>ScopePilot2が使用するローカルCLIと診断エンジンを指定します。</Text>
        </div>
      </header>

      {snapshot === null && error === '' ? (
        <div className={styles.loading}><Spinner label="設定を読み込んでいます" /></div>
      ) : (
        <main className={styles.content}>
          {error !== '' && <MessageBar intent="error">{error}</MessageBar>}
          {notice !== '' && <MessageBar intent="info">{notice}</MessageBar>}
          <section className={styles.section} aria-labelledby="ai-cli-heading">
            <Text id="ai-cli-heading" as="h2" size={400} weight="semibold">AI CLI</Text>
            <Text className={styles.sectionIntro}>PATH上で見つかったコマンドは初期値として入力されています。案件で選択したAIに対応するCLIが使用されます。</Text>
            {AI_TOOLS.map(renderTool)}
          </section>
          <section className={styles.section} aria-labelledby="engine-heading">
            <Text id="engine-heading" as="h2" size={400} weight="semibold">診断・ブラウザーエンジン</Text>
            <Text className={styles.sectionIntro}>保存したZAPパスは次回のScopePilot2起動時から使用されます。現在実行中の診断には影響しません。</Text>
            {ENGINE_TOOLS.map(renderTool)}
          </section>
        </main>
      )}

      <footer className={styles.footer}>
        <Button appearance="secondary" disabled={busy} onClick={cancel}>キャンセル</Button>
        <Button appearance="primary" disabled={busy || snapshot === null} onClick={() => void save()}>
          {busy ? '保存中…' : '保存して閉じる'}
        </Button>
      </footer>
    </div>
  );
}
