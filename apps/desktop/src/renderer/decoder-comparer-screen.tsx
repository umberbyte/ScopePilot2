/**
 * A10 Decoder / Comparer / Sequencer。`docs/detailed-design/f06-decoder-comparer.md`・f07。
 * 標準 codec の chain 復号とテキスト行差分 (+ provenance hash) を API 経由で提供する。

 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MessageBar, Button, Checkbox, Field, Input, makeStyles, ProgressBar, Select, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea, tokens } from '@fluentui/react-components';
import { t } from './resources.ts';

const CODECS = ['base64', 'url', 'hex', 'html-entity', 'gzip', 'deflate-raw'] as const;
type SequencerTokenSource = 'body' | 'cookie' | 'hidden' | 'bearer' | 'custom';

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

interface TransportResult {
  readonly protocol: string;
  readonly downgraded: boolean;
  readonly alpn: string;
  readonly runtime: string;
  readonly response?: {
    readonly statusCode: number;
    readonly elapsedMs: number;
    readonly streamId?: number;
    readonly remoteSettings?: {
      readonly maxFrameSize?: number;
      readonly maxConcurrentStreams?: number;
      readonly initialWindowSize?: number;
    };
  };
}

interface AlphabetClassCounts {
  readonly digit: number;
  readonly lowerAscii: number;
  readonly upperAscii: number;
  readonly base64UrlPunctuation: number;
  readonly base64StandardPunctuation: number;
  readonly padding: number;
  readonly otherAscii: number;
  readonly nonAscii: number;
}

interface SequencerResult {
  readonly tokenSource: SequencerTokenSource;
  readonly requestMethod: string;
  readonly requestHeaderNames: readonly string[];
  readonly requestBodyBytes: number;
  readonly tokenCookieName?: string;
  readonly tokenFieldName?: string;
  readonly tokenStartDelimiter?: string;
  readonly tokenEndDelimiter?: string;
  readonly verdict: string;
  readonly sampleCount: number;
  readonly duplicates: number;
  readonly missing: number;
  readonly shannonEntropyBitsPerByte?: number;
  readonly shannonEntropyBitsPerToken?: number;
  readonly distinctByteValues?: number;
  readonly byteFrequencyBuckets?: readonly number[];
  readonly tokenLengthBucketMinimums?: readonly number[];
  readonly tokenByteLengthBuckets?: readonly number[];
  readonly tokenCharacterLengthBuckets?: readonly number[];
  readonly tokenMaximumCharacterRunLengthBuckets?: readonly number[];
  readonly adjacentTokenBitHammingDistanceBuckets?: readonly number[];
  readonly adjacentTokenHammingUnequalByteLengthPairs?: number;
  readonly adjacentNumericAbsoluteDeltaBuckets?: readonly number[];
  readonly adjacentNumericDeltaSignCounts?: Readonly<{ decreasing: number; unchanged: number; increasing: number }>;
  readonly adjacentNumericIneligiblePairs?: number;
  readonly adjacentNumericSerialCorrelationPairs?: number;
  readonly adjacentNumericSerialCorrelation?: number;
  readonly observedAlphabetSize?: number;
  readonly alphabetClassCounts?: AlphabetClassCounts;
  readonly positionAnalysisLimit?: number;
  readonly positionAlphabetClassCounts?: readonly AlphabetClassCounts[];
  readonly positionOverflowSamples?: number;
  readonly minimum?: number;
  readonly sessionCookieNames?: readonly string[];
}

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '4px' },
  muted: { color: tokens.colorNeutralForeground3 },
  chips: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
  byteChart: { display: 'grid', gridTemplateColumns: 'max-content minmax(120px, 1fr) max-content', gap: '4px 8px', alignItems: 'center', maxWidth: '640px' },
  byteChartTitle: { gridColumn: '1 / -1' },
  positionTable: { maxHeight: '480px', maxWidth: '100%', overflow: 'auto' },
});

async function callJson<T>(apiBase: string, path: string, body?: unknown, method: 'GET' | 'POST' = 'POST', signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    ...(body === undefined && method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function lengthBucketRange(minimums: readonly number[], index: number): string {
  const minimum = minimums[index] ?? 0;
  const nextMinimum = minimums[index + 1];
  if (nextMinimum === undefined) {
    return `${minimum}+`;
  }
  const maximum = nextMinimum - 1;
  return minimum === maximum ? `${minimum}` : `${minimum}–${maximum}`;
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
  const [sequencerTokenSource, setSequencerTokenSource] = useState<SequencerTokenSource>('body');
  const [sequencerTokenCookieName, setSequencerTokenCookieName] = useState('SEQ_TOKEN');
  const [sequencerTokenFieldName, setSequencerTokenFieldName] = useState('csrf_token');
  const [sequencerTokenStartDelimiter, setSequencerTokenStartDelimiter] = useState('token="');
  const [sequencerTokenEndDelimiter, setSequencerTokenEndDelimiter] = useState('"');
  const [sequencerRequestMethod, setSequencerRequestMethod] = useState('GET');
  const [sequencerRequestHeaders, setSequencerRequestHeaders] = useState('');
  const [sequencerRequestBody, setSequencerRequestBody] = useState('');
  const [sequencerRole, setSequencerRole] = useState('');
  const [sequencerResult, setSequencerResult] = useState<SequencerResult | null>(null);
  const [sequencerRunning, setSequencerRunning] = useState(false);
  const [sequencerNotice, setSequencerNotice] = useState('');
  const sequencerAbort = useRef<AbortController | null>(null);
  const [oastTarget, setOastTarget] = useState('http://fixture.target.test/callback');
  const [oastProtocol, setOastProtocol] = useState('http');
  const [oastToken, setOastToken] = useState('');
  const [oastResult, setOastResult] = useState<string>('');
  const [wsTarget, setWsTarget] = useState('http://fixture.target.test/ws');
  const [wsRole, setWsRole] = useState('');
  const [wsSubprotocolsText, setWsSubprotocolsText] = useState('');
  const [wsImportText, setWsImportText] = useState('');
  const [wsSendText, setWsSendText] = useState('');
  const [wsNotice, setWsNotice] = useState('');
  const [wsSessionCookieNames, setWsSessionCookieNames] = useState<readonly string[] | undefined>(undefined);
  const [wsNegotiatedSubprotocol, setWsNegotiatedSubprotocol] = useState<string | undefined>(undefined);
  const [wsFrames, setWsFrames] = useState<readonly { frameId: string; direction: string; text: string; rawHash: string }[]>([]);
  const [transportTarget, setTransportTarget] = useState('http://fixture.target.test/api');
  const [transportRequested, setTransportRequested] = useState<'h2' | 'http/1.1'>('h2');
  const [transportAllowFallback, setTransportAllowFallback] = useState(true);
  const [transportResult, setTransportResult] = useState<TransportResult | null>(null);
  const [headerText, setHeaderText] = useState(':method: GET\n:scheme: http\n:authority: fixture.target.test\n:path: /');
  const [headerResult, setHeaderResult] = useState('');
  const [domTarget, setDomTarget] = useState('http://fixture.target.test/app');
  const [domLive, setDomLive] = useState(false);
  const [domRole, setDomRole] = useState('');
  const [domObservationsText, setDomObservationsText] = useState('');
  const [domNodesText, setDomNodesText] = useState('');
  const [domResult, setDomResult] = useState<{ candidates: readonly { sourceApi: string; sinkApi: string; confidence: number; marker: string }[]; evidence: readonly string[] } | null>(null);
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
    const controller = new AbortController();
    sequencerAbort.current = controller;
    setBusy(true);
    setSequencerRunning(true);
    setError('');
    setSequencerNotice('');
    setSequencerResult(null);
    try {
      const samples = Number(sequencerSamples);
      const replayHeaders = sequencerRequestHeaders
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.trim() !== '')
        .map((line): readonly [string, string] => {
          const separator = line.indexOf(':');
          if (separator <= 0) throw new Error(t('a10.sequencerReplayHeaderFormatError'));
          return [line.slice(0, separator).trim(), line.slice(separator + 1).trimStart()];
        });
      setSequencerResult(await callJson<SequencerResult>(apiBase, '/api/tools/sequencer/runs', {
        targetUrl: sequencerTarget,
        samples,
        tokenSource: sequencerTokenSource,
        ...(sequencerTokenSource === 'cookie' ? { tokenCookieName: sequencerTokenCookieName } : {}),
        ...(sequencerTokenSource === 'hidden' ? { tokenFieldName: sequencerTokenFieldName } : {}),
        ...(sequencerTokenSource === 'custom' ? { tokenStartDelimiter: sequencerTokenStartDelimiter, tokenEndDelimiter: sequencerTokenEndDelimiter } : {}),
        ...(sequencerRole.trim() === '' ? {} : { role: sequencerRole.trim() }),
        replayRequest: { method: sequencerRequestMethod, headers: replayHeaders, body: sequencerRequestBody },
      }, 'POST', controller.signal));
    } catch (cause) {
      if (controller.signal.aborted) {
        setSequencerNotice(t('a10.sequencerCancelled'));
      } else {
        setError(String(cause));
      }
    } finally {
      if (sequencerAbort.current === controller) {
        sequencerAbort.current = null;
        setSequencerRunning(false);
        setBusy(false);
      }
    }
  }, [apiBase, sequencerRequestBody, sequencerRequestHeaders, sequencerRequestMethod, sequencerRole, sequencerSamples, sequencerTarget, sequencerTokenCookieName, sequencerTokenEndDelimiter, sequencerTokenFieldName, sequencerTokenSource, sequencerTokenStartDelimiter]);

  const stopSequencer = useCallback(() => {
    const controller = sequencerAbort.current;
    if (controller !== null && !controller.signal.aborted) {
      setSequencerNotice(t('a10.sequencerCancelRequested'));
      controller.abort();
    }
  }, []);

  useEffect(() => () => {
    sequencerAbort.current?.abort();
  }, []);

  const analyzeDomFlowsAction = useCallback(async () => {
    setBusy(true);
    setError('');
    setDomResult(null);
    try {
      const observations = domObservationsText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line): { api: string; marker: string } => {
          const separator = line.indexOf(':');
          return separator === -1 ? { api: line, marker: '' } : { api: line.slice(0, separator).trim(), marker: line.slice(separator + 1).trim() };
        });
      const nodes = domNodesText
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line !== '')
        .map((line) => ({ text: line.replace(/^pii:\s*/, ''), looksLikePii: line.startsWith('pii:') }));
      setDomResult(await callJson<{ candidates: readonly { sourceApi: string; sinkApi: string; confidence: number; marker: string }[]; evidence: readonly string[] }>(apiBase, '/api/tools/dom-flows', {
        targetUrl: domTarget,
        observations,
        nodes,
        live: domLive,
        ...(!domLive || domRole.trim() === '' ? {} : { role: domRole.trim() }),
      }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, domLive, domNodesText, domObservationsText, domRole, domTarget]);

  const negotiate = useCallback(async () => {
    setBusy(true);
    setError('');
    setTransportResult(null);
    try {
      setTransportResult(await callJson<TransportResult>(apiBase, '/api/tools/transport/negotiate', {
        targetUrl: transportTarget,
        requested: transportRequested,
        allowFallback: transportAllowFallback,
      }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, transportAllowFallback, transportRequested, transportTarget]);

  const validateHeaders = useCallback(async () => {
    setBusy(true);
    setError('');
    setHeaderResult('');
    try {
      const headers = headerText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line): readonly [string, string] => {
          // pseudo header は先頭 ':' から始まるため区切りは 2 文字目以降で探す。
          const separator = line.indexOf(':', 1);
          return separator === -1 ? [line, ''] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
        });
      const result = await callJson<{ ordered: readonly string[]; authority: string }>(apiBase, '/api/tools/transport/validate-headers', { headers, scheme: 'http' });
      setHeaderResult(t('a10.transportHeadersOk', { ordered: result.ordered.join(', ') || '—', authority: result.authority }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, headerText]);

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
    setWsSessionCookieNames(undefined);
    setWsNegotiatedSubprotocol(undefined);
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
    setWsSessionCookieNames(undefined);
    setWsNegotiatedSubprotocol(undefined);
    try {
      const messages = wsSendText.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      const subprotocols = wsSubprotocolsText.split(',').map((value) => value.trim()).filter((value) => value !== '');
      const result = await callJson<{ planHash: string; sent: number; rejected: string | null; sessionCookieNames?: readonly string[]; negotiatedSubprotocol?: string }>(apiBase, '/api/websocket/send', {
        targetUrl: wsTarget,
        messages,
        ...(wsRole.trim() === '' ? {} : { role: wsRole.trim() }),
        ...(subprotocols.length === 0 ? {} : { subprotocols }),
      });
      setWsNotice(result.rejected === null ? t('a10.wsSent', { sent: result.sent }) : t('a10.wsRejected', { rejected: result.rejected, sent: result.sent }));
      setWsSessionCookieNames(result.sessionCookieNames);
      setWsNegotiatedSubprotocol(result.negotiatedSubprotocol);
      await loadWsFrames();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, loadWsFrames, wsRole, wsSendText, wsSubprotocolsText, wsTarget]);

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
      <Field label={t('a10.sequencerTokenSourceLabel')}>
        <Select value={sequencerTokenSource} onChange={(_, data) => setSequencerTokenSource(data.value as SequencerTokenSource)}>
          <option value="body">{t('a10.sequencerTokenSource.body')}</option>
          <option value="cookie">{t('a10.sequencerTokenSource.cookie')}</option>
          <option value="hidden">{t('a10.sequencerTokenSource.hidden')}</option>
          <option value="bearer">{t('a10.sequencerTokenSource.bearer')}</option>
          <option value="custom">{t('a10.sequencerTokenSource.custom')}</option>
        </Select>
      </Field>
      {sequencerTokenSource === 'cookie' && (
        <Field label={t('a10.sequencerTokenCookieNameLabel')}>
          <Input value={sequencerTokenCookieName} onChange={(_, data) => setSequencerTokenCookieName(data.value)} />
        </Field>
      )}
      {sequencerTokenSource === 'hidden' && (
        <Field label={t('a10.sequencerTokenFieldNameLabel')}>
          <Input value={sequencerTokenFieldName} onChange={(_, data) => setSequencerTokenFieldName(data.value)} />
        </Field>
      )}
      {sequencerTokenSource === 'custom' && (
        <>
          <Field label={t('a10.sequencerTokenStartDelimiterLabel')}>
            <Input value={sequencerTokenStartDelimiter} onChange={(_, data) => setSequencerTokenStartDelimiter(data.value)} />
          </Field>
          <Field label={t('a10.sequencerTokenEndDelimiterLabel')}>
            <Input value={sequencerTokenEndDelimiter} onChange={(_, data) => setSequencerTokenEndDelimiter(data.value)} />
          </Field>
        </>
      )}
      <Field label={t('a10.sequencerRequestMethodLabel')}>
        <Input value={sequencerRequestMethod} onChange={(_, data) => setSequencerRequestMethod(data.value)} />
      </Field>
      <Field label={t('a10.sequencerRequestHeadersLabel')} hint={t('a10.sequencerRequestHeadersHint')}>
        <Textarea value={sequencerRequestHeaders} onChange={(_, data) => setSequencerRequestHeaders(data.value)} resize="vertical" />
      </Field>
      <Field label={t('a10.sequencerRequestBodyLabel')}>
        <Textarea value={sequencerRequestBody} onChange={(_, data) => setSequencerRequestBody(data.value)} resize="vertical" />
      </Field>
      <Field label={t('a10.sequencerRoleLabel')}>
        <Input value={sequencerRole} onChange={(_, data) => setSequencerRole(data.value)} />
      </Field>
      <div className={styles.chips}>
        <Button appearance="primary" disabled={busy} onClick={() => void runSequencer()}>
          {t('a10.sequencerRun')}
        </Button>
        {sequencerRunning && (
          <Button onClick={stopSequencer}>{t('a10.sequencerStop')}</Button>
        )}
      </div>
      {sequencerNotice !== '' && <Text role="status">{sequencerNotice}</Text>}
      {sequencerResult !== null && (
        <div className={styles.section} data-testid="sequencer-result">
          <Text role="status">{t('a10.sequencerResult', { verdict: sequencerResult.verdict, samples: sequencerResult.sampleCount, duplicates: sequencerResult.duplicates, missing: sequencerResult.missing })}</Text>
          <Text className={styles.muted}>{t('a10.sequencerExtractorUsed', {
            source: sequencerResult.tokenSource === 'body'
              ? t('a10.sequencerTokenSource.body')
              : sequencerResult.tokenSource === 'cookie'
                ? `${t('a10.sequencerTokenSource.cookie')} (${sequencerResult.tokenCookieName ?? '—'})`
                : sequencerResult.tokenSource === 'hidden'
                  ? `${t('a10.sequencerTokenSource.hidden')} (${sequencerResult.tokenFieldName ?? '—'})`
                  : sequencerResult.tokenSource === 'bearer'
                    ? t('a10.sequencerTokenSource.bearer')
                    : `${t('a10.sequencerTokenSource.custom')} (${sequencerResult.tokenStartDelimiter ?? '—'} … ${sequencerResult.tokenEndDelimiter ?? '—'})`,
          })}</Text>
          <Text className={styles.muted}>{t('a10.sequencerReplaySummary', {
            method: sequencerResult.requestMethod,
            headers: sequencerResult.requestHeaderNames.join(', ') || '—',
            bytes: sequencerResult.requestBodyBytes,
          })}</Text>
          {sequencerResult.sessionCookieNames !== undefined && (
            <Text className={styles.muted}>{t('a10.sequencerSessionApplied', { cookies: sequencerResult.sessionCookieNames.join(', ') || '—' })}</Text>
          )}
          {sequencerResult.shannonEntropyBitsPerByte !== undefined && (
            <Text className={styles.muted}>{t('a10.sequencerEntropy', { entropy: sequencerResult.shannonEntropyBitsPerByte, distinct: sequencerResult.distinctByteValues })}</Text>
          )}
          {sequencerResult.shannonEntropyBitsPerToken !== undefined && (
            <Text className={styles.muted}>{t('a10.sequencerTokenEntropy', { entropy: sequencerResult.shannonEntropyBitsPerToken })}</Text>
          )}
          {sequencerResult.byteFrequencyBuckets !== undefined && (() => {
            const maximum = Math.max(1, ...sequencerResult.byteFrequencyBuckets);
            const total = sequencerResult.byteFrequencyBuckets.reduce((sum, count) => sum + count, 0);
            return (
              <div className={styles.byteChart} role="group" aria-label={t('a10.sequencerByteChart')}>
                <Text weight="semibold" className={styles.byteChartTitle}>{t('a10.sequencerByteChart')}</Text>
                {sequencerResult.byteFrequencyBuckets.map((count, index) => {
                  const start = (index * 16).toString(16).padStart(2, '0').toUpperCase();
                  const end = (index * 16 + 15).toString(16).padStart(2, '0').toUpperCase();
                  const range = `${start}–${end}`;
                  return (
                    <React.Fragment key={range}>
                      <Text>{range}</Text>
                      <ProgressBar
                        value={count / maximum}
                        aria-label={t('a10.sequencerByteBucket', { range, count, total })}
                      />
                      <Text>{count}</Text>
                    </React.Fragment>
                  );
                })}
              </div>
            );
          })()}
          {sequencerResult.tokenLengthBucketMinimums !== undefined
            && sequencerResult.tokenByteLengthBuckets !== undefined
            && sequencerResult.tokenCharacterLengthBuckets !== undefined
            && [
              { title: t('a10.sequencerByteLengthChart'), counts: sequencerResult.tokenByteLengthBuckets, pairCounts: false },
              { title: t('a10.sequencerCharacterLengthChart'), counts: sequencerResult.tokenCharacterLengthBuckets, pairCounts: false },
              ...(sequencerResult.tokenMaximumCharacterRunLengthBuckets === undefined ? [] : [
                { title: t('a10.sequencerCharacterRunLengthChart'), counts: sequencerResult.tokenMaximumCharacterRunLengthBuckets, pairCounts: false },
              ]),
              ...(sequencerResult.adjacentTokenBitHammingDistanceBuckets === undefined ? [] : [
                { title: t('a10.sequencerHammingDistanceChart'), counts: sequencerResult.adjacentTokenBitHammingDistanceBuckets, pairCounts: true },
              ]),
              ...(sequencerResult.adjacentNumericAbsoluteDeltaBuckets === undefined ? [] : [
                { title: t('a10.sequencerNumericDeltaChart'), counts: sequencerResult.adjacentNumericAbsoluteDeltaBuckets, pairCounts: true },
              ]),
            ].map(({ title, counts, pairCounts }) => {
              const maximum = Math.max(1, ...counts);
              const total = counts.reduce((sum, count) => sum + count, 0);
              return (
                <div key={title} className={styles.byteChart} role="group" aria-label={title}>
                  <Text weight="semibold" className={styles.byteChartTitle}>{title}</Text>
                  {counts.map((count, index) => {
                    const range = lengthBucketRange(sequencerResult.tokenLengthBucketMinimums ?? [], index);
                    return (
                      <React.Fragment key={range}>
                        <Text>{range}</Text>
                        <ProgressBar
                          value={count / maximum}
                          aria-label={t(pairCounts ? 'a10.sequencerPairBucket' : 'a10.sequencerLengthBucket', { kind: title, range, count, total })}
                        />
                        <Text>{count}</Text>
                      </React.Fragment>
                    );
                  })}
                </div>
              );
            })}
          {sequencerResult.adjacentTokenHammingUnequalByteLengthPairs !== undefined && (
            <Text className={styles.muted}>{t('a10.sequencerHammingUnequalPairs', { count: sequencerResult.adjacentTokenHammingUnequalByteLengthPairs })}</Text>
          )}
          {sequencerResult.adjacentNumericDeltaSignCounts !== undefined && sequencerResult.adjacentNumericIneligiblePairs !== undefined && (
            <Text className={styles.muted}>{t('a10.sequencerNumericDeltaSummary', {
              decreasing: sequencerResult.adjacentNumericDeltaSignCounts.decreasing,
              unchanged: sequencerResult.adjacentNumericDeltaSignCounts.unchanged,
              increasing: sequencerResult.adjacentNumericDeltaSignCounts.increasing,
              ineligible: sequencerResult.adjacentNumericIneligiblePairs,
            })}</Text>
          )}
          {sequencerResult.adjacentNumericSerialCorrelationPairs !== undefined && (
            <Text className={styles.muted}>{sequencerResult.adjacentNumericSerialCorrelation === undefined
              ? t('a10.sequencerSerialCorrelationUnavailable', { pairs: sequencerResult.adjacentNumericSerialCorrelationPairs })
              : t('a10.sequencerSerialCorrelation', { correlation: sequencerResult.adjacentNumericSerialCorrelation, pairs: sequencerResult.adjacentNumericSerialCorrelationPairs })}</Text>
          )}
          {sequencerResult.observedAlphabetSize !== undefined && sequencerResult.alphabetClassCounts !== undefined && (() => {
            const rows = [
              { label: t('a10.sequencerAlphabetClass.digit'), count: sequencerResult.alphabetClassCounts.digit },
              { label: t('a10.sequencerAlphabetClass.lowerAscii'), count: sequencerResult.alphabetClassCounts.lowerAscii },
              { label: t('a10.sequencerAlphabetClass.upperAscii'), count: sequencerResult.alphabetClassCounts.upperAscii },
              { label: t('a10.sequencerAlphabetClass.base64UrlPunctuation'), count: sequencerResult.alphabetClassCounts.base64UrlPunctuation },
              { label: t('a10.sequencerAlphabetClass.base64StandardPunctuation'), count: sequencerResult.alphabetClassCounts.base64StandardPunctuation },
              { label: t('a10.sequencerAlphabetClass.padding'), count: sequencerResult.alphabetClassCounts.padding },
              { label: t('a10.sequencerAlphabetClass.otherAscii'), count: sequencerResult.alphabetClassCounts.otherAscii },
              { label: t('a10.sequencerAlphabetClass.nonAscii'), count: sequencerResult.alphabetClassCounts.nonAscii },
            ];
            const maximum = Math.max(1, ...rows.map(({ count }) => count));
            const total = rows.reduce((sum, { count }) => sum + count, 0);
            return (
              <div className={styles.byteChart} role="group" aria-label={t('a10.sequencerAlphabetChart')}>
                <Text weight="semibold" className={styles.byteChartTitle}>{t('a10.sequencerAlphabetChart')}</Text>
                <Text className={styles.byteChartTitle}>{t('a10.sequencerAlphabetSummary', { size: sequencerResult.observedAlphabetSize })}</Text>
                {rows.map(({ label, count }) => (
                  <React.Fragment key={label}>
                    <Text>{label}</Text>
                    <ProgressBar
                      value={count / maximum}
                      aria-label={t('a10.sequencerAlphabetBucket', { class: label, count, total })}
                    />
                    <Text>{count}</Text>
                  </React.Fragment>
                ))}
              </div>
            );
          })()}
          {sequencerResult.positionAnalysisLimit !== undefined
            && sequencerResult.positionAlphabetClassCounts !== undefined
            && sequencerResult.positionOverflowSamples !== undefined && (
              <div className={styles.section} role="group" aria-label={t('a10.sequencerPositionChart')}>
                <Text weight="semibold">{t('a10.sequencerPositionChart')}</Text>
                <Text className={styles.muted}>
                  {t('a10.sequencerPositionSummary', {
                    limit: sequencerResult.positionAnalysisLimit,
                    overflow: sequencerResult.positionOverflowSamples,
                  })}
                </Text>
                <div className={styles.positionTable}>
                  <Table size="extra-small" aria-label={t('a10.sequencerPositionChart')}>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>{t('a10.sequencerPosition')}</TableHeaderCell>
                        <TableHeaderCell>{t('a10.sequencerAlphabetClass.digit')}</TableHeaderCell>
                        <TableHeaderCell>{t('a10.sequencerAlphabetClass.lowerAscii')}</TableHeaderCell>
                        <TableHeaderCell>{t('a10.sequencerAlphabetClass.upperAscii')}</TableHeaderCell>
                        <TableHeaderCell>{t('a10.sequencerAlphabetClass.base64UrlPunctuation')}</TableHeaderCell>
                        <TableHeaderCell>{t('a10.sequencerAlphabetClass.base64StandardPunctuation')}</TableHeaderCell>
                        <TableHeaderCell>{t('a10.sequencerAlphabetClass.padding')}</TableHeaderCell>
                        <TableHeaderCell>{t('a10.sequencerAlphabetClass.otherAscii')}</TableHeaderCell>
                        <TableHeaderCell>{t('a10.sequencerAlphabetClass.nonAscii')}</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sequencerResult.positionAlphabetClassCounts.map((counts, position) => (
                        <TableRow key={position}>
                          <TableCell>{position + 1}</TableCell>
                          <TableCell>{counts.digit}</TableCell>
                          <TableCell>{counts.lowerAscii}</TableCell>
                          <TableCell>{counts.upperAscii}</TableCell>
                          <TableCell>{counts.base64UrlPunctuation}</TableCell>
                          <TableCell>{counts.base64StandardPunctuation}</TableCell>
                          <TableCell>{counts.padding}</TableCell>
                          <TableCell>{counts.otherAscii}</TableCell>
                          <TableCell>{counts.nonAscii}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
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
          {oastToken.includes('.') ? (
            <Text className={styles.muted}>{t('a10.oastWaiting')}</Text>
          ) : (
            <Button disabled={busy} onClick={() => void recordOastCallback()}>
              {t('a10.oastRecord')}
            </Button>
          )}
        </div>
      )}
      {oastResult !== '' && <Text>{oastResult}</Text>}
      <Text weight="semibold">{t('a10.wsTitle')}</Text>
      <Text className={styles.muted}>{t('a10.wsIntro')}</Text>
      <Field label={t('a10.wsTargetLabel')}>
        <Input value={wsTarget} onChange={(_, data) => setWsTarget(data.value)} />
      </Field>
      <Field label={t('a10.wsRoleLabel')}>
        <Input value={wsRole} onChange={(_, data) => setWsRole(data.value)} />
      </Field>
      <Field label={t('a10.wsSubprotocolsLabel')}>
        <Input value={wsSubprotocolsText} onChange={(_, data) => setWsSubprotocolsText(data.value)} />
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
      {wsSessionCookieNames !== undefined && (
        <Text className={styles.muted}>{t('a10.wsSessionApplied', { cookies: wsSessionCookieNames.join(', ') || '—' })}</Text>
      )}
      {wsNegotiatedSubprotocol !== undefined && (
        <Text className={styles.muted}>{t('a10.wsSubprotocolNegotiated', { protocol: wsNegotiatedSubprotocol })}</Text>
      )}
      <Text weight="semibold">{t('a10.transportTitle')}</Text>
      <Text className={styles.muted}>{t('a10.transportIntro')}</Text>
      <Field label={t('a10.transportTargetLabel')}>
        <Input value={transportTarget} onChange={(_, data) => setTransportTarget(data.value)} />
      </Field>
      <Field label={t('a10.transportRequestedLabel')}>
        <Select value={transportRequested} onChange={(_, data) => setTransportRequested(data.value as 'h2' | 'http/1.1')}>
          <option value="h2">HTTP/2</option>
          <option value="http/1.1">HTTP/1.1</option>
        </Select>
      </Field>
      <Checkbox
        label={t('a10.transportFallbackLabel')}
        checked={transportAllowFallback}
        disabled={transportRequested === 'http/1.1'}
        onChange={(_, data) => setTransportAllowFallback(data.checked === true)}
      />
      <Button appearance="primary" disabled={busy} onClick={() => void negotiate()}>
        {t('a10.transportNegotiate')}
      </Button>
      {transportResult !== null && (
        <Text role="status">{t('a10.transportResult', { protocol: transportResult.protocol, downgraded: transportResult.downgraded ? t('a10.transportDowngraded') : t('a10.transportNoDowngrade'), alpn: transportResult.alpn, runtime: transportResult.runtime })}</Text>
      )}
      {transportResult?.response !== undefined && (
        <Text>{t('a10.transportResponse', {
          status: transportResult.response.statusCode,
          elapsed: transportResult.response.elapsedMs.toFixed(2),
          stream: transportResult.response.streamId ?? '—',
        })}</Text>
      )}
      {transportResult?.response?.remoteSettings !== undefined && (
        <Text className={styles.muted}>{t('a10.transportSettings', {
          maxFrame: transportResult.response.remoteSettings.maxFrameSize ?? '—',
          maxConcurrent: transportResult.response.remoteSettings.maxConcurrentStreams ?? '—',
          initialWindow: transportResult.response.remoteSettings.initialWindowSize ?? '—',
        })}</Text>
      )}
      <Field label={t('a10.transportHeadersLabel')}>
        <Textarea value={headerText} onChange={(_, data) => setHeaderText(data.value)} rows={4} />
      </Field>
      <Button disabled={busy} onClick={() => void validateHeaders()}>
        {t('a10.transportValidate')}
      </Button>
      {headerResult !== '' && <Text role="status">{headerResult}</Text>}
      <Text weight="semibold">{t('a10.domTitle')}</Text>
      <Text className={styles.muted}>{t('a10.domIntro')}</Text>
      <Field label={t('a10.domTargetLabel')}>
        <Input value={domTarget} onChange={(_, data) => setDomTarget(data.value)} />
      </Field>
      <Checkbox label={t('a10.domLiveLabel')} checked={domLive} onChange={(_, data) => setDomLive(data.checked === true)} />
      <Field label={t('a10.domRoleLabel')}>
        <Input disabled={!domLive} value={domRole} onChange={(_, data) => setDomRole(data.value)} />
      </Field>
      <Field label={t('a10.domObservationsLabel')}>
        <Textarea disabled={domLive} value={domObservationsText} onChange={(_, data) => setDomObservationsText(data.value)} rows={3} />
      </Field>
      <Field label={t('a10.domNodesLabel')}>
        <Textarea disabled={domLive} value={domNodesText} onChange={(_, data) => setDomNodesText(data.value)} rows={2} />
      </Field>
      <Button appearance="primary" disabled={busy} onClick={() => void analyzeDomFlowsAction()}>
        {t('a10.domAnalyze')}
      </Button>
      {domResult !== null && (
        <div className={styles.section}>
          <Text role="status">{t('a10.domResult', { count: domResult.candidates.length })}</Text>
          {domResult.candidates.map((candidate) => (
            <Text key={`${candidate.sourceApi}-${candidate.sinkApi}-${candidate.marker}`} className={styles.muted}>
              {t('a10.domCandidate', { source: candidate.sourceApi, sink: candidate.sinkApi, confidence: candidate.confidence, marker: candidate.marker })}
            </Text>
          ))}
          {domResult.evidence.length > 0 && <Text className={styles.muted}>{t('a10.domEvidence', { evidence: domResult.evidence.join(' / ') })}</Text>}
        </div>
      )}
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
