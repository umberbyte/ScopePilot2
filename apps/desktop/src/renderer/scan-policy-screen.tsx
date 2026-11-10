/** A43 診断ポリシー。ZAP 個別 rule ID は意図的に UI/契約へ出さない。 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Field, Input, MessageBar, Select, Text, Textarea, makeStyles, tokens } from '@fluentui/react-components';
import { GenericHttpCheckIds, ScanAlertThresholds, ScanAttackStrengths, type GenericHttpCheckId, type SaveScanPolicyRequest, type ScanPolicy } from '@scopepilot2/contracts/scan-policy';
import { t } from './resources.ts';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '14px' },
  section: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  row: { display: 'flex', flexWrap: 'wrap', gap: '12px' },
  muted: { color: tokens.colorNeutralForeground3 },
});

async function callJson<T>(apiBase: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string; code?: string } | null;
    throw new Error(`${error?.code === undefined ? '' : `${error.code}: `}${error?.message ?? `HTTP ${String(response.status)}`}`);
  }
  return response.json() as Promise<T>;
}
type PolicyDraft = Omit<SaveScanPolicyRequest, 'policyId'> & { readonly policyId?: string };

function draftOf(policy: ScanPolicy): PolicyDraft {
  return { expectedRevision: policy.revision, policyId: policy.policyId, name: policy.name, isDefault: policy.isDefault, routes: policy.routes };
}

function newDraft(): PolicyDraft {
  return {
    expectedRevision: 0,
    name: '',
    isDefault: false,
    routes: {
      zap: { enabled: true, attackStrength: 'Medium', alertThreshold: 'Medium' },
      genericHttp: { enabled: true, checkIds: [...GenericHttpCheckIds] },
      nuclei: { enabled: false, templateIds: [] },
    },
  };
}

export function ScanPolicyScreen({ apiBase }: { readonly apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [policies, setPolicies] = useState<readonly ScanPolicy[]>([]);
  const [draft, setDraft] = useState<PolicyDraft>(newDraft());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await callJson<{ policies: readonly ScanPolicy[] }>(apiBase, 'GET', '/api/scan-policies');
      setPolicies(result.policies);
      const selected = result.policies.find((policy) => policy.policyId === draft.policyId) ?? result.policies.find((policy) => policy.isDefault) ?? result.policies[0];
      if (selected !== undefined) setDraft(draftOf(selected));
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [apiBase, draft.policyId]);

  useEffect(() => { void load(); }, [apiBase]);

  const save = async (): Promise<void> => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await callJson<{ policy: ScanPolicy; changed: boolean; invalidatedConfirmationIds: readonly string[] }>(apiBase, 'POST', '/api/scan-policies', draft);
      setDraft(draftOf(result.policy));
      setNotice(t('a43.saved', { revision: result.policy.revision, invalidated: result.invalidatedConfirmationIds.length }));
      const refreshed = await callJson<{ policies: readonly ScanPolicy[] }>(apiBase, 'GET', '/api/scan-policies');
      setPolicies(refreshed.policies);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const toggleCheck = (checkId: GenericHttpCheckId, checked: boolean): void => {
    const selected = new Set(draft.routes.genericHttp.checkIds);
    checked ? selected.add(checkId) : selected.delete(checkId);
    setDraft({ ...draft, routes: { ...draft.routes, genericHttp: { ...draft.routes.genericHttp, checkIds: GenericHttpCheckIds.filter((id) => selected.has(id)) } } });
  };

  return (
    <div className={styles.root}>
      <Text>{t('a43.purpose')}</Text>
      <MessageBar intent="info">{t('a43.noRuleIds')}</MessageBar>
      {error !== '' && <MessageBar intent="error">{error}</MessageBar>}
      {notice !== '' && <MessageBar intent="success">{notice}</MessageBar>}
      <section className={styles.section}>
        <div className={styles.row}>
          <Field label={t('a43.policy')}><Select value={draft.policyId ?? ''} onChange={(_, data) => { const selected = policies.find((policy) => policy.policyId === data.value); if (selected !== undefined) setDraft(draftOf(selected)); }}>{policies.map((policy) => <option key={policy.policyId} value={policy.policyId}>{policy.name} (rev {policy.revision})</option>)}</Select></Field>
          <Button onClick={() => { setDraft(newDraft()); setNotice(''); }}>{t('a43.new')}</Button>
        </div>
        <Field label={t('a43.name')} required><Input value={draft.name} onChange={(_, data) => setDraft({ ...draft, name: data.value })} /></Field>
        <Checkbox label={t('a43.default')} checked={draft.isDefault} onChange={(_, data) => setDraft({ ...draft, isDefault: data.checked === true })} />
      </section>
      <section className={styles.section}>
        <Text weight="semibold">{t('a43.zap')}</Text>
        <Checkbox label={t('a43.enabled')} checked={draft.routes.zap.enabled} onChange={(_, data) => setDraft({ ...draft, routes: { ...draft.routes, zap: { ...draft.routes.zap, enabled: data.checked === true } } })} />
        <div className={styles.row}>
          <Field label={t('a43.strength')}><Select value={draft.routes.zap.attackStrength} onChange={(_, data) => setDraft({ ...draft, routes: { ...draft.routes, zap: { ...draft.routes.zap, attackStrength: data.value as typeof draft.routes.zap.attackStrength } } })}>{ScanAttackStrengths.map((value) => <option key={value}>{value}</option>)}</Select></Field>
          <Field label={t('a43.threshold')}><Select value={draft.routes.zap.alertThreshold} onChange={(_, data) => setDraft({ ...draft, routes: { ...draft.routes, zap: { ...draft.routes.zap, alertThreshold: data.value as typeof draft.routes.zap.alertThreshold } } })}>{ScanAlertThresholds.map((value) => <option key={value}>{value}</option>)}</Select></Field>
        </div>
      </section>
      <section className={styles.section}>
        <Text weight="semibold">{t('a43.generic')}</Text>
        <Checkbox label={t('a43.enabled')} checked={draft.routes.genericHttp.enabled} onChange={(_, data) => setDraft({ ...draft, routes: { ...draft.routes, genericHttp: { ...draft.routes.genericHttp, enabled: data.checked === true } } })} />
        <div className={styles.row}>{GenericHttpCheckIds.map((checkId) => <Checkbox key={checkId} label={checkId} checked={draft.routes.genericHttp.checkIds.includes(checkId)} onChange={(_, data) => toggleCheck(checkId, data.checked === true)} />)}</div>
      </section>
      <section className={styles.section}>
        <Text weight="semibold">{t('a43.nuclei')}</Text>
        <Checkbox label={t('a43.enabled')} checked={draft.routes.nuclei.enabled} onChange={(_, data) => setDraft({ ...draft, routes: { ...draft.routes, nuclei: { ...draft.routes.nuclei, enabled: data.checked === true } } })} />
        <Field label={t('a43.templates')} hint={t('a43.templatesHint')}><Textarea value={draft.routes.nuclei.templateIds.join('\n')} rows={4} onChange={(_, data) => setDraft({ ...draft, routes: { ...draft.routes, nuclei: { ...draft.routes.nuclei, templateIds: data.value.split('\n').map((value) => value.trim()).filter(Boolean) } } })} /></Field>
      </section>
      {draft.policyId !== undefined && <Text className={styles.muted}>{t('a43.hash', { hash: policies.find((policy) => policy.policyId === draft.policyId)?.policyHash.slice(0, 16) ?? '—' })}</Text>}
      <Button appearance="primary" disabled={busy || draft.name.trim() === ''} onClick={() => void save()}>{t('a43.save')}</Button>
    </div>
  );
}
