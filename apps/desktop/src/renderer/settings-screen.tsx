/**
 * A13 Settings / Certificates / Engines / AI。`docs/detailed-design/02` §3。
 * 外部 engine の能力・版・fixture hash の詳細開示 (design/22 の「版ごとの実測・開示」)、
 * 証明書と AI 支援は現状 (未接続) を偽りなく表示する。設定変更の扱う項目は
 * 実 adapter 接続 (design/21 の版管理) と一緒に後続増分で足す。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Field, Input, MessageBar, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, tokens } from '@fluentui/react-components';
import type { EngineCapabilitySnapshot } from '@scopepilot2/contracts';
import { t } from './resources.ts';

const CONTROL_ASPECTS = ['preSendScopeEnforcement', 'stopControl', 'budgetLease', 'rateLimit'] as const;

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '4px' },
  muted: { color: tokens.colorNeutralForeground3 },
});

async function callJson<T>(apiBase: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export function SettingsScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [capabilities, setCapabilities] = useState<readonly EngineCapabilitySnapshot[]>([]);
  const [extensions, setExtensions] = useState<readonly { extensionId: string; version: string; permissions: readonly string[]; apiRange: readonly string[] }[]>([]);
  const [extensionId, setExtensionId] = useState('fixture-helper');
  const [extensionVersion, setExtensionVersion] = useState('1.0.0');
  const [extensionSignature, setExtensionSignature] = useState('');
  const [extensionNotice, setExtensionNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadExtensions = useCallback(async () => {
    try {
      const body = await callJson<{ extensions: readonly { extensionId: string; version: string; permissions: readonly string[]; apiRange: readonly string[] }[] }>(apiBase, '/api/extensions');
      setExtensions(body.extensions);
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase]);

  useEffect(() => {
    void (async () => {
      try {
        const body = await callJson<{ capabilities: readonly EngineCapabilitySnapshot[] }>(apiBase, '/api/capabilities');
        setCapabilities(body.capabilities);
      } catch (cause) {
        setError(String(cause));
      }
    })();
    void loadExtensions();
  }, [apiBase, loadExtensions]);

  const installExtension = useCallback(async () => {
    setBusy(true);
    setError('');
    setExtensionNotice('');
    try {
      await callJson(apiBase, '/api/extensions', {
        extensionId,
        version: extensionVersion,
        signature: extensionSignature,
        publisherTrusted: true,
        permissions: ['observations.read'],
        apiRange: ['scopepilot2.api.v1'],
      });
      setExtensionNotice(t('a13.extensionInstalled', { id: extensionId, version: extensionVersion }));
      await loadExtensions();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, extensionId, extensionSignature, extensionVersion, loadExtensions]);

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
      <Text weight="semibold">{t('a13.extensions.title')}</Text>
      <Text className={styles.muted}>{t('a13.extensions.intro')}</Text>
      <Field label={t('a13.extensions.idLabel')}>
        <Input value={extensionId} onChange={(_, data) => setExtensionId(data.value)} />
      </Field>
      <Field label={t('a13.extensions.versionLabel')}>
        <Input value={extensionVersion} onChange={(_, data) => setExtensionVersion(data.value)} />
      </Field>
      <Field label={t('a13.extensions.signatureLabel')}>
        <Input value={extensionSignature} onChange={(_, data) => setExtensionSignature(data.value)} />
      </Field>
      <Button disabled={busy} onClick={() => void installExtension()}>
        {t('a13.extensions.install')}
      </Button>
      {extensionNotice !== '' && <Text role="status">{extensionNotice}</Text>}
      {extensions.length > 0 && (
        <Table size="small" aria-label={t('a13.extensions.table.aria')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>extensionId</TableHeaderCell>
              <TableHeaderCell>{t('common.col.version')}</TableHeaderCell>
              <TableHeaderCell>{t('a13.extensions.col.permissions')}</TableHeaderCell>
              <TableHeaderCell>{t('a13.extensions.col.apiRange')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {extensions.map((extension) => (
              <TableRow key={`${extension.extensionId}-${extension.version}`}>
                <TableCell>{extension.extensionId}</TableCell>
                <TableCell>{extension.version}</TableCell>
                <TableCell>{extension.permissions.join(', ') || '—'}</TableCell>
                <TableCell>{extension.apiRange.join(', ') || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Text weight="semibold">{t('a13.certificates.title')}</Text>
      <Text className={styles.muted}>{t('a13.certificates.note')}</Text>
      <Text weight="semibold">{t('a13.ai.title')}</Text>
      <Text className={styles.muted}>{t('a13.ai.note')}</Text>
    </div>
  );
}
