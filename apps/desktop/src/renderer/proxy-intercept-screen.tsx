/**
 * A05 Proxy / Intercept。`docs/detailed-design/f02-proxy-intercept.md`。
 * break queue の一覧と判断 (forward / drop、scope 外への編集は reject) を扱う。
 * 実 proxy listener (通信の傍受・転送本体) は実 adapter 接続の後続増分で、
 * この画面の受付 (intake) は fixture・検証用の供給点である。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { MessageBar, Button, Field, Input, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea, tokens } from '@fluentui/react-components';
import { t } from './resources.ts';

interface BreakItemView {
  readonly itemId: string;
  readonly messageReference: string;
  readonly direction: 'request' | 'response';
  readonly receivedAtMs: number;
  readonly deadlineMs: number;
  readonly originalRequestHash: string;
  readonly state: 'Held' | 'Forwarded' | 'Dropped' | 'Expired';
  readonly editedRequestHash?: string;
}

interface QueueState {
  readonly items: readonly BreakItemView[];
  readonly events: readonly { type: 'expired' | 'dropped'; itemId: string }[];
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

const stateLabel = (state: BreakItemView['state']): string =>
  ({ Held: t('a05.state.held'), Forwarded: t('a05.state.forwarded'), Dropped: t('a05.state.dropped'), Expired: t('a05.state.expired') })[state] ?? state;

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '4px' },
  muted: { color: tokens.colorNeutralForeground3 },
});

export function ProxyInterceptScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [queue, setQueue] = useState<QueueState>({ items: [], events: [] });
  const [direction, setDirection] = useState<'request' | 'response'>('request');
  const [messageReference, setMessageReference] = useState('');
  const [targetUrl, setTargetUrl] = useState('http://fixture.target.test/');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setQueue(await callJson<QueueState>(apiBase, 'GET', '/api/proxy/intercept'));
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      setBusy(true);
      setError('');
      setNotice('');
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

  const intake = useCallback(
    () =>
      run(async () => {
        await callJson(apiBase, 'POST', '/api/proxy/intercept/intake', { direction, messageReference, holdMs: 300_000 });
      }),
    [apiBase, direction, messageReference, run],
  );

  const forward = useCallback(
    (itemId: string) =>
      run(async () => {
        const result = await callJson<{ decision: { action: 'forward' | 'reject'; reason?: string } }>(apiBase, 'POST', '/api/proxy/intercept/forward', {
          itemId,
          targetUrl,
        });
        setNotice(
          result.decision.action === 'forward'
            ? t('a05.forwarded', { itemId })
            : t('a05.rejected', { itemId, reason: result.decision.reason ?? '' }),
        );
      }),
    [apiBase, run, targetUrl],
  );

  const drop = useCallback(
    (itemId: string) =>
      run(async () => {
        await callJson(apiBase, 'POST', '/api/proxy/intercept/drop', { itemId });
        setNotice(t('a05.dropped', { itemId }));
      }),
    [apiBase, run],
  );

  const held = queue.items.filter((item) => item.state === 'Held');

  return (
    <div className={styles.section}>
      <Text className={styles.muted}>{t('a05.intro')}</Text>
      {error !== '' && (
        <MessageBar intent="error">
          {`Error: ${error}`}
        </MessageBar>
      )}
      {notice !== '' && <Text role="status">{notice}</Text>}
      <Text weight="semibold">{t('a05.queueTitle', { items: queue.items.length, held: held.length })}</Text>
      <Field label={t('a05.directionLabel')}>
        <Input value={direction} onChange={(_, data) => setDirection(data.value === 'response' ? 'response' : 'request')} />
      </Field>
      <Field label={t('a05.referenceLabel')}>
        <Textarea value={messageReference} onChange={(_, data) => setMessageReference(data.value)} rows={2} />
      </Field>
      <Button appearance="primary" disabled={busy || messageReference.trim() === ''} onClick={() => void intake()}>
        {t('a05.intake')}
      </Button>
      <Field label={t('a05.forwardUrlLabel')}>
        <Input value={targetUrl} onChange={(_, data) => setTargetUrl(data.value)} />
      </Field>
      {queue.items.length === 0 ? (
        <Text className={styles.muted}>{t('a05.empty')}</Text>
      ) : (
        <Table size="small" aria-label={t('a05.table.aria')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>itemId</TableHeaderCell>
              <TableHeaderCell>{t('a05.directionLabel')}</TableHeaderCell>
              <TableHeaderCell>{t('a05.col.state')}</TableHeaderCell>
              <TableHeaderCell>{t('a05.col.hash')}</TableHeaderCell>
              <TableHeaderCell>{t('a05.col.actions')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {queue.items.map((item) => (
              <TableRow key={item.itemId}>
                <TableCell>{item.itemId}</TableCell>
                <TableCell>{item.direction}</TableCell>
                <TableCell>{stateLabel(item.state)}</TableCell>
                <TableCell>{`${item.originalRequestHash.slice(0, 12)}…`}</TableCell>
                <TableCell>
                  {item.state === 'Held' ? (
                    <>
                      <Button size="small" disabled={busy} onClick={() => void forward(item.itemId)}>
                        {t('a05.forward')}
                      </Button>
                      <Button size="small" disabled={busy} onClick={() => void drop(item.itemId)}>
                        {t('a05.drop')}
                      </Button>
                    </>
                  ) : (
                    item.editedRequestHash !== undefined && t('a05.editedTo', { hash: item.editedRequestHash.slice(0, 12) })
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Text className={styles.muted}>{t('a05.events', { events: queue.events.map((event) => `${event.type}(${event.itemId})`).join('・') || t('a05.eventsNone') })}</Text>
    </div>
  );
}
