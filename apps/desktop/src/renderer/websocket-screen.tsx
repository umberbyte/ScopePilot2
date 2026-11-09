import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Field,
  Input,
  makeStyles,
  MessageBar,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import { t } from './resources.ts';

type TransportKind = 'real' | 'fixture' | 'unavailable';

interface WsConnectionView {
  readonly connectionId: string;
  readonly logicalSessionId: string;
  readonly targetUrl: string;
  readonly transport: TransportKind;
  readonly state: 'closed' | 'failed' | 'imported';
  readonly openedAt: string;
  readonly sentFrames: number;
  readonly receivedFrames: number;
  readonly negotiatedSubprotocol?: string;
}

interface WsFrameView {
  readonly frameId: string;
  readonly connectionId: string;
  readonly targetUrl: string;
  readonly direction: 'sent' | 'received';
  readonly text: string;
  readonly rawHash: string;
  readonly recordedAt: string;
  readonly transport: TransportKind;
}

interface WsHistoryResponse {
  readonly transport: TransportKind;
  readonly implementation: 'node-websocket' | 'fixture' | 'unavailable';
  readonly connections: readonly WsConnectionView[];
  readonly frames: readonly WsFrameView[];
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '14px' },
  section: { display: 'flex', flexDirection: 'column', gap: '8px' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  tableWrap: { overflowX: 'auto' },
  payload: { maxWidth: '36rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'monospace' },
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

function transportText(transport: TransportKind, implementation: WsHistoryResponse['implementation']): string {
  if (transport === 'real') return t('a33.transport.real', { implementation });
  if (transport === 'fixture') return t('a33.transport.fixture');
  return t('a33.transport.unavailable');
}

export function WebSocketScreen({ apiBase }: { readonly apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [history, setHistory] = useState<WsHistoryResponse>({ transport: 'unavailable', implementation: 'unavailable', connections: [], frames: [] });
  const [targetUrl, setTargetUrl] = useState('');
  const [role, setRole] = useState('');
  const [subprotocols, setSubprotocols] = useState('');
  const [messages, setMessages] = useState('');
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await callJson<WsHistoryResponse>(apiBase, '/api/websocket/frames');
      setHistory(response);
      setError('');
      setSelectedConnectionId((current) => current ?? response.connections.at(-1)?.connectionId ?? null);
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase]);

  useEffect(() => { void load(); }, [load]);

  const send = useCallback(async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await callJson<{
        sent: number;
        rejected: 'size' | 'rate' | null;
        transport: TransportKind;
        connectionId?: string;
      }>(apiBase, '/api/websocket/send', {
        targetUrl,
        messages: messages.split('\n').filter((line) => line !== ''),
        ...(role.trim() === '' ? {} : { role: role.trim() }),
        ...(subprotocols.trim() === '' ? {} : { subprotocols: subprotocols.split(',').map((value) => value.trim()).filter((value) => value !== '') }),
      });
      setNotice(result.rejected === null
        ? t('a33.sent', { sent: result.sent, transport: result.transport })
        : t('a33.rejected', { rejected: result.rejected, sent: result.sent }));
      await load();
      if (result.connectionId !== undefined) setSelectedConnectionId(result.connectionId);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, load, messages, role, subprotocols, targetUrl]);

  const frames = useMemo(
    () => selectedConnectionId === null ? history.frames : history.frames.filter((frame) => frame.connectionId === selectedConnectionId),
    [history.frames, selectedConnectionId],
  );

  return (
    <div className={styles.root}>
      <Text>{t('a33.purpose')}</Text>
      <MessageBar intent={history.transport === 'real' ? 'success' : history.transport === 'fixture' ? 'warning' : 'error'}>
        {transportText(history.transport, history.implementation)}
      </MessageBar>
      {error !== '' && <MessageBar intent="error">{error}</MessageBar>}
      <div className={styles.section}>
        <Text weight="semibold">{t('a33.sendTitle')}</Text>
        <Field label={t('a33.targetLabel')} required><Input value={targetUrl} onChange={(_, data) => setTargetUrl(data.value)} /></Field>
        <Field label={t('a33.roleLabel')}><Input value={role} onChange={(_, data) => setRole(data.value)} /></Field>
        <Field label={t('a33.subprotocolsLabel')}><Input value={subprotocols} onChange={(_, data) => setSubprotocols(data.value)} /></Field>
        <Field label={t('a33.messagesLabel')} required><Textarea rows={4} value={messages} onChange={(_, data) => setMessages(data.value)} /></Field>
        <div className={styles.actions}>
          <Button appearance="primary" disabled={busy || history.transport === 'unavailable' || targetUrl.trim() === '' || messages.trim() === ''} onClick={() => void send()}>{t('a33.send')}</Button>
          <Button disabled={busy} onClick={() => void load()}>{t('common.reload')}</Button>
          {notice !== '' && <Text role="status">{notice}</Text>}
        </div>
      </div>
      <div className={styles.section}>
        <Text weight="semibold">{t('a33.connectionsTitle', { count: history.connections.length })}</Text>
        {history.connections.length === 0 ? <Text className={styles.muted}>{t('a33.connectionsEmpty')}</Text> : (
          <div className={styles.tableWrap}>
            <Table size="small" aria-label={t('a33.connectionsAria')}>
              <TableHeader><TableRow><TableHeaderCell>ID</TableHeaderCell><TableHeaderCell>URL</TableHeaderCell><TableHeaderCell>{t('a33.col.transport')}</TableHeaderCell><TableHeaderCell>{t('a33.col.state')}</TableHeaderCell><TableHeaderCell>{t('a33.col.frames')}</TableHeaderCell><TableHeaderCell>{t('a33.col.openedAt')}</TableHeaderCell></TableRow></TableHeader>
              <TableBody>{history.connections.map((connection) => (
                <TableRow key={connection.connectionId}>
                  <TableCell><Button appearance={selectedConnectionId === connection.connectionId ? 'primary' : 'subtle'} onClick={() => setSelectedConnectionId(connection.connectionId)}>{connection.connectionId}</Button></TableCell>
                  <TableCell>{connection.targetUrl}</TableCell>
                  <TableCell><Badge appearance="outline">{connection.transport}</Badge></TableCell>
                  <TableCell>{connection.state}</TableCell>
                  <TableCell>{`${connection.sentFrames} / ${connection.receivedFrames}`}</TableCell>
                  <TableCell>{connection.openedAt}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </div>
        )}
      </div>
      <div className={styles.section}>
        <div className={styles.actions}><Text weight="semibold">{t('a33.framesTitle', { count: frames.length })}</Text>{selectedConnectionId !== null && <Button appearance="subtle" onClick={() => setSelectedConnectionId(null)}>{t('a33.showAll')}</Button>}</div>
        {frames.length === 0 ? <Text className={styles.muted}>{t('a33.framesEmpty')}</Text> : (
          <div className={styles.tableWrap}>
            <Table size="small" aria-label={t('a33.framesAria')}>
              <TableHeader><TableRow><TableHeaderCell>{t('a33.col.time')}</TableHeaderCell><TableHeaderCell>{t('a33.col.direction')}</TableHeaderCell><TableHeaderCell>{t('a33.col.payload')}</TableHeaderCell><TableHeaderCell>{t('a33.col.hash')}</TableHeaderCell><TableHeaderCell>{t('a33.col.transport')}</TableHeaderCell></TableRow></TableHeader>
              <TableBody>{frames.map((frame) => (
                <TableRow key={frame.frameId}><TableCell>{frame.recordedAt}</TableCell><TableCell>{frame.direction}</TableCell><TableCell className={styles.payload}>{frame.text}</TableCell><TableCell>{frame.rawHash}</TableCell><TableCell>{frame.transport}</TableCell></TableRow>
              ))}</TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
