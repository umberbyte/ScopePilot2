/**
 * A10 Decoder / Comparer / Sequencer。`docs/detailed-design/f06-decoder-comparer.md`・f07。
 * 標準 codec の chain 復号とテキスト行差分 (+ provenance hash) を API 経由で提供する。

 */
import React, { useCallback, useEffect, useState } from 'react';
import { MessageBar, Button, Checkbox, Field, Input, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea, tokens } from '@fluentui/react-components';
import { t } from './resources.ts';

const CODECS = ['base64', 'url', 'hex', 'html-entity', 'gzip', 'deflate-raw'] as const;

interface DecodeResult {
  readonly outputText?: string;
  readonly outputBase64: string;
  readonly outputBytes: number;
}

interface CompareResult {
  readonly equal: boolean;
  readonly leftLineCount: number;
  readonly rightLineCount: number;
  readonly differingLines: readonly { line: number; left: string; right: string }[];
  readonly provenance: { leftHash: string; rightHash: string; options: { normalizeNewlines?: boolean } };
}

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '4px' },
  muted: { color: tokens.colorNeutralForeground3 },
  chips: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
});

async function callJson<T>(apiBase: string, path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    ...(body === undefined && method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export function DecoderComparerScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [inputText, setInputText] = useState('');
  const [chain, setChain] = useState<readonly string[]>([]);
  const [decodeResult, setDecodeResult] = useState<DecodeResult | null>(null);
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [normalizeNewlines, setNormalizeNewlines] = useState(true);
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [sequencerTarget, setSequencerTarget] = useState('http://fixture.target.test/session-token');
  const [sequencerSamples, setSequencerSamples] = useState('100');
  const [sequencerResult, setSequencerResult] = useState<{ verdict: string; sampleCount: number; duplicates: number; missing: number; shannonEntropyBitsPerByte?: number; distinctByteValues?: number; minimum?: number } | null>(null);
  const [oastTarget, setOastTarget] = useState('http://fixture.target.test/callback');
  const [oastProtocol, setOastProtocol] = useState('http');
  const [oastToken, setOastToken] = useState('');
  const [oastResult, setOastResult] = useState<string>('');
  const [wsTarget, setWsTarget] = useState('http://fixture.target.test/ws');
  const [wsImportText, setWsImportText] = useState('');
  const [wsSendText, setWsSendText] = useState('');
  const [wsNotice, setWsNotice] = useState('');
  const [wsFrames, setWsFrames] = useState<readonly { frameId: string; direction: string; text: string; rawHash: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const runDecode = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setDecodeResult(await callJson<DecodeResult>(apiBase, '/api/tools/decode', { inputText, codecs: chain }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, chain, inputText]);

  const runCompare = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setCompareResult(await callJson<CompareResult>(apiBase, '/api/tools/compare-text', { left, right, normalizeNewlines }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, left, normalizeNewlines, right]);

  const runSequencer = useCallback(async () => {
    setBusy(true);
    setError('');
    setSequencerResult(null);
    try {
      const samples = Number(sequencerSamples);
      setSequencerResult(await callJson<{ verdict: string; sampleCount: number; duplicates: number; missing: number; shannonEntropyBitsPerByte?: number; distinctByteValues?: number; minimum?: number }>(apiBase, '/api/tools/sequencer/runs', { targetUrl: sequencerTarget, samples }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, sequencerSamples, sequencerTarget]);

  const loadWsFrames = useCallback(async () => {
    try {
      const body = await callJson<{ frames: readonly { frameId: string; direction: string; text: string; rawHash: string }[] }>(apiBase, '/api/websocket/frames', undefined, 'GET');
      setWsFrames(body.frames);
    } catch {
      // 一覧の取得失敗は個別操作の error 表示に任せる。
    }
  }, [apiBase]);

  useEffect(() => {
    void loadWsFrames();
  }, [loadWsFrames]);

  const importWsFrames = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const payloads = wsImportText.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      const result = await callJson<{ imported: number; duplicates: number }>(apiBase, '/api/websocket/frames', {
        targetUrl: wsTarget,
        frames: payloads.map((payload) => ({ direction: 'received', payload })),
      });
      setWsNotice(t('a10.wsImported', { imported: result.imported, duplicates: result.duplicates }));
      await loadWsFrames();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, loadWsFrames, wsImportText, wsTarget]);

  const sendWsMessages = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const messages = wsSendText.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      const result = await callJson<{ planHash: string; sent: number; rejected: string | null }>(apiBase, '/api/websocket/send', { targetUrl: wsTarget, messages });
      setWsNotice(result.rejected === null ? t('a10.wsSent', { sent: result.sent }) : t('a10.wsRejected', { rejected: result.rejected, sent: result.sent }));
      await loadWsFrames();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, loadWsFrames, wsSendText, wsTarget]);

  const startOastAttempt = useCallback(async () => {
    setBusy(true);
    setError('');
    setOastResult('');
    try {
      const result = await callJson<{ attemptId: string; token: string; waitMs: number }>(apiBase, '/api/oast/attempts', { targetUrl: oastTarget, protocol: oastProtocol });
      setOastToken(result.token);
      setOastResult(t('a10.oastStarted', { attemptId: result.attemptId, waitHours: Math.round(result.waitMs / 3_600_000) }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, oastProtocol, oastTarget]);

  const recordOastCallback = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const result = await callJson<{ kept: number; duplicates: number; correlated: number; uncorrelated: number }>(apiBase, '/api/oast/callbacks', {
        events: [{ eventId: `fixture-${Date.now()}`, token: oastToken, payload: 'fixture interaction' }],
      });
      setOastResult(t('a10.oastRecorded', { correlated: result.correlated, uncorrelated: result.uncorrelated, duplicates: result.duplicates }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, oastToken]);

  return (
    <div className={styles.section}>
      {error !== '' && (
        <MessageBar intent="error">
          {`Error: ${error}`}
        </MessageBar>
      )}
      <Text weight="semibold">{t('a10.decoderTitle')}</Text>
      <Field label={t('a10.inputLabel')}>
        <Textarea value={inputText} onChange={(_, data) => setInputText(data.value)} rows={3} />
      </Field>
      <div className={styles.chips}>
        {CODECS.map((codec) => (
          <Button key={codec} size="small" disabled={busy} onClick={() => setChain((current) => [...current, codec])}>
            {t('a10.addCodec', { codec })}
          </Button>
        ))}
      </div>
      <Text className={styles.muted}>{chain.length === 0 ? t('a10.chainEmpty') : t('a10.chainBuilt', { chain: chain.join(' → ') })}</Text>
      {chain.length > 0 && (
        <Button size="small" onClick={() => setChain((current) => current.slice(0, -1))}>
          {t('a10.removeLastCodec')}
        </Button>
      )}
      <Button appearance="primary" disabled={busy || chain.length === 0 || inputText === ''} onClick={() => void runDecode()}>
        {t('a10.decode')}
      </Button>
      {decodeResult !== null && (
        <div className={styles.section}>
          <Text>{t('a10.output', { bytes: decodeResult.outputBytes })}</Text>
          <Text block style={{ whiteSpace: 'pre-wrap' }}>
            {decodeResult.outputText ?? t('a10.binaryOutput', { base64: decodeResult.outputBase64 })}
          </Text>
        </div>
      )}
      <Text weight="semibold">{t('a10.comparerTitle')}</Text>
      <Field label={t('a10.leftLabel')}>
        <Textarea value={left} onChange={(_, data) => setLeft(data.value)} rows={4} />
      </Field>
      <Field label={t('a10.rightLabel')}>
        <Textarea value={right} onChange={(_, data) => setRight(data.value)} rows={4} />
      </Field>
      <Checkbox label={t('a10.normalizeLabel')} checked={normalizeNewlines} onChange={(_, data) => setNormalizeNewlines(data.checked === true)} />
      <Button appearance="primary" disabled={busy || left === '' || right === ''} onClick={() => void runCompare()}>
        {t('a10.compare')}
      </Button>
      {compareResult !== null && (
        <div className={styles.section}>
          <Text>{compareResult.equal ? t('a10.equal') : t('a10.diff', { lines: compareResult.differingLines.length, left: compareResult.leftLineCount, right: compareResult.rightLineCount })}</Text>
          {compareResult.differingLines.length > 0 && (
            <Table size="small" aria-label="行差分">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('a10.col.line')}</TableHeaderCell>
                  <TableHeaderCell>左</TableHeaderCell>
                  <TableHeaderCell>右</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {compareResult.differingLines.map((line) => (
                  <TableRow key={line.line}>
                    <TableCell>{String(line.line)}</TableCell>
                    <TableCell>{line.left}</TableCell>
                    <TableCell>{line.right}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Text className={styles.muted}>{t('a10.provenance', { leftHash: compareResult.provenance.leftHash.slice(0, 12), rightHash: compareResult.provenance.rightHash.slice(0, 12) })}</Text>
        </div>
      )}
      <Text weight="semibold">{t('a10.sequencerTitle')}</Text>
      <Text className={styles.muted}>{t('a10.sequencerIntro')}</Text>
      <Field label={t('common.targetUrlInScope')}>
        <Input value={sequencerTarget} onChange={(_, data) => setSequencerTarget(data.value)} />
      </Field>
      <Field label={t('a10.sequencerSamplesLabel')}>
        <Input value={sequencerSamples} onChange={(_, data) => setSequencerSamples(data.value)} />
      </Field>
      <Button appearance="primary" disabled={busy} onClick={() => void runSequencer()}>
        {t('a10.sequencerRun')}
      </Button>
      {sequencerResult !== null && (
        <div className={styles.section}>
          <Text role="status">{t('a10.sequencerResult', { verdict: sequencerResult.verdict, samples: sequencerResult.sampleCount, duplicates: sequencerResult.duplicates, missing: sequencerResult.missing })}</Text>
          {sequencerResult.shannonEntropyBitsPerByte !== undefined && (
            <Text className={styles.muted}>{t('a10.sequencerEntropy', { entropy: sequencerResult.shannonEntropyBitsPerByte, distinct: sequencerResult.distinctByteValues })}</Text>
          )}
          {sequencerResult.minimum !== undefined && (
            <Text className={styles.muted}>{t('a10.sequencerInsufficient', { minimum: sequencerResult.minimum })}</Text>
          )}
        </div>
      )}
      <Text weight="semibold">{t('a10.oastTitle')}</Text>
      <Text className={styles.muted}>{t('a10.oastIntro')}</Text>
      <Field label={t('a10.oastTargetLabel')}>
        <Input value={oastTarget} onChange={(_, data) => setOastTarget(data.value)} />
      </Field>
      <Field label={t('a10.oastProtocolLabel')}>
        <Input value={oastProtocol} onChange={(_, data) => setOastProtocol(data.value)} />
      </Field>
      <Button appearance="primary" disabled={busy} onClick={() => void startOastAttempt()}>
        {t('a10.oastStart')}
      </Button>
      {oastToken !== '' && (
        <div className={styles.section}>
          <Text role="status">{t('a10.oastToken', { token: oastToken })}</Text>
          <Button disabled={busy} onClick={() => void recordOastCallback()}>
            {t('a10.oastRecord')}
          </Button>
        </div>
      )}
      {oastResult !== '' && <Text>{oastResult}</Text>}
      <Text weight="semibold">{t('a10.wsTitle')}</Text>
      <Text className={styles.muted}>{t('a10.wsIntro')}</Text>
      <Field label={t('a10.wsTargetLabel')}>
        <Input value={wsTarget} onChange={(_, data) => setWsTarget(data.value)} />
      </Field>
      <Field label={t('a10.wsImportLabel')}>
        <Textarea value={wsImportText} onChange={(_, data) => setWsImportText(data.value)} rows={2} />
      </Field>
      <Button disabled={busy} onClick={() => void importWsFrames()}>
        {t('a10.wsImport')}
      </Button>
      <Field label={t('a10.wsSendLabel')}>
        <Textarea value={wsSendText} onChange={(_, data) => setWsSendText(data.value)} rows={2} />
      </Field>
      <Button appearance="primary" disabled={busy} onClick={() => void sendWsMessages()}>
        {t('a10.wsSend')}
      </Button>
      {wsNotice !== '' && <Text role="status">{wsNotice}</Text>}
      {wsFrames.length > 0 && (
        <Table size="small" aria-label={t('a10.wsTable.aria')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>frameId</TableHeaderCell>
              <TableHeaderCell>{t('a10.ws.col.direction')}</TableHeaderCell>
              <TableHeaderCell>{t('a10.ws.col.text')}</TableHeaderCell>
              <TableHeaderCell>{t('a10.ws.col.rawHash')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {wsFrames.map((frame) => (
              <TableRow key={frame.frameId}>
                <TableCell>{frame.frameId}</TableCell>
                <TableCell>{frame.direction}</TableCell>
                <TableCell>{frame.text}</TableCell>
                <TableCell>{frame.rawHash}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
