/**
 * A05 Proxy / Intercept。`docs/detailed-design/f02-proxy-intercept.md`。
 * break queue の一覧と判断 (forward / drop、scope 外への編集は reject) を扱う。
 * 実 proxy listener (通信の傍受・転送本体) は実 adapter 接続の後続増分で、
 * この画面の受付 (intake) は fixture・検証用の供給点である。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Field, Input, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea, tokens } from '@fluentui/react-components';

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
  ({ Held: '保持中', Forwarded: '転送済み', Dropped: '破棄', Expired: '期限切れ (drop 済み)' })[state] ?? state;

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
            ? `${itemId} を転送しました。`
            : `${itemId} は転送を拒否されました: ${result.decision.reason ?? ''}`,
        );
      }),
    [apiBase, run, targetUrl],
  );

  const drop = useCallback(
    (itemId: string) =>
      run(async () => {
        await callJson(apiBase, 'POST', '/api/proxy/intercept/drop', { itemId });
        setNotice(`${itemId} を破棄しました (暗黙転送はしません)。`);
      }),
    [apiBase, run],
  );

  const held = queue.items.filter((item) => item.state === 'Held');

  return (
    <div className={styles.section}>
      <Text className={styles.muted}>
        実 proxy listener (通信傍受・転送本体) は実 engine 接続と共に後続増分です。ここでは break queue への受付と判断 (forward / drop) を扱います。deadline 経過・queue 上限は既定で drop し、暗黙 forward はしません。
      </Text>
      {error !== '' && (
        <Text role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>
          {`Error: ${error}`}
        </Text>
      )}
      {notice !== '' && <Text>{notice}</Text>}
      <Text weight="semibold">{`break queue (${queue.items.length} 件・保持中 ${held.length} 件)`}</Text>
      <Field label="方向">
        <Input value={direction} onChange={(_, data) => setDirection(data.value === 'response' ? 'response' : 'request')} />
      </Field>
      <Field label="messageReference (原本参照・秘密値を含めない)">
        <Textarea value={messageReference} onChange={(_, data) => setMessageReference(data.value)} rows={2} />
      </Field>
      <Button appearance="primary" disabled={busy || messageReference.trim() === ''} onClick={() => void intake()}>
        受け取る (fixture 受付)
      </Button>
      <Field label="転送先 URL (scope 内であること。対象外は拒否されます)">
        <Input value={targetUrl} onChange={(_, data) => setTargetUrl(data.value)} />
      </Field>
      {queue.items.length === 0 ? (
        <Text className={styles.muted}>queue は空です。</Text>
      ) : (
        <Table size="small" aria-label="break queue 一覧">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>itemId</TableHeaderCell>
              <TableHeaderCell>方向</TableHeaderCell>
              <TableHeaderCell>状態</TableHeaderCell>
              <TableHeaderCell>原本 hash</TableHeaderCell>
              <TableHeaderCell>操作</TableHeaderCell>
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
                        転送
                      </Button>
                      <Button size="small" disabled={busy} onClick={() => void drop(item.itemId)}>
                        破棄
                      </Button>
                    </>
                  ) : (
                    item.editedRequestHash !== undefined && `${item.editedRequestHash.slice(0, 12)}… へ編集`
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Text className={styles.muted}>{`queue event: ${queue.events.map((event) => `${event.type}(${event.itemId})`).join('・') || 'なし'}`}</Text>
    </div>
  );
}
