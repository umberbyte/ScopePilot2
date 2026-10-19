/**
 * A13 Settings / Certificates / Engines / AI。`docs/detailed-design/02` §3。
 * 外部 engine の能力・版・fixture hash の詳細開示 (design/22 の「版ごとの実測・開示」)、
 * 証明書と AI 支援は現状 (未接続) を偽りなく表示する。設定変更の扱う項目は
 * 実 adapter 接続 (design/21 の版管理) と一緒に後続増分で足す。
 */
import React, { useEffect, useState } from 'react';
import { MessageBar, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, tokens } from '@fluentui/react-components';
import type { EngineCapabilitySnapshot } from '@scopepilot2/contracts';
import { t } from './resources.ts';

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
      <Text weight="semibold">{t('a13.title')}</Text>
      {error !== '' && (
        <MessageBar intent="error">
          {`Error: ${error}`}
        </MessageBar>
      )}
      <Text className={styles.muted}>{t('a13.guaranteeLegend')}</Text>
      <Table size="small" aria-label={t('a13.table.aria')}>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>engine</TableHeaderCell>
            <TableHeaderCell>{t('a13.col.version')}</TableHeaderCell>
            <TableHeaderCell>{t('a13.col.source')}</TableHeaderCell>
            {CONTROL_ASPECTS.map((aspect) => (
              <TableHeaderCell key={aspect}>{aspect}</TableHeaderCell>
            ))}
            <TableHeaderCell>{t('a13.col.overshoot')}</TableHeaderCell>
            <TableHeaderCell>{t('a13.col.measuredAt')}</TableHeaderCell>
            <TableHeaderCell>{t('a13.col.fixtureHash')}</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {capabilities.map((capability) => (
            <TableRow key={`${capability.engineKind}-${capability.engineVersion}`}>
              <TableCell>{capability.engineKind}</TableCell>
              <TableCell>{capability.engineVersion}</TableCell>
              <TableCell>{capability.source === 'fixture' ? t('a13.sourceFixture') : 'measured'}</TableCell>
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
      <Text weight="semibold">{t('a13.certificates.title')}</Text>
      <Text className={styles.muted}>{t('a13.certificates.note')}</Text>
      <Text weight="semibold">{t('a13.ai.title')}</Text>
      <Text className={styles.muted}>{t('a13.ai.note')}</Text>
    </div>
  );
}
