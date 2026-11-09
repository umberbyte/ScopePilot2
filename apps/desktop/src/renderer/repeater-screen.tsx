/**
 * A06 Repeater (GO-11)。`docs/detailed-design/f04-repeater.md`。
 * draft (tab 上限 20) の作成・header/body 編集・表示 plan hash による確認送信を扱う。
 * 編集のたびに revision と plan hash が進み、表示時の hash と一致しない送信は行われない。
 * GO-11 拡張: 履歴/Site map からのインポート、レスポンス比較、transport 状態表示、タブ閉じる。
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  MessageBar,
  Button,
  Field,
  Input,
  makeStyles,
  Text,
  Textarea,
  tokens,
  Dialog,
  DialogTrigger,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  Badge,
  Table,
  TableHeader,
  TableRow,
  TableHeaderCell,
  TableBody,
  TableCell,
} from '@fluentui/react-components';
import { Dismiss24Regular } from '@fluentui/react-icons';
import { t } from './resources.ts';

interface DraftView {
  readonly draftId: string;
  readonly targetUrl: string;
  readonly protocol: 'http/1.1' | 'http/2';
  readonly revision: number;
  readonly requestBytes: string;
  readonly planHash: string;
}

interface SendResult {
  readonly sent: boolean;
  readonly reason?: string;
  readonly attempt?: { attemptId: string; outcome: 'responded' | 'timeout' };
  readonly response?: { status: number; contentType: string; bodyBytes: number; bodyPreview?: string };
  readonly sessionCookieNames?: readonly string[];
  readonly previousResponse?: { status: number; contentType: string; bodyPreview?: string };
}

interface ExchangeListItem {
  readonly exchangeId: string;
  readonly url: string;
  readonly method: string;
  readonly status: number;
  readonly contentType: string;
  readonly at: string;
}

interface TransportStatus {
  readonly connected: boolean;
  readonly mode: 'fixture' | 'live';
}

async function callJson<T>(apiBase: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '4px' },
  muted: { color: tokens.colorNeutralForeground3 },
  tabs: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px 8px',
    borderRadius: '4px',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  tabActive: {
    backgroundColor: tokens.colorBrandBackground2,
    borderColor: tokens.colorBrandStroke1,
  },
  tabButton: {
    padding: '2px 4px',
    minWidth: 'auto',
    cursor: 'pointer',
  },
  transportStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px',
    borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground3,
  },
  comparisonGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
    marginTop: '8px',
  },
  responsePanel: {
    padding: '12px',
    borderRadius: '6px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  toolbar: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
  },
});

export function RepeaterScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [drafts, setDrafts] = useState<readonly DraftView[]>([]);
  const [selected, setSelected] = useState<DraftView | null>(null);
  const [newTargetUrl, setNewTargetUrl] = useState('');
  const [sessionRole, setSessionRole] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [sendResult, setSendResult] = useState<SendResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // GO-11 拡張
  const [transportStatus, setTransportStatus] = useState<TransportStatus>({ connected: false, mode: 'fixture' });
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [exchanges, setExchanges] = useState<readonly ExchangeListItem[]>([]);
  const [selectedExchange, setSelectedExchange] = useState<string | null>(null);
  const [showComparison, setShowComparison] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await callJson<{ drafts: readonly DraftView[] }>(apiBase, 'GET', '/api/repeater');
      setDrafts(body.drafts);
      setSelected((current) => body.drafts.find((draft) => draft.draftId === current?.draftId) ?? body.drafts[0] ?? null);
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase]);

  const loadTransportStatus = useCallback(async () => {
    try {
      const status = await callJson<TransportStatus>(apiBase, 'GET', '/api/transport/status');
      setTransportStatus(status);
    } catch {
      // Transport 状態が取得できない場合は fixture モードとして扱う
      setTransportStatus({ connected: false, mode: 'fixture' });
    }
  }, [apiBase]);

  const loadExchanges = useCallback(async () => {
    try {
      const body = await callJson<{ entries: readonly ExchangeListItem[] }>(apiBase, 'GET', '/api/traffic?limit=100');
      setExchanges(body.entries ?? []);
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
    void loadTransportStatus();
  }, [load, loadTransportStatus]);

  const run = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      setBusy(true);
      setError('');
      try {
        await action();
        await load();
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const createDraft = useCallback(
    () =>
      run(async () => {
        await callJson(apiBase, 'POST', '/api/repeater/drafts', { targetUrl: newTargetUrl, protocol: 'http/1.1' });
        setNewTargetUrl('');
      }),
    [apiBase, newTargetUrl, run],
  );

  const closeDraft = useCallback(
    (draftId: string) =>
      run(async () => {
        await callJson(apiBase, 'DELETE', `/api/repeater/drafts/${draftId}`);
        if (selected?.draftId === draftId) {
          setSelected(null);
        }
      }),
    [apiBase, run, selected],
  );

  const importFromExchange = useCallback(
    () =>
      run(async () => {
        if (selectedExchange === null) {
          return;
        }
        await callJson(apiBase, 'POST', '/api/repeater/import', { exchangeId: selectedExchange });
        setShowImportDialog(false);
        setSelectedExchange(null);
      }),
    [apiBase, run, selectedExchange],
  );

  const applyEdit = useCallback(
    () =>
      run(async () => {
        if (selected === null) {
          return;
        }
        const headers = headersText
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
          .map((line): readonly [string, string] => {
            const separator = line.indexOf(':');
            return separator === -1 ? [line, ''] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
          });
        await callJson(apiBase, 'POST', '/api/repeater/edit', { draftId: selected.draftId, headers, body: bodyText });
      }),
    [apiBase, bodyText, headersText, run, selected],
  );

  const send = useCallback(
    (confirmedPlanHash: string) =>
      run(async () => {
        if (selected === null) {
          return;
        }
        // role 指定時はその role の session cookie を適用する (design/08)。空なら非認証。
        const result = await callJson<SendResult>(apiBase, 'POST', '/api/repeater/send', {
          draftId: selected.draftId,
          confirmedPlanHash,
          ...(sessionRole.trim() === '' ? {} : { role: sessionRole.trim() }),
        });
        setSendResult(result);
        setShowComparison(result.previousResponse !== undefined);
      }),
    [apiBase, run, selected, sessionRole],
  );

  const openImportDialog = useCallback(() => {
    void loadExchanges();
    setShowImportDialog(true);
  }, [loadExchanges]);

  return (
    <div className={styles.section}>
      {error !== '' && (
        <MessageBar intent="error">
          {`Error: ${error}`}
        </MessageBar>
      )}

      {/* Transport 接続状態の表示 (GO-11) */}
      <div className={styles.transportStatus}>
        <Badge
          appearance="tint"
          color={transportStatus.connected ? 'success' : 'warning'}
        >
          {transportStatus.connected ? t('a06.transportConnected') : t('a06.transportFixture')}
        </Badge>
        <Text size={200} className={styles.muted}>
          {transportStatus.mode === 'fixture' ? t('a06.fixtureMode') : t('a06.liveMode')}
        </Text>
      </div>

      <Text className={styles.muted}>{t('a06.intro')}</Text>

      <div className={styles.toolbar}>
        <Field label={t('common.targetUrlInScope')}>
          <Input value={newTargetUrl} onChange={(_, data) => setNewTargetUrl(data.value)} />
        </Field>
        <Button appearance="primary" disabled={busy || drafts.length >= 20} onClick={() => void createDraft()}>
          {t('a06.create')}
        </Button>
        <Button disabled={busy} onClick={openImportDialog}>
          {t('a06.importFromHistory')}
        </Button>
      </div>

      {/* タブ管理 (GO-11: 閉じるボタン付き) */}
      {drafts.length > 0 && (
        <div className={styles.tabs}>
          {drafts.map((draft) => (
            <div
              key={draft.draftId}
              className={`${styles.tab} ${selected?.draftId === draft.draftId ? styles.tabActive : ''}`}
            >
              <Button
                size="small"
                appearance="transparent"
                onClick={() => setSelected(draft)}
              >
                {`${draft.draftId} (r${draft.revision})`}
              </Button>
              <Button
                size="small"
                appearance="transparent"
                icon={<Dismiss24Regular />}
                className={styles.tabButton}
                onClick={() => void closeDraft(draft.draftId)}
                disabled={busy}
                aria-label={t('a06.closeTab')}
              />
            </div>
          ))}
        </div>
      )}

      {selected !== null && (
        <div className={styles.section}>
          <Text weight="semibold">{`${selected.draftId} — ${selected.targetUrl} (${selected.protocol}) revision ${selected.revision}`}</Text>
          <Field label={t('a06.headersLabel')}>
            <Textarea value={headersText} onChange={(_, data) => setHeadersText(data.value)} rows={3} />
          </Field>
          <Field label={t('a06.bodyLabel')}>
            <Textarea value={bodyText} onChange={(_, data) => setBodyText(data.value)} rows={3} />
          </Field>
          <Button disabled={busy} onClick={() => void applyEdit()}>
            {t('a06.apply')}
          </Button>
          <Text block style={{ whiteSpace: 'pre-wrap' }}>{t('a06.requestPreview', { requestBytes: selected.requestBytes })}</Text>
          <Text>{t('a06.planHash', { planHash: selected.planHash })}</Text>
          <Field label={t('a06.sessionRoleLabel')}>
            <Input value={sessionRole} onChange={(_, data) => setSessionRole(data.value)} />
          </Field>
          <div className={styles.tabs}>
            <Button appearance="primary" disabled={busy} onClick={() => void send(selected.planHash)}>
              {t('a06.send')}
            </Button>
            {sendResult !== null && sendResult.previousResponse !== undefined && (
              <Button disabled={busy} onClick={() => setShowComparison(!showComparison)}>
                {showComparison ? t('a06.hideComparison') : t('a06.showComparison')}
              </Button>
            )}
          </div>

          {/* レスポンス表示と比較 (GO-11) */}
          {sendResult !== null && (
            <div className={styles.section}>
              {sendResult.sent ? (
                <>
                  <Text role="status">
                    {t('a06.sent', { outcome: sendResult.attempt?.outcome, status: sendResult.response?.status, contentType: sendResult.response?.contentType, bodyBytes: sendResult.response?.bodyBytes })}
                    {sendResult.sessionCookieNames !== undefined ? ` ${t('a06.sessionApplied', { cookies: sendResult.sessionCookieNames.join(', ') || '—' })}` : ''}
                  </Text>

                  {showComparison && sendResult.previousResponse !== undefined ? (
                    <div className={styles.comparisonGrid}>
                      <div className={styles.responsePanel}>
                        <Text weight="semibold" block>{t('a06.previousResponse')}</Text>
                        <Text block>{`Status: ${sendResult.previousResponse.status}`}</Text>
                        <Text block className={styles.muted}>{sendResult.previousResponse.contentType}</Text>
                        {sendResult.previousResponse.bodyPreview !== undefined && (
                          <Text block style={{ whiteSpace: 'pre-wrap', marginTop: '8px' }}>
                            {sendResult.previousResponse.bodyPreview}
                          </Text>
                        )}
                      </div>
                      <div className={styles.responsePanel}>
                        <Text weight="semibold" block>{t('a06.currentResponse')}</Text>
                        <Text block>{`Status: ${sendResult.response?.status}`}</Text>
                        <Text block className={styles.muted}>{sendResult.response?.contentType}</Text>
                        {sendResult.response?.bodyPreview !== undefined && (
                          <Text block style={{ whiteSpace: 'pre-wrap', marginTop: '8px' }}>
                            {sendResult.response.bodyPreview}
                          </Text>
                        )}
                      </div>
                    </div>
                  ) : (
                    sendResult.response?.bodyPreview !== undefined && (
                      <Text block style={{ whiteSpace: 'pre-wrap' }}>
                        {sendResult.response.bodyPreview}
                      </Text>
                    )
                  )}
                </>
              ) : (
                <MessageBar intent="error">{t('a06.notSent', { reason: sendResult.reason ?? '' })}</MessageBar>
              )}
            </div>
          )}
        </div>
      )}

      {/* 履歴からインポートダイアログ (GO-11) */}
      <Dialog open={showImportDialog} onOpenChange={(_, data) => setShowImportDialog(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('a06.importDialog.title')}</DialogTitle>
            <DialogContent>
              <Text className={styles.muted}>{t('a06.importDialog.description')}</Text>
              {exchanges.length === 0 ? (
                <Text>{t('a06.importDialog.noExchanges')}</Text>
              ) : (
                <Table size="small">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>{t('a06.importDialog.select')}</TableHeaderCell>
                      <TableHeaderCell>URL</TableHeaderCell>
                      <TableHeaderCell>Method</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {exchanges.slice(0, 20).map((exchange) => (
                      <TableRow
                        key={exchange.exchangeId}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setSelectedExchange(exchange.exchangeId)}
                      >
                        <TableCell>
                          <input
                            type="radio"
                            checked={selectedExchange === exchange.exchangeId}
                            onChange={() => setSelectedExchange(exchange.exchangeId)}
                          />
                        </TableCell>
                        <TableCell>{exchange.url}</TableCell>
                        <TableCell>{exchange.method}</TableCell>
                        <TableCell>{String(exchange.status)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setShowImportDialog(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={selectedExchange === null || busy}
                onClick={() => void importFromExchange()}
              >
                {t('a06.importDialog.import')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
