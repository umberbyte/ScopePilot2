/**
 * Advanced モード画面。`docs/detailed-design/02-ui-information-architecture.md` §3。
 * A01〜A13 のナビは packages/ui の advancedNavItems (権限で隠す規則は mode-policy と同一)。
 * まず読取系の A01 Dashboard / Case と A12 Jobs / Evidence / Audit を実装し、
 * 他画面は「未実装」プレースホルダで明示する (空画面にしない)。
 * 編集系 (crawl 計画・テンプレート選択など) は後続増分で、API は読取 endpoint のみ使う。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Field, Input, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea, tokens } from '@fluentui/react-components';
import { advancedDefaultRoute, advancedNavItems, type AdvancedNavItem } from '@scopepilot2/ui';
import { revisionConflictDecision } from '@scopepilot2/ui';
import type { AuthorizationRecord, CaseRecord, EngineCapabilitySnapshot, OperatorPermission, RunRecord } from '@scopepilot2/contracts';
import { GuidelinesCatalogScreen } from './guidelines-catalog.tsx';
import { SettingsScreen } from './settings-screen.tsx';
import { DecoderComparerScreen } from './decoder-comparer-screen.tsx';

/** desktop harness の operator (fixture・全権限)。operator 照会 API は後続増分で追加する。 */
const OPERATOR_PERMISSIONS: readonly OperatorPermission[] = ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'];

const CONTROL_ASPECTS = ['preSendScopeEnforcement', 'stopControl', 'budgetLease', 'rateLimit'] as const;

interface AuditEvent {
  readonly eventId: number;
  readonly type: string;
  readonly at: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', gap: '16px', padding: '16px', alignItems: 'flex-start' },
  nav: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '300px' },
  navItem: { textAlign: 'left', padding: '6px 10px', borderRadius: '4px', border: 'none', background: 'transparent', cursor: 'pointer' },
  navActive: { fontWeight: 600, backgroundColor: tokens.colorBrandBackground2 },
  content: { display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, minWidth: '560px' },
  section: { display: 'flex', flexDirection: 'column', gap: '4px' },
  muted: { color: tokens.colorNeutralForeground3 },
});

async function callJson<T>(apiBase: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
    // DomainError の code を添えて投げる (画面側は code で競合と検証 error を分ける)。
    throw Object.assign(new Error(errorBody?.message ?? `HTTP ${response.status}`), { code: errorBody?.code });
  }
  return (await response.json()) as T;
}

async function callNdjson<T>(apiBase: string, path: string): Promise<readonly T[]> {
  const response = await fetch(`${apiBase}${path}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as T);
}

/** A02 Scope & Authorization。scope 編集 (revision guard つき) と認可状態の表示。 */
function ScopeAuthorizationScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [caseRecord, setCaseRecord] = useState<CaseRecord | null>(null);
  const [allowedDraft, setAllowedDraft] = useState('');
  const [deniedDraft, setDeniedDraft] = useState('');
  const [limitsDraft, setLimitsDraft] = useState({ maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 });
  const [authorization, setAuthorization] = useState<AuthorizationRecord | null>(null);
  const [authzMissing, setAuthzMissing] = useState(false);
  const [conflict, setConflict] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const record = await callJson<CaseRecord>(apiBase, 'GET', '/api/case');
      setCaseRecord(record);
      setAllowedDraft(record.scope.allowedOrigins.join('\n'));
      setDeniedDraft(record.scope.deniedOrigins.join('\n'));
      setLimitsDraft(record.scope.limits);
    } catch {
      setCaseRecord(null);
      setError('案件が未作成です。A01 で案件を作成してください。');
      return;
    }
    setError('');
    try {
      const authz = await callJson<AuthorizationRecord>(apiBase, 'GET', '/api/authorization');
      setAuthorization(authz);
      setAuthzMissing(false);
    } catch {
      setAuthorization(null);
      setAuthzMissing(true);
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (caseRecord === null) {
      return;
    }
    setBusy(true);
    setError('');
    setConflict('');
    setSavedNote('');
    try {
      const outcome = await callJson<{ revision: number; narrowed: boolean; invalidatedConfirmationIds: readonly string[] }>(apiBase, 'POST', '/api/case/scope', {
        expectedRevision: caseRecord.revision,
        allowedOrigins: allowedDraft.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
        deniedOrigins: deniedDraft.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
        limits: limitsDraft,
      });
      const invalidationNote =
        outcome.invalidatedConfirmationIds.length > 0 ? `・確認 ${outcome.invalidatedConfirmationIds.length} 件を無効化` : '';
      setSavedNote(`revision ${outcome.revision} で保存しました${invalidationNote}`);
      await load();
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      if (code === 'Conflict') {
        // 競合時は自動上書きしない (UI-UT-006)。server 側の最新 revision を見に行き案内文を作る。
        let latest: { caseId: string; revision: number } | null = null;
        try {
          latest = await callJson<CaseRecord>(apiBase, 'GET', '/api/case');
        } catch {
          // 案件が消えた等の場合は server 応答の error 文面だけ示す。
        }
        const decision =
          latest !== null && caseRecord !== null
            ? revisionConflictDecision({ caseId: caseRecord.caseId, revision: caseRecord.revision }, { caseId: latest.caseId, revision: latest.revision })
            : undefined;
        setConflict(decision?.message ?? `案件は別の操作で更新されています (${String(cause)})。再読込してください。`);
      } else {
        setError(String(cause));
      }
    } finally {
      setBusy(false);
    }
  }, [allowedDraft, apiBase, caseRecord, deniedDraft, limitsDraft, load]);

  if (caseRecord === null) {
    return (
      <div className={styles.section}>
        <Text weight="semibold">Scope & Authorization</Text>
        {error !== '' ? <Text role="alert">{error}</Text> : <Text>取得中…</Text>}
      </div>
    );
  }

  return (
    <div className={styles.section}>
      <Text weight="semibold">{`Scope (現在 revision ${caseRecord.revision})`}</Text>
      <Field label="許可 Origin (1行1件)">
        <Textarea value={allowedDraft} onChange={(_, data) => setAllowedDraft(data.value)} rows={3} />
      </Field>
      <Field label="禁止 Origin (1行1件)">
        <Textarea value={deniedDraft} onChange={(_, data) => setDeniedDraft(data.value)} rows={3} />
      </Field>
      <div className={styles.section}>
        <Text>上限</Text>
        <Field label="最大リクエスト数">
          <Input
            type="number"
            value={String(limitsDraft.maxRequests)}
            onChange={(_, data) => setLimitsDraft((current) => ({ ...current, maxRequests: Number(data.value) }))}
          />
        </Field>
        <Field label="最大ページ数">
          <Input
            type="number"
            value={String(limitsDraft.maxPages)}
            onChange={(_, data) => setLimitsDraft((current) => ({ ...current, maxPages: Number(data.value) }))}
          />
        </Field>
        <Field label="最大実行分">
          <Input
            type="number"
            value={String(limitsDraft.maxDurationMinutes)}
            onChange={(_, data) => setLimitsDraft((current) => ({ ...current, maxDurationMinutes: Number(data.value) }))}
          />
        </Field>
      </div>
      <div className={styles.section}>
        {savedNote !== '' && <Text>{savedNote}</Text>}
        {conflict !== '' && (
          <Text role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>
            {conflict}
          </Text>
        )}
        {error !== '' && (
          <Text role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>
            {`Error: ${error}`}
          </Text>
        )}
        <Button appearance="primary" disabled={busy} onClick={() => void save()}>
          scope を保存する
        </Button>
        <Button disabled={busy} onClick={() => { setConflict(''); setSavedNote(''); void load(); }}>
          再読込
        </Button>
      </div>
      <Text weight="semibold">Authorization</Text>
      {authorization !== null ? (
        <>
          <Text>{`認可: 付与済み (${authorization.validFrom} 〜 ${authorization.validUntil})`}</Text>
          <Text className={styles.muted}>{`許可操作: ${authorization.allowedOperationClasses.join(', ')}`}</Text>
          <Text className={styles.muted}>{`対象 role: ${authorization.targetRoles.join(', ')}`}</Text>
        </>
      ) : authzMissing ? (
        <Text>認可: 未付与 (A01 の案件作成で付与、または POST /api/authorization で付与)</Text>
      ) : (
        <Text>取得中…</Text>
      )}
    </div>
  );
}

/** A11 が表示する所見の全体形 (contracts.Finding の表示に必要な部分)。 */
interface FindingView {
  readonly findingId: string;
  readonly title: string;
  readonly severity: string;
  readonly url: string;
  readonly method?: string;
  readonly occurrences: number;
  readonly status: string;
  readonly source: { readonly unverified: boolean; readonly engineVersion?: string };
}

/** A11 Findings / Organizer / Report。所見一覧・確認状態 (確定/棄却)・報告書生成。 */
function FindingsOrganizerScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [findings, setFindings] = useState<readonly FindingView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reportContent, setReportContent] = useState('');

  const load = useCallback(async () => {
    try {
      const body = await callJson<{ findings: readonly FindingView[] }>(apiBase, 'GET', '/api/findings');
      setFindings(body.findings);
      setLoaded(true);
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeStatus = useCallback(async (findingId: string, next: 'confirmed' | 'rejected') => {
    setBusy(true);
    setError('');
    try {
      await callJson(apiBase, 'POST', '/api/findings/status', { findingId, status: next });
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, load]);

  const generateReport = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const report = await callJson<{ content: string }>(apiBase, 'POST', '/api/report', { guidelines: ['OWASP WSTG 4.2'] });
      setReportContent(report.content);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase]);

  const statusLabel = (status: string): string =>
    ({ candidate: '候補 (未確認)', confirmed: '確定済み', rejected: '棄却済み', merged: '統合済み' })[status] ?? status;

  return (
    <div className={styles.section}>
      <Text weight="semibold">{`所見 (${findings.length} 件)`}</Text>
      {error !== '' && (
        <Text role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>
          {`Error: ${error}`}
        </Text>
      )}
      {findings.length === 0 ? (
        loaded && <Text className={styles.muted}>所見はまだありません。診断の実行 (S06 / run/scan) 後に表示されます。</Text>
      ) : (
        <Table size="small" aria-label="所見一覧">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>severity</TableHeaderCell>
              <TableHeaderCell>title</TableHeaderCell>
              <TableHeaderCell>URL</TableHeaderCell>
              <TableHeaderCell>観測</TableHeaderCell>
              <TableHeaderCell>状態</TableHeaderCell>
              <TableHeaderCell>操作</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {findings.map((finding) => (
              <TableRow key={finding.findingId}>
                <TableCell>{finding.severity}</TableCell>
                <TableCell>{finding.title}</TableCell>
                <TableCell>
                  {finding.url}
                  {finding.method === undefined ? '' : ` (${finding.method})`}
                  {finding.source.unverified ? ' [実影響未確認]' : ''}
                </TableCell>
                <TableCell>{`${finding.occurrences} 回`}</TableCell>
                <TableCell>{statusLabel(finding.status)}</TableCell>
                <TableCell>
                  <Button
                    size="small"
                    disabled={busy || finding.status === 'confirmed' || finding.status === 'merged'}
                    onClick={() => void changeStatus(finding.findingId, 'confirmed')}
                  >
                    確定
                  </Button>
                  <Button
                    size="small"
                    disabled={busy || finding.status === 'rejected' || finding.status === 'merged'}
                    onClick={() => void changeStatus(finding.findingId, 'rejected')}
                  >
                    棄却
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className={styles.section}>
        <Button appearance="primary" disabled={busy} onClick={() => void generateReport()}>
          報告書を生成する
        </Button>
        {reportContent !== '' && <Text block>{reportContent}</Text>}
      </div>
    </div>
  );
}

interface PlanStepView {
  readonly kind: string;
  readonly targetSnapshot: readonly string[];
  readonly limits: { readonly maxRequests: number; readonly maxPages: number; readonly maxDurationMinutes: number };
}

interface CandidateView {
  readonly candidateId: string;
  readonly url: string;
  readonly method: string;
  readonly category: string;
  readonly guidelineBasis: readonly string[];
  readonly confidence: number;
  readonly observationUrl: string;
}

/** limits 入力欄 (空 = 既定)。3 点のみで、service が案件上限へクランプする。 */
function LimitsFields({
  values,
  onChange,
}: {
  values: { maxRequests: string; maxPages: string; maxDurationMinutes: string };
  onChange: (next: { maxRequests: string; maxPages: string; maxDurationMinutes: string }) => void;
}): React.ReactElement {
  return (
    <>
      <Field label="最大リクエスト数 (空=既定)">
        <Input type="number" value={values.maxRequests} onChange={(_, data) => onChange({ ...values, maxRequests: data.value })} />
      </Field>
      <Field label="最大ページ数 (空=既定)">
        <Input type="number" value={values.maxPages} onChange={(_, data) => onChange({ ...values, maxPages: data.value })} />
      </Field>
      <Field label="最大実行分 (空=既定)">
        <Input type="number" value={values.maxDurationMinutes} onChange={(_, data) => onChange({ ...values, maxDurationMinutes: data.value })} />
      </Field>
    </>
  );
}

function limitsPayload(values: { maxRequests: string; maxPages: string; maxDurationMinutes: string }): { maxRequests: number; maxPages: number; maxDurationMinutes: number } | undefined {
  if (values.maxRequests === '' && values.maxPages === '' && values.maxDurationMinutes === '') {
    return undefined;
  }
  return {
    maxRequests: values.maxRequests === '' ? Number.MAX_SAFE_INTEGER : Number(values.maxRequests),
    maxPages: values.maxPages === '' ? Number.MAX_SAFE_INTEGER : Number(values.maxPages),
    maxDurationMinutes: values.maxDurationMinutes === '' ? Number.MAX_SAFE_INTEGER : Number(values.maxDurationMinutes),
  };
}

function planSummaryLines(steps: readonly PlanStepView[], planHash: string): string {
  return steps
    .map((step) => `${step.kind}: 対象 ${step.targetSnapshot.length} 件・上限 ${step.limits.maxRequests} req / ${step.limits.maxPages} page / ${step.limits.maxDurationMinutes} 分`)
    .join('\n') + `\n計画 hash: ${planHash.slice(0, 16)}…`;
}

/** A08 Scan plans。探索・診断計画の構築 (上限編集) → 確認 → 実行を 1 画面で行う。 */
function ScanPlansScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [seeds, setSeeds] = useState('http://fixture.target.test/');
  const [exploreLimits, setExploreLimits] = useState({ maxRequests: '', maxPages: '', maxDurationMinutes: '' });
  const [explorePlan, setExplorePlan] = useState<{ plan: { steps: readonly PlanStepView[] }; planHash: string; steps: readonly PlanStepView[] } | null>(null);
  const [exploreConfirmation, setExploreConfirmation] = useState<{ confirmationId: string } | null>(null);
  const [exploreResult, setExploreResult] = useState('');
  const [candidates, setCandidates] = useState<readonly CandidateView[]>([]);
  const [targets, setTargets] = useState('');
  const [scanLimits, setScanLimits] = useState({ maxRequests: '', maxPages: '', maxDurationMinutes: '' });
  const [scanPlan, setScanPlan] = useState<{ plan: { steps: readonly PlanStepView[] }; planHash: string; steps: readonly PlanStepView[] } | null>(null);
  const [scanConfirmation, setScanConfirmation] = useState<{ confirmationId: string } | null>(null);
  const [scanResult, setScanResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      setBusy(true);
      setError('');
      try {
        await action();
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const buildExplore = useCallback(() =>
    run(async () => {
      const result = await callJson<{ plan: { steps: readonly PlanStepView[] }; planHash: string }>(apiBase, 'POST', '/api/plan/explore', {
        seeds: seeds.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
        ...(limitsPayload(exploreLimits) === undefined ? {} : { limits: limitsPayload(exploreLimits) }),
      });
      setExplorePlan({ plan: result.plan, planHash: result.planHash, steps: result.plan.steps });
      setExploreConfirmation(null);
      setExploreResult('');
    }), [apiBase, exploreLimits, run, seeds]);

  const confirmExplore = useCallback(() =>
    run(async () => {
      if (explorePlan === null) {
        return;
      }
      const confirmation = await callJson<{ confirmationId: string; planHash: string }>(apiBase, 'POST', '/api/plan/confirm', { plan: explorePlan.plan });
      setExploreConfirmation(confirmation);
    }), [apiBase, explorePlan, run]);

  const executeExplore = useCallback(() =>
    run(async () => {
      if (explorePlan === null || exploreConfirmation === null) {
        return;
      }
      const result = await callJson<{ observations: readonly unknown[]; deniedUrls: readonly string[]; candidates: readonly CandidateView[] }>(apiBase, 'POST', '/api/run/explore', {
        plan: explorePlan.plan,
        confirmation: exploreConfirmation,
        maxDepth: 5,
      });
      setCandidates(result.candidates);
      setExploreResult(`探索完了: 観測 ${result.observations.length} 件・候補 ${result.candidates.length} 件・scope 外拒否 ${result.deniedUrls.length} 件`);
    }), [apiBase, exploreConfirmation, explorePlan, run]);

  const buildScan = useCallback(() =>
    run(async () => {
      const targetList = targets.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      const result = await callJson<{ plan: { steps: readonly PlanStepView[] }; planHash: string }>(apiBase, 'POST', '/api/plan/scan', {
        targets: targetList,
        ...(limitsPayload(scanLimits) === undefined ? {} : { limits: limitsPayload(scanLimits) }),
      });
      setScanPlan({ plan: result.plan, planHash: result.planHash, steps: result.plan.steps });
      setScanConfirmation(null);
      setScanResult('');
    }), [apiBase, run, scanLimits, targets]);

  const confirmScan = useCallback(() =>
    run(async () => {
      if (scanPlan === null) {
        return;
      }
      const confirmation = await callJson<{ confirmationId: string; planHash: string }>(apiBase, 'POST', '/api/plan/confirm', { plan: scanPlan.plan });
      setScanConfirmation(confirmation);
    }), [apiBase, run, scanPlan]);

  const executeScan = useCallback(() =>
    run(async () => {
      if (scanPlan === null || scanConfirmation === null || candidates.length === 0) {
        return;
      }
      const result = await callJson<{ findings: readonly unknown[]; engineVersion: string }>(apiBase, 'POST', '/api/run/scan', {
        plan: scanPlan.plan,
        confirmation: scanConfirmation,
        adopted: candidates,
      });
      setScanResult(`診断完了 (engine ${result.engineVersion}): 所見 ${result.findings.length} 件 — A11 で確認できます`);
    }), [apiBase, candidates, run, scanConfirmation, scanPlan]);

  return (
    <div className={styles.section}>
      <Text weight="semibold">探索計画 (crawl)</Text>
      {error !== '' && (
        <Text role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>
          {`Error: ${error}`}
        </Text>
      )}
      <Field label="開始 URL (1行1件)">
        <Textarea value={seeds} onChange={(_, data) => setSeeds(data.value)} rows={2} />
      </Field>
      <LimitsFields values={exploreLimits} onChange={setExploreLimits} />
      <div className={styles.section}>
        <Button appearance="primary" disabled={busy} onClick={() => void buildExplore()}>
          探索計画を構築する
        </Button>
        <Button disabled={busy || explorePlan === null} onClick={() => void confirmExplore()}>
          探索計画を確認する
        </Button>
        <Button disabled={busy || exploreConfirmation === null} onClick={() => void executeExplore()}>
          探索を実行する
        </Button>
      </div>
      {explorePlan !== null && <Text block style={{ whiteSpace: 'pre-wrap' }}>{`計画:\n${planSummaryLines(explorePlan.steps, explorePlan.planHash)}`}</Text>}
      {exploreConfirmation !== null && <Text>{`確認 ID: ${exploreConfirmation.confirmationId}`}</Text>}
      {exploreResult !== '' && <Text>{exploreResult}</Text>}

      <Text weight="semibold">診断計画 (active scan)</Text>
      <Field label="対象 URL (1行1件・探索で観測済みの URL)">
        <Textarea value={targets} onChange={(_, data) => setTargets(data.value)} rows={3} />
      </Field>
      <Button disabled={busy || candidates.length === 0} onClick={() => setTargets(candidates.map((candidate) => candidate.url).join('\n'))}>
        探索結果の候補をすべて対象に設定
      </Button>
      <LimitsFields values={scanLimits} onChange={setScanLimits} />
      <div className={styles.section}>
        <Button appearance="primary" disabled={busy} onClick={() => void buildScan()}>
          診断計画を構築する
        </Button>
        <Button disabled={busy || scanPlan === null} onClick={() => void confirmScan()}>
          診断計画を確認する
        </Button>
        <Button disabled={busy || scanConfirmation === null || candidates.length === 0} onClick={() => void executeScan()}>
          診断を実行する
        </Button>
      </div>
      {scanPlan !== null && <Text block style={{ whiteSpace: 'pre-wrap' }}>{`計画:\n${planSummaryLines(scanPlan.steps, scanPlan.planHash)}`}</Text>}
      {scanConfirmation !== null && <Text>{`確認 ID: ${scanConfirmation.confirmationId}`}</Text>}
      {scanResult !== '' && <Text>{scanResult}</Text>}
    </div>
  );
}

interface ObservationView {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly title?: string;
  readonly discoveredFrom: string | null;
  readonly depth: number;
  readonly originType: 'crawl' | 'document-hint';
}

/** A04 Browser / Site map / HTTP history。観測済み page の一覧と scope 拒否の開示。 */
function SiteMapScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [observations, setObservations] = useState<readonly ObservationView[]>([]);
  const [deniedUrls, setDeniedUrls] = useState<readonly { url: string; reason: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const body = await callJson<{ observations: readonly ObservationView[]; deniedUrls: readonly { url: string; reason: string }[] }>(apiBase, 'GET', '/api/observations');
        setObservations(body.observations);
        setDeniedUrls(body.deniedUrls);
        setLoaded(true);
      } catch (cause) {
        setError(String(cause));
      }
    })();
  }, [apiBase]);

  const originLabel = (originType: ObservationView['originType']): string =>
    originType === 'crawl' ? 'クロール' : '文書ヒント (未確認)';

  return (
    <div className={styles.section}>
      <Text weight="semibold">{`観測済み page (${observations.length} 件)`}</Text>
      {error !== '' && (
        <Text role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>
          {`Error: ${error}`}
        </Text>
      )}
      {observations.length === 0 ? (
        loaded && <Text className={styles.muted}>観測はまだありません。A08 (または S03) で探索を実行すると表示されます。</Text>
      ) : (
        <Table size="small" aria-label="観測済み page 一覧">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>URL</TableHeaderCell>
              <TableHeaderCell>status</TableHeaderCell>
              <TableHeaderCell>種別</TableHeaderCell>
              <TableHeaderCell>title</TableHeaderCell>
              <TableHeaderCell>深さ</TableHeaderCell>
              <TableHeaderCell>発見元</TableHeaderCell>
              <TableHeaderCell>由来</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {observations.map((observation) => (
              <TableRow key={observation.url}>
                <TableCell>{observation.url}</TableCell>
                <TableCell>{String(observation.status)}</TableCell>
                <TableCell>{observation.contentType}</TableCell>
                <TableCell>{observation.title ?? ''}</TableCell>
                <TableCell>{String(observation.depth)}</TableCell>
                <TableCell>{observation.discoveredFrom ?? 'seed'}</TableCell>
                <TableCell>{originLabel(observation.originType)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Text weight="semibold">{`scope 拒否 (${deniedUrls.length} 件)`}</Text>
      {deniedUrls.length === 0 ? (
        <Text className={styles.muted}>拒否された URL はありません。</Text>
      ) : (
        deniedUrls.map((denied) => (
          <Text key={denied.url} block>
            {`${denied.url} — ${denied.reason}`}
          </Text>
        ))
      )}
      <Text className={styles.muted}>HTTP history (通信一覧・仮想化表示) は後続増分で提供します。</Text>
    </div>
  );
}

export function AdvancedApp({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [items] = useState<readonly AdvancedNavItem[]>(() => advancedNavItems(OPERATOR_PERMISSIONS));
  const [activeRoute, setActiveRoute] = useState<string>(() => advancedDefaultRoute(OPERATOR_PERMISSIONS) ?? 'advanced.dashboard');
  const [caseRecord, setCaseRecord] = useState<CaseRecord | null>(null);
  const [caseMissing, setCaseMissing] = useState(false);
  const [capabilities, setCapabilities] = useState<readonly EngineCapabilitySnapshot[]>([]);
  const [interrupted, setInterrupted] = useState<readonly RunRecord[]>([]);
  const [events, setEvents] = useState<readonly AuditEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refreshCase = useCallback(async () => {
    try {
      const record = await callJson<CaseRecord>(apiBase, 'GET', '/api/case');
      setCaseRecord(record);
      setCaseMissing(false);
    } catch {
      // GET /api/case は案件未作成で ValidationFailed を返す。「未作成」扱いにするだけに留める。
      setCaseRecord(null);
      setCaseMissing(true);
    }
  }, [apiBase]);

  const refreshAudit = useCallback(async () => {
    try {
      const [caps, intr, evts] = await Promise.all([
        callJson<{ capabilities: readonly EngineCapabilitySnapshot[] }>(apiBase, 'GET', '/api/capabilities'),
        callJson<{ interrupted: readonly RunRecord[] }>(apiBase, 'GET', '/api/runs/interrupted'),
        callNdjson<AuditEvent>(apiBase, '/api/events'),
      ]);
      setCapabilities(caps.capabilities);
      setInterrupted(intr.interrupted);
      setEvents(evts);
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase]);

  useEffect(() => {
    void refreshCase();
    void refreshAudit();
  }, [refreshCase, refreshAudit]);

  const createCase = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await callJson(apiBase, 'POST', '/api/case', {
        name: 'ScopePilot2 案件',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      });
      await callJson(apiBase, 'POST', '/api/authorization', {
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['unauthenticated'],
        validFrom: '2026-10-18T00:00:00.000Z',
        validUntil: '2026-10-19T00:00:00.000Z',
        evidenceLabel: '認可 (デスクトップ)',
        evidenceContent: 'desktop advanced evidence',
      });
      await refreshCase();
      await refreshAudit();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, refreshAudit, refreshCase]);

  const activeItem = items.find((item) => item.route === activeRoute);
  return (
    <div className={styles.root}>
      <nav className={styles.nav} aria-label="Advanced 画面ナビ">
        {items.map((item) => (
          <button
            key={item.screenId}
            type="button"
            className={item.route === activeRoute ? `${styles.navItem} ${styles.navActive}` : styles.navItem}
            onClick={() => setActiveRoute(item.route)}
          >
            {item.screenId} {item.label}
          </button>
        ))}
      </nav>
      <div className={styles.content}>
        <Text size={400} weight="semibold">
          {activeItem === undefined ? '' : `${activeItem.screenId} ${activeItem.label}`}
        </Text>
        {error !== '' && (
          <Text role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>
            {`Error: ${error}`}
          </Text>
        )}
        {activeRoute === 'advanced.dashboard' && (
          <>
            <div className={styles.section}>
              <Text weight="semibold">案件</Text>
              {caseRecord !== null ? (
                <>
                  <Text>{`案件「${caseRecord.name}」 (revision ${caseRecord.revision})`}</Text>
                  <Text className={styles.muted}>{`対象 Origin: ${caseRecord.scope.allowedOrigins.join(', ')}`}</Text>
                  <Text className={styles.muted}>{`上限: ${caseRecord.scope.limits.maxRequests} req / ${caseRecord.scope.limits.maxPages} page / ${caseRecord.scope.limits.maxDurationMinutes} 分`}</Text>
                </>
              ) : caseMissing ? (
                <>
                  <Text>案件が未作成です。</Text>
                  <Button disabled={busy} onClick={() => void createCase()}>
                    案件を作成する
                  </Button>
                </>
              ) : (
                <Text>取得中…</Text>
              )}
            </div>
            <div className={styles.section}>
              <Text weight="semibold">外部 engine 能力 (保証等級)</Text>
              <Table size="small" aria-label="engine 能力表">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>engine</TableHeaderCell>
                    <TableHeaderCell>版</TableHeaderCell>
                    <TableHeaderCell>由来</TableHeaderCell>
                    {CONTROL_ASPECTS.map((aspect) => (
                      <TableHeaderCell key={aspect}>{aspect}</TableHeaderCell>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {capabilities.map((cap) => (
                    <TableRow key={`${cap.engineKind}-${cap.engineVersion}`}>
                      <TableCell>{cap.engineKind}</TableCell>
                      <TableCell>{cap.engineVersion}</TableCell>
                      <TableCell>
                        {cap.source === 'fixture' ? 'fixture (実測ではない)' : 'measured'}
                      </TableCell>
                      {CONTROL_ASPECTS.map((aspect) => (
                        <TableCell key={aspect}>{cap.guaranteeLevels[aspect]}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className={styles.section}>
              <Text weight="semibold">前回中断された run (design/22 §6)</Text>
              {interrupted.length === 0 ? (
                <Text className={styles.muted}>ありません。実行中のまま残った run は検出されませんでした。</Text>
              ) : (
                interrupted.map((run) => (
                  <Badge key={run.runId} appearance="ghost">{`${run.runId}: ${run.state} (${run.stopReason ?? 'unknown'})`}</Badge>
                ))
              )}
            </div>
          </>
        )}
        {activeRoute === 'advanced.jobs' && (
          <div className={styles.section}>
            <Text weight="semibold">監査 event ({events.length} 件)</Text>
            {events.length === 0 ? (
              <Text className={styles.muted}>監査 event はまだありません。</Text>
            ) : (
              events.map((event) => (
                <Text key={event.eventId} block>
                  {`#${event.eventId} ${event.type} ${event.at}`}
                </Text>
              ))
            )}
          </div>
        )}
        {activeRoute === 'advanced.scope' && <ScopeAuthorizationScreen apiBase={apiBase} />}
        {activeRoute === 'findings' && <FindingsOrganizerScreen apiBase={apiBase} />}
        {activeRoute === 'scan-plans' && <ScanPlansScreen apiBase={apiBase} />}
        {activeRoute === 'browser.site-map' && <SiteMapScreen apiBase={apiBase} />}
        {activeRoute === 'advanced.guidelines' && <GuidelinesCatalogScreen />}
        {activeRoute === 'decoder' && <DecoderComparerScreen apiBase={apiBase} />}
        {activeRoute === 'settings' && <SettingsScreen apiBase={apiBase} />}
        {activeRoute !== 'advanced.dashboard' && activeRoute !== 'advanced.jobs' && activeRoute !== 'advanced.scope' && activeRoute !== 'findings' && activeRoute !== 'scan-plans' && activeRoute !== 'browser.site-map' && activeRoute !== 'advanced.guidelines' && activeRoute !== 'settings' && activeRoute !== 'decoder' && (
          <Text className={styles.muted}>この画面は未実装です (後続増分で提供します)。</Text>
        )}
      </div>
    </div>
  );
}
