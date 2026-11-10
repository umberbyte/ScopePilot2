import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Field, Input, makeStyles, MessageBar, Select, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, tokens } from '@fluentui/react-components';
import { t } from './resources.ts';

type TransportKind = 'real' | 'fixture' | 'unavailable';
type OastProtocol = 'http' | 'dns' | 'smtp' | 'icmp';

interface OastAttemptView {
  readonly attemptId: string;
  readonly targetUrl: string;
  readonly protocol: OastProtocol;
  readonly status: 'waiting' | 'expired';
  readonly interactions: number;
  readonly candidateOnly: boolean;
  readonly transport: TransportKind;
}

interface OastCallbackView {
  readonly eventId: string;
  readonly attemptId: string | null;
  readonly protocol: OastProtocol;
  readonly remoteAddress?: string;
  readonly recordedAt: string;
  readonly rawHash: string;
  readonly correlation: 'correlated' | 'uncorrelated';
  readonly transport: TransportKind;
}

interface OastResponse {
  readonly transport: TransportKind;
  readonly provider: 'interactsh' | 'fixture' | 'unavailable';
  readonly supportedProtocols: readonly OastProtocol[];
  readonly attempts: readonly OastAttemptView[];
  readonly callbacks: readonly OastCallbackView[];
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '14px' },
  section: { display: 'flex', flexDirection: 'column', gap: '8px' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  token: { fontFamily: 'monospace', overflowWrap: 'anywhere' },
  tableWrap: { overflowX: 'auto' },
});

async function callJson<T>(apiBase: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function transportText(response: OastResponse): string {
  if (response.transport === 'real') return t('a34.transport.real', { provider: response.provider });
  if (response.transport === 'fixture') return t('a34.transport.fixture');
  return t('a34.transport.unavailable');
}

export function OastScreen({ apiBase }: { readonly apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [data, setData] = useState<OastResponse>({ transport: 'unavailable', provider: 'unavailable', supportedProtocols: [], attempts: [], callbacks: [] });
  const [targetUrl, setTargetUrl] = useState('');
  const [protocol, setProtocol] = useState<OastProtocol>('http');
  const [issuedToken, setIssuedToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (quiet = false) => {
    try {
      const response = await callJson<OastResponse>(apiBase, '/api/oast/attempts');
      setData(response);
      setProtocol((current) => response.supportedProtocols.includes(current) ? current : response.supportedProtocols[0] ?? 'http');
      if (!quiet) setError('');
    } catch (cause) {
      if (!quiet) setError(String(cause));
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(true); }, 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const start = useCallback(async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await callJson<{ attemptId: string; token: string; waitMs: number; transport: TransportKind }>(apiBase, '/api/oast/attempts', { targetUrl, protocol });
      setIssuedToken(result.token);
      setNotice(t('a34.started', { attemptId: result.attemptId, hours: Math.round(result.waitMs / 3_600_000), transport: result.transport }));
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, load, protocol, targetUrl]);

  const copyToken = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(issuedToken);
      setNotice(t('a34.copied'));
    } catch (cause) {
      setError(String(cause));
    }
  }, [issuedToken]);

  return (
    <div className={styles.root}>
      <Text>{t('a34.purpose')}</Text>
      <MessageBar intent={data.transport === 'real' ? 'success' : data.transport === 'fixture' ? 'warning' : 'error'}>{transportText(data)}</MessageBar>
      {error !== '' && <MessageBar intent="error">{error}</MessageBar>}
      <div className={styles.section}>
        <Text weight="semibold">{t('a34.issueTitle')}</Text>
        <Field label={t('a34.targetLabel')} required><Input value={targetUrl} onChange={(_, value) => setTargetUrl(value.value)} /></Field>
        <Field label={t('a34.protocolLabel')} required>
          <Select value={protocol} onChange={(_, value) => setProtocol(value.value as OastProtocol)}>
            {data.supportedProtocols.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}
          </Select>
        </Field>
        <div className={styles.actions}>
          <Button appearance="primary" disabled={busy || data.transport === 'unavailable' || targetUrl.trim() === '' || data.supportedProtocols.length === 0} onClick={() => void start()}>{t('a34.issue')}</Button>
          <Button disabled={busy} onClick={() => void load()}>{t('common.reload')}</Button>
        </div>
        {issuedToken !== '' && <div className={styles.section}><Text className={styles.token}>{issuedToken}</Text><Button onClick={() => void copyToken()}>{t('a34.copy')}</Button></div>}
        {notice !== '' && <Text role="status">{notice}</Text>}
      </div>
      <div className={styles.section}>
        <Text weight="semibold">{t('a34.attemptsTitle', { count: data.attempts.length })}</Text>
        {data.attempts.length === 0 ? <Text className={styles.muted}>{t('a34.attemptsEmpty')}</Text> : (
          <div className={styles.tableWrap}><Table size="small" aria-label={t('a34.attemptsAria')}>
            <TableHeader><TableRow><TableHeaderCell>ID</TableHeaderCell><TableHeaderCell>URL</TableHeaderCell><TableHeaderCell>{t('a34.col.protocol')}</TableHeaderCell><TableHeaderCell>{t('a34.col.status')}</TableHeaderCell><TableHeaderCell>{t('a34.col.callbacks')}</TableHeaderCell><TableHeaderCell>{t('a34.col.transport')}</TableHeaderCell></TableRow></TableHeader>
            <TableBody>{data.attempts.map((attempt) => <TableRow key={attempt.attemptId}><TableCell>{attempt.attemptId}</TableCell><TableCell>{attempt.targetUrl}</TableCell><TableCell>{attempt.protocol}</TableCell><TableCell>{attempt.status}</TableCell><TableCell>{attempt.interactions}</TableCell><TableCell><Badge appearance="outline">{attempt.transport}</Badge></TableCell></TableRow>)}</TableBody>
          </Table></div>
        )}
      </div>
      <div className={styles.section}>
        <Text weight="semibold">{t('a34.callbacksTitle', { count: data.callbacks.length })}</Text>
        <Text className={styles.muted}>{t('a34.callbacksPolling')}</Text>
        {data.callbacks.length === 0 ? <Text className={styles.muted}>{t('a34.callbacksEmpty')}</Text> : (
          <div className={styles.tableWrap}><Table size="small" aria-label={t('a34.callbacksAria')}>
            <TableHeader><TableRow><TableHeaderCell>{t('a34.col.receivedAt')}</TableHeaderCell><TableHeaderCell>{t('a34.col.protocol')}</TableHeaderCell><TableHeaderCell>{t('a34.col.remote')}</TableHeaderCell><TableHeaderCell>{t('a34.col.correlation')}</TableHeaderCell><TableHeaderCell>{t('a34.col.attempt')}</TableHeaderCell><TableHeaderCell>{t('a34.col.hash')}</TableHeaderCell><TableHeaderCell>{t('a34.col.transport')}</TableHeaderCell></TableRow></TableHeader>
            <TableBody>{data.callbacks.map((callback) => <TableRow key={callback.eventId}><TableCell>{callback.recordedAt}</TableCell><TableCell>{callback.protocol}</TableCell><TableCell>{callback.remoteAddress ?? '—'}</TableCell><TableCell>{callback.correlation}</TableCell><TableCell>{callback.attemptId ?? '—'}</TableCell><TableCell>{callback.rawHash}</TableCell><TableCell>{callback.transport}</TableCell></TableRow>)}</TableBody>
          </Table></div>
        )}
      </div>
    </div>
  );
}
