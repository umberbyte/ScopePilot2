/**
 * A07 Fuzzer。`docs/detailed-design/f05-intruder-fuzzer.md`。
 * payload 集合の登録 (供給元・版・license 必須) と position 組合せの実行
 * (組合せ上限は送信前に検証、応答は cluster 集約) を扱う。
 * 実行は fixture adapter (決定的応答・仮想時計で rate を進める)。実 adapter は後続増分。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { MessageBar, Button, Field, Input, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea, tokens } from '@fluentui/react-components';
import { t } from './resources.ts';

interface PayloadSetView {
  readonly name: string;
  readonly source: string;
  readonly version: string;
  readonly license: string;
  readonly sha256: string;
  readonly values: readonly string[];
}

interface FuzzRunResult {
  readonly runId: string;
  readonly targetUrl: string;
  readonly total: number;
  readonly sent: number;
  readonly clusters: readonly { key: string; members: readonly number[]; representative: readonly string[] }[];
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
});

export function FuzzerScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [sets, setSets] = useState<readonly PayloadSetView[]>([]);
  const [payloadName, setSetName] = useState('');
  const [payloadSource, setSetSource] = useState('');
  const [payloadVersion, setSetVersion] = useState('');
  const [license, setLicense] = useState('');
  const [payloadValues, setSetValues] = useState('');
  const [targetUrl, setTargetUrl] = useState('http://fixture.target.test/fuzz');
  const [positionsText, setPositionsText] = useState('user: admin, guest\nid: 1, 2');
  const [result, setResult] = useState<FuzzRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadSets = useCallback(async () => {
    try {
      const body = await callJson<{ sets: readonly PayloadSetView[] }>(apiBase, 'GET', '/api/fuzzer/payload-sets');
      setSets(body.sets);
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase]);

  useEffect(() => {
    void loadSets();
  }, [loadSets]);

  const registerSet = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await callJson(apiBase, 'POST', '/api/fuzzer/payload-sets', {
        name: payloadName,
        source: payloadSource,
        version: payloadVersion,
        license,
        sha256: 'manual-entry',
        values: payloadValues.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
      });
      await loadSets();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, license, loadSets, payloadName, payloadSource, payloadValues, payloadVersion]);

  const runFuzz = useCallback(async () => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const positions = positionsText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line): { name: string; values: readonly string[] } => {
          const separator = line.indexOf(':');
          const name = separator === -1 ? line : line.slice(0, separator).trim();
          const valuesText = separator === -1 ? '' : line.slice(separator + 1);
          return { name, values: valuesText.split(',').map((value) => value.trim()).filter((value) => value !== '') };
        });
      setResult(await callJson<FuzzRunResult>(apiBase, 'POST', '/api/fuzzer/runs', { targetUrl, positions }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, positionsText, targetUrl]);

  return (
    <div className={styles.section}>
      {error !== '' && (
        <MessageBar intent="error">
          {`Error: ${error}`}
        </MessageBar>
      )}
      <Text className={styles.muted}>{t('a07.intro')}</Text>
      <Text weight="semibold">{t('a07.payloadTitle')}</Text>
      <Field label={t('a07.field.name')}>
        <Input value={payloadName} onChange={(_, data) => setSetName(data.value)} />
      </Field>
      <Field label={t('a07.field.source')}>
        <Input value={payloadSource} onChange={(_, data) => setSetSource(data.value)} />
      </Field>
      <Field label={t('a07.field.version')}>
        <Input value={payloadVersion} onChange={(_, data) => setSetVersion(data.value)} />
      </Field>
      <Field label={t('a07.field.license')}>
        <Input value={license} onChange={(_, data) => setLicense(data.value)} />
      </Field>
      <Field label={t('a07.field.values')}>
        <Textarea value={payloadValues} onChange={(_, data) => setSetValues(data.value)} rows={3} />
      </Field>
      <Button appearance="primary" disabled={busy || payloadName.trim() === '' || payloadSource.trim() === '' || payloadVersion.trim() === '' || license.trim() === '' || payloadValues.trim() === ''} onClick={() => void registerSet()}>
        {t('a07.register')}
      </Button>
      {sets.length > 0 && (
        <Text className={styles.muted}>{t('a07.registered', { sets: sets.map((set) => t('a07.setSummary', { name: set.name, source: set.source, version: set.version, license: set.license, count: set.values.length })).join(' / ') })}</Text>
      )}

      <Text weight="semibold">{t('a07.runTitle')}</Text>
      <Field label={t('common.targetUrlInScope')}>
        <Input value={targetUrl} onChange={(_, data) => setTargetUrl(data.value)} />
      </Field>
      <Field label={t('a07.positionsLabel')}>
        <Textarea value={positionsText} onChange={(_, data) => setPositionsText(data.value)} rows={3} />
      </Field>
      <Button appearance="primary" disabled={busy || positionsText.trim() === ''} onClick={() => void runFuzz()}>
        {t('a07.run')}
      </Button>
      {result !== null && (
        <div className={styles.section}>
          <Text role="status">{t('a07.result', { runId: result.runId, total: result.total, sent: result.sent, clusters: result.clusters.length })}</Text>
          <Table size="small" aria-label={t('a07.table.aria')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('a07.col.key')}</TableHeaderCell>
                <TableHeaderCell>{t('a07.col.count')}</TableHeaderCell>
                <TableHeaderCell>{t('a07.col.representative')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.clusters.map((cluster) => (
                <TableRow key={cluster.key}>
                  <TableCell>{cluster.key}</TableCell>
                  <TableCell>{String(cluster.members.length)}</TableCell>
                  <TableCell>{cluster.representative.join(' | ')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
