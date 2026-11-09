import type { PassiveRule, PassiveStatus } from '@scopepilot2/contracts';
import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Field, Input, Link, MessageBar, Select, Text } from '@fluentui/react-components';
import { FindingSeverities, type Finding } from '../../../../packages/contracts/src/findings/findings.ts';

async function read<T>(apiBase: string, path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as T;
}

export function PassiveScreen({ apiBase, onFindings }: { apiBase: string; onFindings: () => void }): React.ReactElement {
  const [rules, setRules] = useState<readonly PassiveRule[]>([]);
  const [status, setStatus] = useState<PassiveStatus>();
  const [alerts, setAlerts] = useState<readonly Finding[]>([]);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('all');
  const [selectedId, setSelectedId] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      const [ruleResult, statusResult, alertResult] = await Promise.all([
        read<{ rules: readonly PassiveRule[] }>(apiBase, '/api/passive/rules'),
        read<PassiveStatus>(apiBase, '/api/passive/status'),
        read<{ alerts: readonly Finding[] }>(apiBase, '/api/passive/alerts'),
      ]);
      setRules(ruleResult.rules); setStatus(statusResult); setAlerts(alertResult.alerts); setError('');
    } catch (cause) { setError(String(cause)); }
  }, [apiBase]);
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh(); }, 5000); return () => clearInterval(timer); }, [refresh]);
  const visible = alerts.filter((alert) => (severity === 'all' || alert.severity === severity)
    && `${alert.title} ${alert.url}`.toLowerCase().includes(search.toLowerCase()));
  const selected = visible.find((alert) => alert.findingId === selectedId);
  return <>
    <Text as="h2" size={600}>受動診断 / Alerts</Text>
    <Text>探索で観測した情報を追加送信なしで検査します。Alerts は受動検査から候補として登録された所見です。実影響を自動確定しません。Findings と同じ所見を表示し、確定・棄却と報告は Findings で管理します。</Text>
    <Button onClick={onFindings}>Findings で管理する</Button>
    <Button onClick={() => { void refresh(); }}>再読込</Button>
    {error && <MessageBar intent="error">{error}</MessageBar>}
    {status && <section aria-label="受動処理状況">
      <Text>処理待ち {status.queued} / 処理済み {status.processed} / 失敗 {status.failed} / Alerts {status.alerts}</Text>
      {status.limitations.map((limitation) => <p key={limitation}>{limitation}</p>)}
    </section>}
    <section aria-label="受動ルール"><Text as="h3">受動ルール（参照のみ）</Text>
      {rules.map((rule) => <p key={rule.ruleId}><Badge>{rule.enabled ? '有効' : '無効'}</Badge> {rule.name} ({rule.ruleId} v{rule.version}) — {rule.description}</p>)}
    </section>
    <Field label="Alerts の検索"><Input value={search} onChange={(_, data) => setSearch(data.value)} /></Field>
    <Field label="重大度"><Select value={severity} onChange={(_, data) => setSeverity(data.value)}><option value="all">すべて</option>{FindingSeverities.map((value) => <option key={value}>{value}</option>)}</Select></Field>
    <Text>Alerts: {visible.length} 件</Text>
    {visible.length === 0 && <Text>受動候補はありません。探索未実施や検査対象外も含むため、安全性を保証する結果ではありません。</Text>}
    <ul>{visible.map((alert) => <li key={alert.findingId}><Badge>{alert.severity}</Badge> <Button onClick={() => setSelectedId(alert.findingId)}>{alert.title} — {alert.url}</Button> {alert.status}</li>)}</ul>
    {selected && <section aria-label="Alert 詳細">
      <Text as="h3">{selected.title}</Text><p>{selected.passive?.detail}</p>
      <p>重大度: {selected.severity} / 状態: {selected.status} / 観測回数: {selected.occurrences}</p>
      <p>所見 ID: {selected.findingId} / ルール: {selected.passive?.ruleId} v{selected.passive?.ruleVersion}</p>
      <p>初回: {selected.firstSeenAt} / 最終: {selected.lastSeenAt}</p>
      <p>証跡参照: {selected.evidenceRefs.join(', ')}</p>
      <Link href={`${apiBase}/api/passive/evidence?findingId=${encodeURIComponent(selected.findingId)}`} target="_blank" rel="noreferrer">証拠・再現リクエストのメタデータを開く</Link>
      <p>再現の入口（自動送信なし）: {selected.method ?? 'GET'} {selected.url}</p>
      <Button onClick={onFindings}>この候補を Findings で確認する</Button>
    </section>}
  </>;
}
