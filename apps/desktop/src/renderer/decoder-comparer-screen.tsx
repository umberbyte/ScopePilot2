/**
 * A10 Decoder / Comparer / Sequencer。`docs/detailed-design/f06-decoder-comparer.md`。
 * 標準 codec の chain 復号とテキスト行差分 (+ provenance hash) を API 経由で提供する。
 * Sequencer (token 収集・乱数解析) は sample 収集機能と共に後続増分。
 */
import React, { useCallback, useState } from 'react';
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

async function callJson<T>(apiBase: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
      <Text className={styles.muted}>{t('a10.sequencerNote')}</Text>
    </div>
  );
}
