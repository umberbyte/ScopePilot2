/**
 * A06 Repeater。`docs/detailed-design/f04-repeater.md`。
 * draft (tab 上限 20) の作成・header/body 編集・表示 plan hash による確認送信を扱う。
 * 編集のたびに revision と plan hash が進み、表示時の hash と一致しない送信は行われない。
 * 実送信は fixture adapter (決定的応答)。実 adapter は後続増分。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Field, Input, makeStyles, Text, Textarea, tokens } from '@fluentui/react-components';

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
  tabs: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
});

export function RepeaterScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [drafts, setDrafts] = useState<readonly DraftView[]>([]);
  const [selected, setSelected] = useState<DraftView | null>(null);
  const [newTargetUrl, setNewTargetUrl] = useState('http://fixture.target.test/repeater');
  const [headersText, setHeadersText] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [sendResult, setSendResult] = useState<SendResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const body = await callJson<{ drafts: readonly DraftView[] }>(apiBase, 'GET', '/api/repeater');
      setDrafts(body.drafts);
      setSelected((current) => body.drafts.find((draft) => draft.draftId === current?.draftId) ?? body.drafts[0] ?? null);
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
      }),
    [apiBase, newTargetUrl, run],
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
        setSendResult(await callJson<SendResult>(apiBase, 'POST', '/api/repeater/send', { draftId: selected.draftId, confirmedPlanHash }));
      }),
    [apiBase, run, selected],
  );

  return (
    <div className={styles.section}>
      {error !== '' && (
        <Text role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>
          {`Error: ${error}`}
        </Text>
      )}
      <Text className={styles.muted}>
        draft は tab として最大 20 件。編集のたびに revision と計画 hash が進み、画面に表示した hash と一致するときだけ送信します (編集後の古い hash では送信されません)。応答は summary のみ (binary は text 化しません)。
      </Text>
      <Field label="対象 URL (scope 内)">
        <Input value={newTargetUrl} onChange={(_, data) => setNewTargetUrl(data.value)} />
      </Field>
      <Button appearance="primary" disabled={busy || drafts.length >= 20} onClick={() => void createDraft()}>
        新規 draft を作る
      </Button>
      {drafts.length > 0 && (
        <div className={styles.tabs}>
          {drafts.map((draft) => (
            <Button
              key={draft.draftId}
              size="small"
              appearance={selected?.draftId === draft.draftId ? 'primary' : 'secondary'}
              onClick={() => setSelected(draft)}
            >
              {`${draft.draftId} (r${draft.revision})`}
            </Button>
          ))}
        </div>
      )}
      {selected !== null && (
        <div className={styles.section}>
          <Text weight="semibold">{`${selected.draftId} — ${selected.targetUrl} (${selected.protocol}) revision ${selected.revision}`}</Text>
          <Field label="headers (1行1件・Name: Value)">
            <Textarea value={headersText} onChange={(_, data) => setHeadersText(data.value)} rows={3} />
          </Field>
          <Field label="body">
            <Textarea value={bodyText} onChange={(_, data) => setBodyText(data.value)} rows={3} />
          </Field>
          <Button disabled={busy} onClick={() => void applyEdit()}>
            編集を適用する
          </Button>
          <Text block style={{ whiteSpace: 'pre-wrap' }}>{`要求 (canonical):\n${selected.requestBytes}`}</Text>
          <Text>{`計画 hash: ${selected.planHash}`}</Text>
          <div className={styles.tabs}>
            <Button appearance="primary" disabled={busy} onClick={() => void send(selected.planHash)}>
              この hash を確認して送信する
            </Button>
            {drafts.find((draft) => draft.draftId === selected.draftId)?.planHash !== undefined &&
              selected.revision > 1 &&
              (() => {
                // 編集前の hash で送信を試みる導線 (hash 保護の実演) は持たせない。
                // 不一致は API が拒否するだけで、UI からは常に現行 hash のみ送る。
                return null;
              })()}
          </div>
          {sendResult !== null && (
            <div className={styles.section}>
              {sendResult.sent ? (
                <>
                  <Text role="status">{`送信しました (${sendResult.attempt?.outcome})。応答: ${sendResult.response?.status} ${sendResult.response?.contentType} (${sendResult.response?.bodyBytes} bytes)`}</Text>
                  {sendResult.response?.bodyPreview !== undefined && (
                    <Text block style={{ whiteSpace: 'pre-wrap' }}>
                      {sendResult.response.bodyPreview}
                    </Text>
                  )}
                </>
              ) : (
                <Text role="alert">{`送信しませんでした: ${sendResult.reason ?? ''}`}</Text>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
