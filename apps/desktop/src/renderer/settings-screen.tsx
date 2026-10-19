/**
 * A13 Settings / Certificates / Engines / AI。`docs/detailed-design/02` §3。
 * 外部 engine の能力・版・fixture hash の詳細開示 (design/22 の「版ごとの実測・開示」)、
 * 証明書と AI 支援は現状 (未接続) を偽りなく表示する。設定変更の扱う項目は
 * 実 adapter 接続 (design/21 の版管理) と一緒に後続増分で足す。
 */
import React, { useEffect, useState } from 'react';
import { MessageBar, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, tokens } from '@fluentui/react-components';
import type { EngineCapabilitySnapshot } from '@scopepilot2/contracts';

const CONTROL_ASPECTS = ['preSendScopeEnforcement', 'stopControl', 'budgetLease', 'rateLimit'] as const;

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '4px' },
  muted: { color: tokens.colorNeutralForeground3 },
});

async function callJson<T>(apiBase: string, path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export function SettingsScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [capabilities, setCapabilities] = useState<readonly EngineCapabilitySnapshot[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const body = await callJson<{ capabilities: readonly EngineCapabilitySnapshot[] }>(apiBase, '/api/capabilities');
        setCapabilities(body.capabilities);
      } catch (cause) {
        setError(String(cause));
      }
    })();
  }, [apiBase]);

  return (
    <div className={styles.section}>
      <Text weight="semibold">外部 engine (能力・版・開示)</Text>
      {error !== '' && (
        <MessageBar intent="error">
          {`Error: ${error}`}
        </MessageBar>
      )}
      <Text className={styles.muted}>
        保証等級 — Enforced: ScopePilot が送信前に保証 / Delegated: 外部 engine への委譲 (入力制限・事後検知・停止で担保、送信前拒否は保証しない) / Unsupported: 当該機能を公開しない
      </Text>
      <Table size="small" aria-label="engine 能力詳細">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>engine</TableHeaderCell>
            <TableHeaderCell>版</TableHeaderCell>
            <TableHeaderCell>由来</TableHeaderCell>
            {CONTROL_ASPECTS.map((aspect) => (
              <TableHeaderCell key={aspect}>{aspect}</TableHeaderCell>
            ))}
            <TableHeaderCell>overshoot 上限比</TableHeaderCell>
            <TableHeaderCell>測定時刻</TableHeaderCell>
            <TableHeaderCell>fixture hash</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {capabilities.map((capability) => (
            <TableRow key={`${capability.engineKind}-${capability.engineVersion}`}>
              <TableCell>{capability.engineKind}</TableCell>
              <TableCell>{capability.engineVersion}</TableCell>
              <TableCell>{capability.source === 'fixture' ? 'fixture (実測ではない)' : 'measured'}</TableCell>
              {CONTROL_ASPECTS.map((aspect) => (
                <TableCell key={aspect}>{capability.guaranteeLevels[aspect]}</TableCell>
              ))}
              <TableCell>{`${capability.maxOvershootRatio * 100}%`}</TableCell>
              <TableCell>{capability.measuredAt}</TableCell>
              <TableCell>{capability.fixtureHash === undefined ? '—' : `${capability.fixtureHash.slice(0, 12)}…`}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Text weight="semibold">証明書</Text>
      <Text className={styles.muted}>診断用 CA 証明書の発行と信頼設定は実 engine 接続 (HTTPS 解析) と共に後続増分で提供します (design/24)。</Text>
      <Text weight="semibold">AI 支援</Text>
      <Text className={styles.muted}>
        AI provider は未設定です。提案 (CaseSetup・RequestDraft・FindingDraft 等) は drawer 経由で出典・model・生成時刻・差分付きで提示し、明示採用まで状態を変更しません (design/02 §5)。
      </Text>
    </div>
  );
}
