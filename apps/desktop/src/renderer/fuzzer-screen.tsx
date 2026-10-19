/**
 * A07 Fuzzer。`docs/detailed-design/f05-intruder-fuzzer.md`。
 * payload 集合の登録 (供給元・版・license 必須) と position 組合せの実行
 * (組合せ上限は送信前に検証、応答は cluster 集約) を扱う。
 * 実行は fixture adapter (決定的応答・仮想時計で rate を進める)。実 adapter は後続増分。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { MessageBar, Button, Field, Input, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea, tokens } from '@fluentui/react-components';

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
      <Text className={styles.muted}>
        組合せ総数が上限 (案件上限と 200 の小さい方) を超えると送信前に拒否されます。応答は (status・長さ・hash) ごとに cluster 集約し、全体の一覧は表示しません。rate は 2 req/s 既定 (仮想時計で進めます)。
      </Text>
      <Text weight="semibold">payload 集合 (供給元・版・license が必須)</Text>
      <Field label="名前">
        <Input value={payloadName} onChange={(_, data) => setSetName(data.value)} />
      </Field>
      <Field label="供給元 (source)">
        <Input value={payloadSource} onChange={(_, data) => setSetSource(data.value)} />
      </Field>
      <Field label="版">
        <Input value={payloadVersion} onChange={(_, data) => setSetVersion(data.value)} />
      </Field>
      <Field label="license">
        <Input value={setLicense} onChange={(_, data) => setLicense(data.value)} />
      </Field>
      <Field label="値 (1行1件)">
        <Textarea value={payloadValues} onChange={(_, data) => setSetValues(data.value)} rows={3} />
      </Field>
      <Button appearance="primary" disabled={busy || payloadName.trim() === '' || payloadSource.trim() === '' || payloadVersion.trim() === '' || license.trim() === '' || payloadValues.trim() === ''} onClick={() => void registerSet()}>
        payload 集合を登録する
      </Button>
      {sets.length > 0 && (
        <Text className={styles.muted}>{`登録済み: ${sets.map((set) => `${set.name} (${set.source} ${set.version}・${set.license}・${set.values.length} 件)`).join(' / ')}`}</Text>
      )}

      <Text weight="semibold">fuzz 実行</Text>
      <Field label="対象 URL (scope 内)">
        <Input value={targetUrl} onChange={(_, data) => setTargetUrl(data.value)} />
      </Field>
      <Field label="positions (1行1件・name: 値, 値, …)">
        <Textarea value={positionsText} onChange={(_, data) => setPositionsText(data.value)} rows={3} />
      </Field>
      <Button appearance="primary" disabled={busy || positionsText.trim() === ''} onClick={() => void runFuzz()}>
        fuzz を実行する
      </Button>
      {result !== null && (
        <div className={styles.section}>
          <Text role="status">{`${result.runId}: 組合せ ${result.total} 件中 ${result.sent} 件送信 → ${result.clusters.length} cluster`}</Text>
          <Table size="small" aria-label="応答 cluster">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>cluster (status|bytes|hash)</TableHeaderCell>
                <TableHeaderCell>応答数</TableHeaderCell>
                <TableHeaderCell>代表組合せ</TableHeaderCell>
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
