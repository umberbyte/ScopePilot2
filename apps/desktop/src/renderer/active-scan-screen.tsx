/** A40 能動診断。候補→ポリシー/経路→計画→確認→非同期実行を 1 画面にまとめる。 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  Field,
  Input,
  MessageBar,
  ProgressBar,
  Select,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { EngineCapabilitySnapshot, ExecutionPlan, PlanConfirmation, ScanCandidate, ScanPolicy } from '@scopepilot2/contracts';
import { t } from './resources.ts';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px' },
  section: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: '12px' },
  muted: { color: tokens.colorNeutralForeground3 },
  logs: { maxHeight: '260px', overflowY: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'monospace', backgroundColor: tokens.colorNeutralBackground3, padding: '12px' },
});

async function callJson<T>(apiBase: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string; code?: string } | null;
    throw new Error(`${error?.code === undefined ? '' : `${error.code}: `}${error?.message ?? `HTTP ${String(response.status)}`}`);
  }
  return response.json() as Promise<T>;
}
interface ScanExecutionSnapshot {
  readonly executionId: string;
  readonly state: 'queued' | 'running' | 'stopping' | 'completed' | 'stopped' | 'failed';
  readonly currentEngine: string;
  readonly progress: number;
  readonly logs: readonly string[];
  readonly error?: string;
  readonly result?: { readonly findings: readonly unknown[] };
}

export function ActiveScanScreen({ apiBase }: { readonly apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [candidates, setCandidates] = useState<readonly ScanCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [policies, setPolicies] = useState<readonly ScanPolicy[]>([]);
  const [policyId, setPolicyId] = useState('');
  const [routes, setRoutes] = useState({ zap: true, genericHttp: true, nuclei: false });
  const [capabilities, setCapabilities] = useState<readonly EngineCapabilitySnapshot[]>([]);
  const [role, setRole] = useState('');
  const [guidelines, setGuidelines] = useState('');
  const [limits, setLimits] = useState({ maxRequests: '5000', maxPages: '500', maxDurationMinutes: '30' });
  const [plan, setPlan] = useState<{ readonly plan: ExecutionPlan; readonly planHash: string } | null>(null);
  const [confirmation, setConfirmation] = useState<PlanConfirmation | null>(null);
  const [executionId, setExecutionId] = useState('');
  const [execution, setExecution] = useState<ScanExecutionSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selectedPolicy = policies.find((policy) => policy.policyId === policyId);
  const zapAvailable = capabilities.some((capability) => capability.engineKind === 'zap' && capability.guaranteeLevels.preSendScopeEnforcement !== 'Unsupported');
  const nucleiAvailable = capabilities.some((capability) => capability.engineKind === 'nuclei' && capability.guaranteeLevels.preSendScopeEnforcement !== 'Unsupported');

  const invalidatePlan = useCallback(() => {
    setPlan(null);
    setConfirmation(null);
    setExecutionId('');
    setExecution(null);
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const [candidateBody, policyBody, capabilityBody] = await Promise.all([
        callJson<{ candidates: readonly ScanCandidate[] }>(apiBase, 'GET', '/api/candidates'),
        callJson<{ policies: readonly ScanPolicy[] }>(apiBase, 'GET', '/api/scan-policies'),
        callJson<{ capabilities: readonly EngineCapabilitySnapshot[] }>(apiBase, 'GET', '/api/capabilities'),
      ]);
      setCandidates(candidateBody.candidates);
      setCapabilities(capabilityBody.capabilities);
      setPolicies(policyBody.policies);
      const selected = policyBody.policies.find((policy) => policy.isDefault) ?? policyBody.policies[0];
      if (selected !== undefined) {
        setPolicyId(selected.policyId);
        setRoutes({
          zap: selected.routes.zap.enabled,
          genericHttp: selected.routes.genericHttp.enabled,
          nuclei: selected.routes.nuclei.enabled && capabilityBody.capabilities.some((capability) => capability.engineKind === 'nuclei'),
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [apiBase]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (executionId === '') return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const snapshot = await callJson<ScanExecutionSnapshot>(apiBase, 'GET', `/api/run/scan/status?executionId=${encodeURIComponent(executionId)}`);
        if (cancelled) return;
        setExecution(snapshot);
        if (!['completed', 'stopped', 'failed'].includes(snapshot.state)) timer = setTimeout(() => void poll(), 750);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void poll();
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
  }, [apiBase, executionId]);

  const selectedCandidates = useMemo(() => candidates.filter((candidate) => selectedIds.has(candidate.candidateId)), [candidates, selectedIds]);

  const choosePolicy = (nextId: string): void => {
    const policy = policies.find((candidate) => candidate.policyId === nextId);
    setPolicyId(nextId);
    if (policy !== undefined) setRoutes({ zap: policy.routes.zap.enabled, genericHttp: policy.routes.genericHttp.enabled, nuclei: policy.routes.nuclei.enabled && nucleiAvailable });
    invalidatePlan();
  };

  const buildPlan = async (): Promise<void> => {
    if (selectedPolicy === undefined || selectedCandidates.length === 0) return;
    setBusy(true); setError(''); invalidatePlan();
    try {
      const result = await callJson<{ plan: ExecutionPlan; planHash: string }>(apiBase, 'POST', '/api/plan/scan', {
        targets: selectedCandidates.map((candidate) => candidate.url),
        scanPolicyId: selectedPolicy.policyId,
        scanPolicyHash: selectedPolicy.policyHash,
        routeOverrides: routes,
        targetRole: role.trim() || 'unauthenticated',
        guidelines: guidelines.split('\n').map((entry) => entry.trim()).filter(Boolean),
        limits: {
          maxRequests: Number(limits.maxRequests),
          maxPages: Number(limits.maxPages),
          maxDurationMinutes: Number(limits.maxDurationMinutes),
        },
      });
      setPlan(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const confirm = async (): Promise<void> => {
    if (plan === null) return;
    setBusy(true); setError('');
    try { setConfirmation(await callJson<PlanConfirmation>(apiBase, 'POST', '/api/plan/confirm', { plan: plan.plan })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const execute = async (): Promise<void> => {
    if (plan === null || confirmation === null) return;
    setBusy(true); setError('');
    try {
      const accepted = await callJson<{ executionId: string }>(apiBase, 'POST', '/api/run/scan/start', {
        plan: plan.plan,
        confirmation,
        adopted: selectedCandidates,
        ...(role.trim() === '' || role.trim() === 'unauthenticated' ? {} : { role: role.trim() }),
      });
      setExecutionId(accepted.executionId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const stop = async (): Promise<void> => {
    if (executionId === '') return;
    await callJson(apiBase, 'POST', '/api/run/scan/stop', { executionId }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <div className={styles.root}>
      <Text>{t('a40.purpose')}</Text>
      {error !== '' && <MessageBar intent="error">{error}</MessageBar>}
      <section className={styles.section}>
        <Text weight="semibold">{t('a40.targets')}</Text>
        {candidates.length === 0 ? <Text className={styles.muted}>{t('a40.noCandidates')}</Text> : (
          <Table size="small" aria-label={t('a40.targets')}>
            <TableHeader><TableRow><TableHeaderCell /><TableHeaderCell>method / URL</TableHeaderCell><TableHeaderCell>{t('a40.reason')}</TableHeaderCell><TableHeaderCell>{t('a40.priority')}</TableHeaderCell></TableRow></TableHeader>
            <TableBody>{candidates.map((candidate) => (
              <TableRow key={candidate.candidateId}>
                <TableCell><Checkbox checked={selectedIds.has(candidate.candidateId)} onChange={(_, data) => { const next = new Set(selectedIds); data.checked === true ? next.add(candidate.candidateId) : next.delete(candidate.candidateId); setSelectedIds(next); invalidatePlan(); }} /></TableCell>
                <TableCell>{candidate.method} {candidate.url}</TableCell>
                <TableCell>{candidate.detectionReason ?? candidate.guidelineBasis.join(', ')}</TableCell>
                <TableCell>{Math.round(candidate.confidence * 100)}%</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        )}
      </section>
      <section className={styles.section}>
        <Text weight="semibold">{t('a40.configuration')}</Text>
        <Field label={t('a40.policy')}><Select value={policyId} onChange={(_, data) => choosePolicy(data.value)}>{policies.map((policy) => <option key={policy.policyId} value={policy.policyId}>{policy.name} (rev {policy.revision})</option>)}</Select></Field>
        {selectedPolicy !== undefined && <Text className={styles.muted}>{t('a40.policyHash', { hash: selectedPolicy.policyHash.slice(0, 16) })}</Text>}
        <div className={styles.row}>
          <Checkbox label={t('a40.routeZap')} checked={routes.zap} disabled={!selectedPolicy?.routes.zap.enabled || !zapAvailable} onChange={(_, data) => { setRoutes((current) => ({ ...current, zap: data.checked === true })); invalidatePlan(); }} />
          <Checkbox label={t('a40.routeGeneric')} checked={routes.genericHttp} disabled={!selectedPolicy?.routes.genericHttp.enabled} onChange={(_, data) => { setRoutes((current) => ({ ...current, genericHttp: data.checked === true })); invalidatePlan(); }} />
          <Checkbox label={t('a40.routeNuclei')} checked={routes.nuclei} disabled={!selectedPolicy?.routes.nuclei.enabled || !nucleiAvailable} onChange={(_, data) => { setRoutes((current) => ({ ...current, nuclei: data.checked === true })); invalidatePlan(); }} />
        </div>
        <Field label={t('a40.role')}><Input value={role} placeholder="unauthenticated" onChange={(_, data) => { setRole(data.value); invalidatePlan(); }} /></Field>
        <Field label={t('a40.guidelines')}><Input value={guidelines} onChange={(_, data) => { setGuidelines(data.value); invalidatePlan(); }} /></Field>
        <div className={styles.row}>
          <Field label={t('a40.maxRequests')}><Input type="number" value={limits.maxRequests} onChange={(_, data) => { setLimits((current) => ({ ...current, maxRequests: data.value })); invalidatePlan(); }} /></Field>
          <Field label={t('a40.maxPages')}><Input type="number" value={limits.maxPages} onChange={(_, data) => { setLimits((current) => ({ ...current, maxPages: data.value })); invalidatePlan(); }} /></Field>
          <Field label={t('a40.maxDuration')}><Input type="number" value={limits.maxDurationMinutes} onChange={(_, data) => { setLimits((current) => ({ ...current, maxDurationMinutes: data.value })); invalidatePlan(); }} /></Field>
        </div>
      </section>
      <section className={styles.section}>
        <div className={styles.row}>
          <Button appearance="primary" disabled={busy || selectedCandidates.length === 0 || (!routes.zap && !routes.genericHttp && !routes.nuclei)} onClick={() => void buildPlan()}>{t('a40.build')}</Button>
          <Button disabled={busy || plan === null} onClick={() => void confirm()}>{t('a40.confirm')}</Button>
          <Button disabled={busy || confirmation === null || executionId !== ''} onClick={() => void execute()}>{t('a40.run')}</Button>
          <Button disabled={executionId === '' || execution === null || !['queued', 'running'].includes(execution.state)} onClick={() => void stop()}>{t('a40.stop')}</Button>
          {busy && <Spinner size="tiny" />}
        </div>
        {plan !== null && <Text>{t('a40.planSummary', { hash: plan.planHash.slice(0, 16), routes: plan.plan.steps.map((step) => step.kind).join(', ') })}</Text>}
        {confirmation !== null && <MessageBar intent="success">{t('a40.confirmed', { id: confirmation.confirmationId })}</MessageBar>}
      </section>
      {execution !== null && (
        <section className={styles.section}>
          <Text weight="semibold">{t('a40.progress', { state: execution.state, engine: execution.currentEngine, progress: execution.progress })}</Text>
          <ProgressBar value={execution.progress / 100} />
          {execution.result !== undefined && <Text>{t('a40.completed', { findings: execution.result.findings.length })}</Text>}
          {execution.error !== undefined && <MessageBar intent="error">{execution.error}</MessageBar>}
          <div className={styles.logs}>{execution.logs.join('\n')}</div>
        </section>
      )}
    </div>
  );
}
