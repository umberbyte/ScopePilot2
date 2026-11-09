import type { BinaryComparisonResult } from '@scopepilot2/contracts';
import React, { useCallback, useState } from 'react';
import { MessageBar, Button, Checkbox, Field, makeStyles, Select, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea, tokens } from '@fluentui/react-components';
import { t } from './resources.ts';
import { toolJson } from './tools-api.ts';
const useStyles = makeStyles({ section: { display: 'flex', flexDirection: 'column', gap: '12px' }, muted: { color: tokens.colorNeutralForeground3 }, chips: { display: 'flex', gap: '4px', flexWrap: 'wrap' } });
interface CompareResult {
  readonly equal: boolean;
  readonly leftLineCount: number;
  readonly rightLineCount: number;
  readonly differingLines: readonly { line: number; left: string; right: string }[];
  readonly provenance: { leftHash: string; rightHash: string; options: { normalizeNewlines?: boolean } };
}


export function ComparerScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [normalizeNewlines, setNormalizeNewlines] = useState(true);
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [mode, setMode] = useState<'text' | 'hex'>('text');
  const [binary, setBinary] = useState<BinaryComparisonResult | null>(null);
  const runCompare = useCallback(async (offset = 0) => {
    setBusy(true);
    setError('');
    try {
      setCompareResult(null); setBinary(null);
      if (mode === 'hex') {
        setBinary(await toolJson<BinaryComparisonResult>(apiBase, '/api/tools/compare-binary', { left, right, offset }));
      } else setCompareResult(await toolJson<CompareResult>(apiBase, '/api/tools/compare-text', { left, right, normalizeNewlines }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, left, mode, normalizeNewlines, right]);

  return <section className={styles.section} aria-label="Comparer">
      <Text>{t('tools.comparerPurpose')}</Text>
      <Text>{t('tools.noTraffic')}</Text>
      {error !== '' && <MessageBar intent="error">{error}</MessageBar>}
      <Field label={t('tools.compareMode')} hint={t('tools.hexHint')}><Select disabled={busy} value={mode} onChange={(_, data) => { setMode(data.value as 'text' | 'hex'); setCompareResult(null); setBinary(null); }}><option value="text">{t('tools.textMode')}</option><option value="hex">{t('tools.hexMode')}</option></Select></Field>
      <Text weight="semibold">Comparer</Text>
      <Field label={t('a10.leftLabel')}>
        <Textarea disabled={busy} value={left} onChange={(_, data) => { setLeft(data.value); setCompareResult(null); setBinary(null); }} rows={4} />
      </Field>
      <Field label={t('a10.rightLabel')}>
        <Textarea disabled={busy} value={right} onChange={(_, data) => { setRight(data.value); setCompareResult(null); setBinary(null); }} rows={4} />
      </Field>
      {mode === 'text' && <Checkbox disabled={busy} label={t('a10.normalizeLabel')} checked={normalizeNewlines} onChange={(_, data) => { setNormalizeNewlines(data.checked === true); setCompareResult(null); }} />}
      <Button appearance="primary" disabled={busy} onClick={() => void runCompare()}>
        {t('a10.compare')}
      </Button>
      {compareResult !== null && (
        <div className={styles.section}>
          <Text>{compareResult.equal ? t('a10.equal') : t('a10.diff', { lines: compareResult.differingLines.length, left: compareResult.leftLineCount, right: compareResult.rightLineCount })}</Text>
          {compareResult.differingLines.length > 0 && (
            <Table size="small" aria-label={t('tools.lineDiff')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('a10.col.line')}</TableHeaderCell>
                  <TableHeaderCell>{t('a10.leftLabel')}</TableHeaderCell>
                  <TableHeaderCell>{t('a10.rightLabel')}</TableHeaderCell>
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
      {binary !== null && <div>
        <Text block>{binary.equal ? t('a10.equal') : t('tools.byteSummary', { left: binary.leftBytes, right: binary.rightBytes, offset: binary.firstDifferenceOffset ?? 0 })}</Text>
        {binary.truncated && <MessageBar intent="warning">{t('tools.truncated', { count: binary.differingRows })}</MessageBar>}
        <Text block>{t('tools.range', { offset: binary.offset })}</Text>
        <Button disabled={busy || binary.offset === 0} onClick={() => void runCompare(binary.offset - 65536)}>{t('tools.previousRange')}</Button>
        <Button disabled={busy || binary.nextOffset === null} onClick={() => void runCompare(binary.nextOffset ?? 0)}>{t('tools.nextRange')}</Button>
        <Table aria-label={t('tools.hexMode')}><TableHeader><TableRow><TableHeaderCell>{t('tools.offset')}</TableHeaderCell><TableHeaderCell>{t('a10.leftLabel')}</TableHeaderCell><TableHeaderCell>{t('a10.rightLabel')}</TableHeaderCell></TableRow></TableHeader><TableBody>{binary.rows.map((row) => <TableRow key={row.offset}><TableCell>{row.offset}</TableCell><TableCell>{row.leftHex}</TableCell><TableCell>{row.rightHex}</TableCell></TableRow>)}</TableBody></Table>
        <Text block>{t('a10.provenance', { leftHash: binary.provenance.leftHash, rightHash: binary.provenance.rightHash })}</Text>
      </div>}
    </section>;
}
