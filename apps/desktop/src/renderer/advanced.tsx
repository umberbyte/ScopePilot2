/**
 * Advanced モード画面。`docs/detailed-design/02-ui-information-architecture.md` §3。
 * ナビは packages/ui の advancedNavGroups (design/40 §3 の目的別 9 グループ。権限で隠す規則は mode-policy と同一)。
 * 再編 P1 では既存画面の中身は変えず、新 route から既存画面へ接続する (SCREEN_HOSTS)。
 * 既存画面がまだない route は「後続段階で提供」を明示する (空画面にしない)。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { MessageBar, Badge, Button, Field, Input, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea, tokens } from '@fluentui/react-components';
import { advancedDefaultRoute, advancedNavGroups, normalizeRoute, type AdvancedNavGroup, type AdvancedRoute, ActivityPanel, useActivityPanel } from '@scopepilot2/ui';
import { revisionConflictDecision } from '@scopepilot2/ui';
import type { AuthorizationRecord, CaseRecord, EngineCapabilitySnapshot, OperatorPermission, RunRecord } from '@scopepilot2/contracts';
import { GuidelinesCatalogScreen } from './guidelines-catalog.tsx';
import { t } from './resources.ts';
import { SettingsScreen } from './settings-screen.tsx';
import { DecoderComparerScreen } from './decoder-comparer-screen.tsx';
import { DecoderScreen } from './decoder-screen.tsx';
import { ComparerScreen } from './comparer-screen.tsx';
import { ProxyInterceptScreen } from './proxy-intercept-screen.tsx';
import { RepeaterScreen } from './repeater-screen.tsx';
import { FuzzerScreen } from './fuzzer-screen.tsx';
import { SessionsScreen } from './sessions-screen.tsx';

/** ローカル desktop operator。operator 照会 API は後続増分で追加する。 */
const OPERATOR_PERMISSIONS: readonly OperatorPermission[] = ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'];

/** 再編前の画面 (旧 A01〜A13 の中身)。新 route はこのいずれかに接続する (design/40 付録 A)。 */
type ScreenHost =
  | 'dashboard'
  | 'scope'
  | 'guidelines'
  | 'sessions'
  | 'siteMap'
  | 'scanPlans'
  | 'proxy'
  | 'repeater'
  | 'fuzzer'
  | 'decoder'
  | 'decoderOnly'
  | 'comparerOnly'
  | 'sequencerOnly'
  | 'findings'
  | 'audit'
  | 'settings';

/** 新 route → 既存画面。未登録の route は既存画面がなく、後続段階で提供する。 */
const SCREEN_HOSTS: Partial<Record<AdvancedRoute, ScreenHost>> = {
  'adv.case.overview': 'dashboard',
  'adv.case.scope': 'scope',
  'adv.case.guidelines': 'guidelines',
  'adv.auth.login': 'sessions',
  'adv.auth.session': 'sessions',
  'adv.recon.site-map': 'siteMap',
  'adv.recon.history': 'siteMap',
  'adv.recon.crawl': 'scanPlans',
  'adv.recon.api': 'scanPlans',
  'adv.recon.hints': 'scanPlans',
  'adv.manual.proxy': 'proxy',
  'adv.manual.repeater': 'repeater',
  'adv.manual.fuzzer': 'fuzzer',
  'adv.manual.websocket': 'decoder',
  'adv.manual.oast': 'decoder',
  'adv.manual.dom': 'decoder',
  'adv.scan.active': 'scanPlans',
  'adv.scan.templates': 'guidelines',
  'adv.tools.decoder': 'decoderOnly',
  'adv.tools.comparer': 'comparerOnly',
  'adv.tools.sequencer': 'sequencerOnly',
  'adv.results.findings': 'findings',
  'adv.results.report': 'findings',
  'adv.ops.jobs': 'audit',
  'adv.ops.audit': 'audit',
  'adv.settings.engines': 'settings',
  'adv.settings.certificates': 'settings',
  'adv.settings.library': 'settings',
  'adv.settings.extensions': 'settings',
  'adv.settings.ai': 'settings',
};

const CONTROL_ASPECTS = ['preSendScopeEnforcement', 'stopControl', 'budgetLease', 'rateLimit'] as const;
const CONTROL_ASPECT_LABELS: Record<(typeof CONTROL_ASPECTS)[number], string> = {
  preSendScopeEnforcement: 'scope guard',
  stopControl: 'stop',
  budgetLease: 'budget',
  rateLimit: 'rate limit',
};

interface AuditEvent {
  readonly eventId: number;
  readonly type: string;
  readonly at: string;
}

const useStyles = makeStyles({
  root: {
    display: 'grid',
    gridTemplateColumns: '264px minmax(0, 1fr)',
    flex: 1,
    minHeight: 0,
    color: tokens.colorNeutralForeground1,
  },
  nav: {
    position: 'sticky',
    top: '64px',
    display: 'flex',
    height: 'calc(100vh - 64px)',
    flexDirection: 'column',
    gap: '3px',
    padding: '20px 12px',
    overflowY: 'auto',
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  navHeader: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '0 10px 14px' },
  navEyebrow: {
    color: tokens.colorBrandForeground1,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  navItem: {
    width: '100%',
    minHeight: '38px',
    textAlign: 'left',
    padding: '8px 10px',
    borderRadius: '6px',
    border: '1px solid transparent',
    color: tokens.colorNeutralForeground2,
    backgroundColor: 'transparent',
    cursor: 'pointer',
  },
  navGroup: { display: 'flex', flexDirection: 'column', gap: '3px', paddingBottom: '10px' },
  navFooter: { marginTop: 'auto', paddingTop: '10px', borderTop: `1px solid ${tokens.colorNeutralStroke2}` },
  navGroupLabel: {
    padding: '4px 10px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  navEgress: { marginLeft: '6px', color: tokens.colorNeutralForeground3 },
  navActive: {
    color: tokens.colorNeutralForeground1,
    fontWeight: 600,
    backgroundColor: tokens.colorBrandBackground2,
    borderColor: tokens.colorBrandStroke2,
    boxShadow: `inset 3px 0 ${tokens.colorBrandStroke1}`,
  },
  content: {
    display: 'flex',
    width: 'calc(100% - 48px)',
    maxWidth: '1180px',
    minWidth: 0,
    minHeight: 'calc(100vh - 112px)',
    flexDirection: 'column',
    gap: '16px',
    margin: '24px',
    padding: '24px',
    overflowX: 'auto',
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '10px',
    boxShadow: tokens.shadow4,
  },
  contentHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    paddingBottom: '16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    '& > button': { alignSelf: 'flex-start' },
  },
  tableHeaderLabel: {
    display: 'block',
    minWidth: 0,
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  muted: { color: tokens.colorNeutralForeground3 },
  '@media (max-width: 900px)': {
    root: { gridTemplateColumns: '208px minmax(0, 1fr)' },
    nav: { position: 'static', height: 'auto' },
    content: { width: 'calc(100% - 24px)', margin: '12px', padding: '16px' },
  },
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
      setError(t('a02.caseMissing'));
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
        outcome.invalidatedConfirmationIds.length > 0 ? t('a02.invalidated', { count: outcome.invalidatedConfirmationIds.length }) : '';
      setSavedNote(t('a02.saved', { revision: outcome.revision, invalidation: invalidationNote }));
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
        setConflict(decision?.message ?? t('a02.conflictFallback', { cause: String(cause) }));
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
        {error !== '' ? <MessageBar intent="error">{error}</MessageBar> : <Text>{t('common.loading')}</Text>}
      </div>
    );
  }

  return (
    <div className={styles.section}>
      <Text weight="semibold">{t('a02.scopeTitle', { revision: caseRecord.revision })}</Text>
      <Field label={t('a02.allowedLabel')}>
        <Textarea value={allowedDraft} onChange={(_, data) => setAllowedDraft(data.value)} rows={3} />
      </Field>
      <Field label={t('a02.deniedLabel')}>
        <Textarea value={deniedDraft} onChange={(_, data) => setDeniedDraft(data.value)} rows={3} />
      </Field>
      <div className={styles.section}>
        <Text>{t('a02.limitsTitle')}</Text>
        <Field label={t('a02.maxRequestsLabel')}>
          <Input
            type="number"
            value={String(limitsDraft.maxRequests)}
            onChange={(_, data) => setLimitsDraft((current) => ({ ...current, maxRequests: Number(data.value) }))}
          />
        </Field>
        <Field label={t('a02.maxPagesLabel')}>
          <Input
            type="number"
            value={String(limitsDraft.maxPages)}
            onChange={(_, data) => setLimitsDraft((current) => ({ ...current, maxPages: Number(data.value) }))}
          />
        </Field>
        <Field label={t('a02.maxDurationLabel')}>
          <Input
            type="number"
            value={String(limitsDraft.maxDurationMinutes)}
            onChange={(_, data) => setLimitsDraft((current) => ({ ...current, maxDurationMinutes: Number(data.value) }))}
          />
        </Field>
      </div>
      <div className={styles.section}>
        {savedNote !== '' && <Text role="status">{savedNote}</Text>}
        {conflict !== '' && (
          <MessageBar intent="warning">{conflict}</MessageBar>
        )}
        {error !== '' && (
          <MessageBar intent="error">
            {`Error: ${error}`}
          </MessageBar>
        )}
        <Button appearance="primary" disabled={busy} onClick={() => void save()}>
          {t('a02.save')}
        </Button>
        <Button disabled={busy} onClick={() => { setConflict(''); setSavedNote(''); void load(); }}>
          {t('a02.reload')}
        </Button>
      </div>
      <Text weight="semibold">Authorization</Text>
      {authorization !== null ? (
        <>
          <Text>{t('a02.authzGranted', { validFrom: authorization.validFrom, validUntil: authorization.validUntil })}</Text>
          <Text className={styles.muted}>{t('a02.authzOperations', { operations: authorization.allowedOperationClasses.join(', ') })}</Text>
          <Text className={styles.muted}>{t('a02.authzRoles', { roles: authorization.targetRoles.join(', ') })}</Text>
        </>
      ) : authzMissing ? (
        <Text>{t('a02.authzMissing')}</Text>
      ) : (
        <Text>{t('common.loading')}</Text>
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
  const [reviewNotes, setReviewNotes] = useState('');
  const [severityRationale, setSeverityRationale] = useState('');
  const [cvssVector, setCvssVector] = useState('');
  const [cvssScore, setCvssScore] = useState('');

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
      await callJson(apiBase, 'POST', '/api/findings/status', {
        findingId,
        status: next,
        reproduction: next === 'confirmed' ? 'reproduced' : 'not-reproduced',
        notes: reviewNotes,
        severityRationale,
        ...(cvssVector.trim() === '' && cvssScore.trim() === '' ? {} : {
          cvssVersion: '3.1', cvssVector: cvssVector.trim(), cvssScore: Number(cvssScore),
        }),
      });
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, cvssScore, cvssVector, load, reviewNotes, severityRationale]);

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
    ({ candidate: t('a11.status.candidate'), confirmed: t('a11.status.confirmed'), rejected: t('a11.status.rejected'), merged: t('a11.status.merged') })[status] ?? status;

  return (
    <div className={styles.section}>
      <Text weight="semibold">{t('a11.findingsTitle', { count: findings.length })}</Text>
      {error !== '' && (
        <MessageBar intent="error">
          {`Error: ${error}`}
        </MessageBar>
      )}
      {findings.length === 0 ? (
        loaded && <Text className={styles.muted}>{t('a11.empty')}</Text>
      ) : (
        <>
        <div className={styles.section}>
          <Text weight="semibold">人による検証記録（確定・誤検知判定の前に入力）</Text>
          <Field label="再現確認・誤検知判定のメモ" required><Textarea value={reviewNotes} onChange={(_, data) => setReviewNotes(data.value)} /></Field>
          <Field label="深刻度の根拠" required><Textarea value={severityRationale} onChange={(_, data) => setSeverityRationale(data.value)} /></Field>
          <Field label="CVSS v3.1 ベクタ（任意）"><Input value={cvssVector} onChange={(_, data) => setCvssVector(data.value)} /></Field>
          <Field label="CVSS スコア（任意）"><Input type="number" min={0} max={10} step={0.1} value={cvssScore} onChange={(_, data) => setCvssScore(data.value)} /></Field>
        </div>
        <Table size="small" aria-label={t('a11.table.aria')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>severity</TableHeaderCell>
              <TableHeaderCell>title</TableHeaderCell>
              <TableHeaderCell>URL</TableHeaderCell>
              <TableHeaderCell>{t('a11.col.observations')}</TableHeaderCell>
              <TableHeaderCell>{t('common.col.state')}</TableHeaderCell>
              <TableHeaderCell>{t('common.col.actions')}</TableHeaderCell>
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
                  {finding.source.unverified ? t('a11.unverified') : ''}
                </TableCell>
                <TableCell>{t('a11.occurrences', { count: finding.occurrences })}</TableCell>
                <TableCell>{statusLabel(finding.status)}</TableCell>
                <TableCell>
                  <Button
                    size="small"
                    disabled={busy || finding.status === 'confirmed' || finding.status === 'merged'}
                    onClick={() => void changeStatus(finding.findingId, 'confirmed')}
                  >
                    {t('a11.confirm')}
                  </Button>
                  <Button
                    size="small"
                    disabled={busy || finding.status === 'rejected' || finding.status === 'merged'}
                    onClick={() => void changeStatus(finding.findingId, 'rejected')}
                  >
                    {t('a11.reject')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </>
      )}
      <div className={styles.section}>
        <Button appearance="primary" disabled={busy} onClick={() => void generateReport()}>
          {t('a11.generateReport')}
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
      <Field label={t('a08.maxRequestsOptionalLabel')}>
        <Input type="number" value={values.maxRequests} onChange={(_, data) => onChange({ ...values, maxRequests: data.value })} />
      </Field>
      <Field label={t('a08.maxPagesOptionalLabel')}>
        <Input type="number" value={values.maxPages} onChange={(_, data) => onChange({ ...values, maxPages: data.value })} />
      </Field>
      <Field label={t('a08.maxDurationOptionalLabel')}>
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
    .map((step) => t('a08.planLine', { kind: step.kind, targets: step.targetSnapshot.length, maxRequests: step.limits.maxRequests, maxPages: step.limits.maxPages, maxDurationMinutes: step.limits.maxDurationMinutes }))
    .join('\n') + t('a08.planHash', { hash: planHash.slice(0, 16) });
}

/** A08 Scan plans。探索・診断計画の構築 (上限編集) → 確認 → 実行を 1 画面で行う。 */
function ScanPlansScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [seeds, setSeeds] = useState('');
  const [exploreRole, setExploreRole] = useState('');
  const [hintLabel, setHintLabel] = useState('');
  const [hintUrls, setHintUrls] = useState('');
  const [hints, setHints] = useState<readonly { documentLabel: string; urls: readonly string[] }[]>([]);
  const [hintNotice, setHintNotice] = useState('');
  const [paramHintName, setParamHintName] = useState('');
  const [paramHintValues, setParamHintValues] = useState('');
  const [paramHints, setParamHints] = useState<readonly { documentLabel: string; parameters: readonly { name: string; values: readonly string[] }[] }[]>([]);
  const [priorityIncludes, setPriorityIncludes] = useState('');
  const [priorityCategory, setPriorityCategory] = useState('pii');
  const [priorityRules, setPriorityRules] = useState<readonly { urlIncludes: string; category: string }[]>([]);
  const [authHintRole, setAuthHintRole] = useState('');
  const [authHintMethod, setAuthHintMethod] = useState('Form');
  const [authHintLocation, setAuthHintLocation] = useState('');
  const [exploreLimits, setExploreLimits] = useState({ maxRequests: '', maxPages: '', maxDurationMinutes: '' });
  const [explorePlan, setExplorePlan] = useState<{ plan: { steps: readonly PlanStepView[] }; planHash: string; steps: readonly PlanStepView[] } | null>(null);
  const [exploreConfirmation, setExploreConfirmation] = useState<{ confirmationId: string } | null>(null);
  const [exploreResult, setExploreResult] = useState('');
  const [candidates, setCandidates] = useState<readonly CandidateView[]>([]);
  const [targets, setTargets] = useState('');
  const [apiSpecLabel, setApiSpecLabel] = useState('');
  const [apiSpecText, setApiSpecText] = useState('');
  const [apiSpecNotice, setApiSpecNotice] = useState('');
  const [scanRole, setScanRole] = useState('');
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

  const loadHints = useCallback(async () => {
    try {
      const body = await callJson<{ hints: readonly { documentLabel: string; urls: readonly string[] }[] }>(apiBase, 'GET', '/api/documents/hints');
      setHints(body.hints);
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase]);

  const registerHints = useCallback(
    () =>
      run(async () => {
        const urls = hintUrls.split('\n').map((line) => line.trim()).filter((line) => line !== '');
        const result = await callJson<{ documentLabel: string; urlCount: number; acceptedUrlCount: number }>(apiBase, 'POST', '/api/documents/hints', {
          documentLabel: hintLabel,
          urls,
        });
        setHintNotice(t('a08.hintRegistered', { label: result.documentLabel, accepted: result.acceptedUrlCount, total: result.urlCount }));
        await loadHints();
      }),
    [apiBase, hintLabel, hintUrls, loadHints, run],
  );

  const loadParamHints = useCallback(async () => {
    try {
      const body = await callJson<{ hints: readonly { documentLabel: string; parameters: readonly { name: string; values: readonly string[] }[] }[] }>(apiBase, 'GET', '/api/documents/parameter-hints');
      setParamHints(body.hints);
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase]);

  const registerParamHints = useCallback(
    () =>
      run(async () => {
        const values = paramHintValues.split(',').map((value) => value.trim()).filter((value) => value !== '');
        const result = await callJson<{ documentLabel: string; parameterCount: number }>(apiBase, 'POST', '/api/documents/parameter-hints', {
          documentLabel: hintLabel,
          parameters: [{ name: paramHintName, values }],
        });
        setHintNotice(t('a08.paramHintRegistered', { label: result.documentLabel, count: result.parameterCount }));
        await loadParamHints();
      }),
    [apiBase, hintLabel, loadParamHints, paramHintName, paramHintValues, run],
  );

  const loadPriorityRules = useCallback(async () => {
    try {
      const body = await callJson<{ rules: readonly { urlIncludes: string; category: string }[] }>(apiBase, 'GET', '/api/documents/priority-hints');
      setPriorityRules(body.rules);
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase]);

  useEffect(() => {
    void loadHints();
    void loadParamHints();
    void loadPriorityRules();
  }, [loadHints, loadParamHints, loadPriorityRules]);

  const registerPriorityHints = useCallback(
    () =>
      run(async () => {
        const result = await callJson<{ documentLabel: string; ruleCount: number }>(apiBase, 'POST', '/api/documents/priority-hints', {
          documentLabel: hintLabel,
          rules: [{ urlIncludes: priorityIncludes, category: priorityCategory === 'payment' ? 'payment' : 'pii' }],
        });
        setHintNotice(t('a08.priorityRegistered', { label: result.documentLabel, count: result.ruleCount }));
        await loadPriorityRules();
      }),
    [apiBase, hintLabel, loadPriorityRules, priorityCategory, priorityIncludes, run],
  );

  const registerAuthHints = useCallback(
    () =>
      run(async () => {
        const result = await callJson<{ documentLabel: string; entryCount: number }>(apiBase, 'POST', '/api/documents/auth-hints', {
          documentLabel: hintLabel,
          entries: [{ role: authHintRole, authMethod: authHintMethod, documentLocation: authHintLocation }],
        });
        setHintNotice(t('a08.authHintRegistered', { label: result.documentLabel, count: result.entryCount }));
      }),
    [apiBase, authHintLocation, authHintMethod, authHintRole, hintLabel, run],
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
        // 任意: runLogin 済み role の session で観測する (design/f09)。空なら非認証。
        ...(exploreRole.trim() === '' ? {} : { role: exploreRole.trim() }),
      });
      setCandidates(result.candidates);
      setExploreResult(t('a08.exploreDone', { observations: result.observations.length, candidates: result.candidates.length, denied: result.deniedUrls.length }));
    }), [apiBase, exploreConfirmation, explorePlan, exploreRole, run]);

  const importApiSpec = useCallback(
    () =>
      run(async () => {
        let document: unknown;
        try {
          document = JSON.parse(apiSpecText);
        } catch {
          throw new Error(t('a08.apiSpecInvalid'));
        }
        const result = await callJson<{ endpoints: readonly { url: string }[]; excludedServers: readonly string[]; warnings: readonly string[] }>(apiBase, 'POST', '/api/import/api-spec', { documentLabel: apiSpecLabel, document });
        const urls = [...new Set(result.endpoints.map((endpoint) => endpoint.url))];
        setTargets(urls.join('\n'));
        setApiSpecNotice(t('a08.apiSpecImported', { endpoints: result.endpoints.length, targets: urls.length, excluded: result.excludedServers.length, warnings: result.warnings.length }));
      }),
    [apiBase, apiSpecLabel, apiSpecText, run],
  );

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
      const result = await callJson<{ findings: readonly unknown[]; engineVersion: string; scanRequest: { sessionCookieNames?: readonly string[] } }>(apiBase, 'POST', '/api/run/scan', {
        plan: scanPlan.plan,
        confirmation: scanConfirmation,
        adopted: candidates,
        // role 指定時はその role の session を診断へ適用する (design/08)。空なら非認証。
        ...(scanRole.trim() === '' ? {} : { role: scanRole.trim() }),
      });
      const sessionNote = result.scanRequest.sessionCookieNames !== undefined
        ? ` ${t('a08.sessionApplied', { cookies: result.scanRequest.sessionCookieNames.join(', ') || '—' })}`
        : '';
      setScanResult(`${t('a08.scanDone', { engineVersion: result.engineVersion, findings: result.findings.length })}${sessionNote}`);
    }), [apiBase, candidates, run, scanConfirmation, scanPlan, scanRole]);

  return (
    <div className={styles.section}>
      <Text weight="semibold">{t('a08.hintTitle')}</Text>
      <Text className={styles.muted}>{t('a08.hintIntro')}</Text>
      <Field label={t('a08.hintLabelField')}>
        <Input value={hintLabel} onChange={(_, data) => setHintLabel(data.value)} />
      </Field>
      <Field label={t('a08.hintUrlsField')}>
        <Textarea value={hintUrls} onChange={(_, data) => setHintUrls(data.value)} rows={3} />
      </Field>
      <Button disabled={busy} onClick={() => void registerHints()}>
        {t('a08.hintRegister')}
      </Button>
      {hintNotice !== '' && <Text role="status">{hintNotice}</Text>}
      {hints.length > 0 && (
        <Text className={styles.muted}>{t('a08.hintList', { documents: hints.map((hint) => `${hint.documentLabel} (${hint.urls.length} URL)`).join('・') })}</Text>
      )}
      <Text className={styles.muted}>{t('a08.authHintIntro')}</Text>
      <Field label={t('a08.authHintRoleLabel')}>
        <Input value={authHintRole} onChange={(_, data) => setAuthHintRole(data.value)} />
      </Field>
      <Field label={t('a08.authHintMethodLabel')}>
        <Input value={authHintMethod} onChange={(_, data) => setAuthHintMethod(data.value)} />
      </Field>
      <Field label={t('a08.authHintLocationLabel')}>
        <Input value={authHintLocation} onChange={(_, data) => setAuthHintLocation(data.value)} />
      </Field>
      <Button disabled={busy} onClick={() => void registerAuthHints()}>
        {t('a08.authHintRegister')}
      </Button>
      <Text className={styles.muted}>{t('a08.priorityIntro')}</Text>
      <Field label={t('a08.priorityIncludesLabel')}>
        <Input value={priorityIncludes} onChange={(_, data) => setPriorityIncludes(data.value)} />
      </Field>
      <Field label={t('a08.priorityCategoryLabel')}>
        <Input value={priorityCategory} onChange={(_, data) => setPriorityCategory(data.value)} />
      </Field>
      <Button disabled={busy} onClick={() => void registerPriorityHints()}>
        {t('a08.priorityRegister')}
      </Button>
      {priorityRules.length > 0 && (
        <Text className={styles.muted}>{t('a08.priorityList', { rules: priorityRules.map((rule) => `${rule.urlIncludes} (${rule.category})`).join('・') })}</Text>
      )}
      <Text className={styles.muted}>{t('a08.paramHintIntro')}</Text>
      <Field label={t('a08.paramHintNameLabel')}>
        <Input value={paramHintName} onChange={(_, data) => setParamHintName(data.value)} />
      </Field>
      <Field label={t('a08.paramHintValuesLabel')}>
        <Input value={paramHintValues} onChange={(_, data) => setParamHintValues(data.value)} />
      </Field>
      <Button disabled={busy} onClick={() => void registerParamHints()}>
        {t('a08.paramHintRegister')}
      </Button>
      {paramHints.length > 0 && (
        <Text className={styles.muted}>{t('a08.paramHintList', { entries: paramHints.flatMap((hint) => hint.parameters.map((parameter) => `${parameter.name}: ${parameter.values.join(', ')}`)).join('・') })}</Text>
      )}
      <Text weight="semibold">{t('a08.exploreTitle')}</Text>
      {error !== '' && (
        <MessageBar intent="error">
          {`Error: ${error}`}
        </MessageBar>
      )}
      <Field label={t('a08.seedsLabel')}>
        <Textarea value={seeds} onChange={(_, data) => setSeeds(data.value)} rows={2} />
      </Field>
      <Field label={t('a08.exploreRoleLabel')}>
        <Input value={exploreRole} onChange={(_, data) => setExploreRole(data.value)} />
      </Field>
      <LimitsFields values={exploreLimits} onChange={setExploreLimits} />
      <div className={styles.section}>
        <Button appearance="primary" disabled={busy} onClick={() => void buildExplore()}>
          {t('a08.buildExplore')}
        </Button>
        <Button disabled={busy || explorePlan === null} onClick={() => void confirmExplore()}>
          {t('a08.confirmExplore')}
        </Button>
        <Button disabled={busy || exploreConfirmation === null} onClick={() => void executeExplore()}>
          {t('a08.runExplore')}
        </Button>
      </div>
      {explorePlan !== null && <Text block style={{ whiteSpace: 'pre-wrap' }}>{t('a08.plan', { summary: planSummaryLines(explorePlan.steps, explorePlan.planHash) })}</Text>}
      {exploreConfirmation !== null && <Text>{t('a08.confirmationId', { confirmationId: exploreConfirmation.confirmationId })}</Text>}
      {exploreResult !== '' && <Text>{exploreResult}</Text>}

      <Text weight="semibold">{t('a08.scanTitle')}</Text>
      <Field label={t('a08.targetsLabel')}>
        <Textarea value={targets} onChange={(_, data) => setTargets(data.value)} rows={2} />
      </Field>
      <Field label={t('a08.scanRoleLabel')}>
        <Input value={scanRole} onChange={(_, data) => setScanRole(data.value)} />
      </Field>
      <Text className={styles.muted}>{t('a08.apiSpecIntro')}</Text>
      <Field label={t('a08.apiSpecLabelField')}>
        <Input value={apiSpecLabel} onChange={(_, data) => setApiSpecLabel(data.value)} />
      </Field>
      <Field label={t('a08.apiSpecTextField')}>
        <Textarea value={apiSpecText} onChange={(_, data) => setApiSpecText(data.value)} rows={4} />
      </Field>
      <Button disabled={busy} onClick={() => void importApiSpec()}>
        {t('a08.apiSpecImport')}
      </Button>
      {apiSpecNotice !== '' && <Text role="status">{apiSpecNotice}</Text>}
      <Button disabled={busy || candidates.length === 0} onClick={() => setTargets(candidates.map((candidate) => candidate.url).join('\n'))}>
        {t('a08.adoptAll')}
      </Button>
      <LimitsFields values={scanLimits} onChange={setScanLimits} />
      <div className={styles.section}>
        <Button appearance="primary" disabled={busy} onClick={() => void buildScan()}>
          {t('a08.buildScan')}
        </Button>
        <Button disabled={busy || scanPlan === null} onClick={() => void confirmScan()}>
          {t('a08.confirmScan')}
        </Button>
        <Button disabled={busy || scanConfirmation === null || candidates.length === 0} onClick={() => void executeScan()}>
          {t('a08.runScan')}
        </Button>
      </div>
      {scanPlan !== null && <Text block style={{ whiteSpace: 'pre-wrap' }}>{t('a08.plan', { summary: planSummaryLines(scanPlan.steps, scanPlan.planHash) })}</Text>}
      {scanConfirmation !== null && <Text>{t('a08.confirmationId', { confirmationId: scanConfirmation.confirmationId })}</Text>}
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
  const [traffic, setTraffic] = useState<{ mode: 'list' | 'summary'; total: number; entries?: readonly { exchangeId: string; url: string; method: string; status: number; contentType: string; at: string; source: string }[] } | null>(null);
  const [endpoints, setEndpoints] = useState<readonly { key: string; path: string; method: string; status: number; observedUrls: number }[]>([]);
  // 通信一覧の仮想化 (仕様書 6.5): 一度に描画する窓。50 件ずつ広げる。
  const [trafficWindow, setTrafficWindow] = useState(50);

  useEffect(() => {
    void (async () => {
      try {
        const body = await callJson<{ observations: readonly ObservationView[]; deniedUrls: readonly { url: string; reason: string }[] }>(apiBase, 'GET', '/api/observations');
        setObservations(body.observations);
        setDeniedUrls(body.deniedUrls);
        setLoaded(true);
        const trafficBody = await callJson<{ mode: 'list' | 'summary'; total: number; entries?: readonly { exchangeId: string; url: string; method: string; status: number; contentType: string; at: string; source: string }[] }>(apiBase, 'GET', '/api/traffic?limit=500');
        setTraffic(trafficBody);
        const endpointBody = await callJson<{ endpoints: readonly { key: string; path: string; method: string; status: number; observedUrls: number }[] }>(apiBase, 'GET', '/api/traffic/site-map');
        setEndpoints(endpointBody.endpoints);
      } catch (cause) {
        setError(String(cause));
      }
    })();
  }, [apiBase]);

  const originLabel = (originType: ObservationView['originType']): string =>
    originType === 'crawl' ? t('a04.origin.crawl') : t('a04.origin.documentHint');

  return (
    <div className={styles.section}>
      <Text weight="semibold">{t('a04.pagesTitle', { count: observations.length })}</Text>
      {error !== '' && (
        <MessageBar intent="error">
          {`Error: ${error}`}
        </MessageBar>
      )}
      {observations.length === 0 ? (
        loaded && <Text className={styles.muted}>{t('a04.empty')}</Text>
      ) : (
        <Table size="small" aria-label={t('a04.table.aria')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>URL</TableHeaderCell>
              <TableHeaderCell>status</TableHeaderCell>
              <TableHeaderCell>{t('a04.col.contentType')}</TableHeaderCell>
              <TableHeaderCell>title</TableHeaderCell>
              <TableHeaderCell>{t('a04.col.depth')}</TableHeaderCell>
              <TableHeaderCell>{t('a04.col.discoveredFrom')}</TableHeaderCell>
              <TableHeaderCell>{t('a01.col.source')}</TableHeaderCell>
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
                <TableCell>{observation.discoveredFrom ?? t('a04.seed')}</TableCell>
                <TableCell>{originLabel(observation.originType)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Text weight="semibold">{t('a04.deniedTitle', { count: deniedUrls.length })}</Text>
      {deniedUrls.length === 0 ? (
        <Text className={styles.muted}>{t('a04.deniedEmpty')}</Text>
      ) : (
        deniedUrls.map((denied) => (
          <Text key={denied.url} block>
            {t('a04.deniedLine', { url: denied.url, reason: denied.reason })}
          </Text>
        ))
      )}
      <Text weight="semibold">{t('a04.trafficTitle', { count: traffic?.total ?? 0 })}</Text>
      {traffic === null ? (
        <Text className={styles.muted}>{t('common.loading')}</Text>
      ) : traffic.mode === 'summary' ? (
        <Text className={styles.muted}>{t('a04.trafficSummary', { total: traffic.total })}</Text>
      ) : (traffic.entries ?? []).length === 0 ? (
        <Text className={styles.muted}>{t('a04.trafficEmpty')}</Text>
      ) : (
        <div className={styles.section}>
          {(traffic.entries ?? []).slice(0, trafficWindow).map((entry) => (
            <Text key={entry.exchangeId} block>
              {t('a04.trafficLine', { method: entry.method, url: entry.url, status: String(entry.status), contentType: entry.contentType.split(';')[0], source: entry.source })}
            </Text>
          ))}
          {(traffic.entries ?? []).length > trafficWindow ? (
            <Button size="small" onClick={() => setTrafficWindow((current) => current + 50)}>
              {t('a04.trafficShowMore', { count: Math.min(50, (traffic.entries ?? []).length - trafficWindow) })}
            </Button>
          ) : null}
          {traffic.total > (traffic.entries ?? []).length ? (
            <Text className={styles.muted}>{t('a04.trafficBeyond', { count: traffic.total - (traffic.entries ?? []).length })}</Text>
          ) : null}
        </div>
      )}
      <Text weight="semibold">{t('a04.endpointsTitle', { count: endpoints.length })}</Text>
      {endpoints.length === 0 ? (
        <Text className={styles.muted}>{t('a04.endpointsEmpty')}</Text>
      ) : (
        <div className={styles.section}>
          {endpoints.slice(0, 15).map((endpoint) => (
            <Text key={endpoint.key} block>
              {t('a04.endpointLine', { method: endpoint.method, path: endpoint.path, status: String(endpoint.status), urls: endpoint.observedUrls })}
            </Text>
          ))}
        </div>
      )}
    </div>
  );
}

export function AdvancedApp({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [groups] = useState<readonly AdvancedNavGroup[]>(() => advancedNavGroups(OPERATOR_PERMISSIONS));
  const [activeRoute, setActiveRoute] = useState<AdvancedRoute>(() => advancedDefaultRoute(OPERATOR_PERMISSIONS) ?? 'adv.case.overview');
  const items = groups.flatMap((group) => group.items);
  /** 旧 route (保存済み状態・外部参照) も受け取り、新 route へ写像して開く (design/40 §7.3)。権限外・未知は無視。 */
  const openRoute = useCallback(
    (route: string) => {
      const next = normalizeRoute(route);
      const visible = groups.flatMap((group) => group.items).find((item) => item.route === next);
      if (visible !== undefined) {
        setActiveRoute(visible.route);
      }
    },
    [groups],
  );
  const [caseRecord, setCaseRecord] = useState<CaseRecord | null>(null);
  const [caseMissing, setCaseMissing] = useState(false);
  const [capabilities, setCapabilities] = useState<readonly EngineCapabilitySnapshot[]>([]);
  const [interrupted, setInterrupted] = useState<readonly RunRecord[]>([]);
  const [events, setEvents] = useState<readonly AuditEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newCaseOrigin, setNewCaseOrigin] = useState('');

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
      const origin = new URL(newCaseOrigin).origin;
      const now = Date.now();
      await callJson(apiBase, 'POST', '/api/case', {
        name: 'ScopePilot2 案件',
        allowedOrigins: [origin],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      });
      await callJson(apiBase, 'POST', '/api/authorization', {
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['unauthenticated'],
        validFrom: new Date(now - 60_000).toISOString(),
        validUntil: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
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
  }, [apiBase, newCaseOrigin, refreshAudit, refreshCase]);

  // アクティビティパネルの状態管理
  const activityPanel = useActivityPanel({
    apiBase,
    currentRunId: undefined, // TODO: 現在の画面のジョブ/runId を渡す
  });

  const handleEventClick = useCallback((event: import('@scopepilot2/ui').ActivityEvent) => {
    // TODO: イベントの詳細を表示する (P0 後に実装)
    console.log('Event clicked:', event);
  }, []);

  const handleJobClick = useCallback((jobId: string) => {
    // TODO: ジョブ詳細画面 (A70) へ遷移
    console.log('Job clicked:', jobId);
  }, []);

  const activeItem = items.find((item) => item.route === activeRoute);
  const host = SCREEN_HOSTS[activeRoute];
  return (
    <div className={styles.root}>
      <nav className={styles.nav} aria-label={t('nav.aria')}>
        <div className={styles.navHeader}>
          <span className={styles.navEyebrow}>{t('app.mode.advanced')}</span>
          <Text size={400} weight="semibold">{t('advanced.workspace')}</Text>
          <Text size={200} className={styles.muted}>{t('advanced.workspaceHint')}</Text>
        </div>
        {groups.map((group) => (
          <div
            key={group.groupId}
            role="group"
            aria-labelledby={`adv-nav-group-${group.groupId}`}
            className={group.placement === 'footer' ? `${styles.navGroup} ${styles.navFooter}` : styles.navGroup}
          >
            <span id={`adv-nav-group-${group.groupId}`} className={styles.navGroupLabel}>
              {group.label}
            </span>
            {group.items.map((item) => {
              const egressTitle = item.egress === 'sends' ? t('nav.egress') : item.egress === 'live' ? t('nav.egressLive') : undefined;
              return (
                <button
                  key={item.screenId}
                  type="button"
                  title={egressTitle}
                  aria-current={item.route === activeRoute ? 'page' : undefined}
                  className={item.route === activeRoute ? `${styles.navItem} ${styles.navActive}` : styles.navItem}
                  onClick={() => openRoute(item.route)}
                >
                  {item.screenId} {item.label}
                  {egressTitle !== undefined && (
                    <span className={styles.navEgress} aria-hidden="true">
                      {'\u21C5'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className={styles.content}>
        <header className={styles.contentHeader}>
          <span className={styles.navEyebrow}>{activeItem?.screenId ?? ''}</span>
          <Text as="h1" size={600} weight="semibold">
            {activeItem?.label ?? ''}
          </Text>
        </header>
        {error !== '' && (
          <MessageBar intent="error">
            {`Error: ${error}`}
          </MessageBar>
        )}
        {host === 'dashboard' && (
          <>
            <div className={styles.section}>
              <Text weight="semibold">{t('a01.caseTitle')}</Text>
              {caseRecord !== null ? (
                <>
                  <Text>{t('a01.caseRecord', { name: caseRecord.name, revision: caseRecord.revision })}</Text>
                  <Text className={styles.muted}>{t('a01.allowedOrigins', { origins: caseRecord.scope.allowedOrigins.join(', ') })}</Text>
                  <Text className={styles.muted}>{t('a01.limits', { maxRequests: caseRecord.scope.limits.maxRequests, maxPages: caseRecord.scope.limits.maxPages, maxDurationMinutes: caseRecord.scope.limits.maxDurationMinutes })}</Text>
                </>
              ) : caseMissing ? (
                <>
                  <Text>{t('a01.caseMissing')}</Text>
                  <Field label={t('wizard.s01.allowedOrigins')} required>
                    <Input value={newCaseOrigin} onChange={(_event, data) => setNewCaseOrigin(data.value)} placeholder="https://target.example" />
                  </Field>
                  <Button disabled={busy || newCaseOrigin.trim() === ''} onClick={() => void createCase()}>
                    {t('a01.createCase')}
                  </Button>
                </>
              ) : (
                <Text>{t('common.loading')}</Text>
              )}
            </div>
            <div className={styles.section}>
              <Text weight="semibold">{t('a01.capabilitiesTitle')}</Text>
              <Table size="small" aria-label={t('a01.capabilitiesTable.aria')}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>engine</TableHeaderCell>
                    <TableHeaderCell>{t('common.col.version')}</TableHeaderCell>
                    <TableHeaderCell>{t('a01.col.source')}</TableHeaderCell>
                    {CONTROL_ASPECTS.map((aspect) => (
                      <TableHeaderCell key={aspect} title={aspect}>
                        <span className={styles.tableHeaderLabel}>{CONTROL_ASPECT_LABELS[aspect]}</span>
                      </TableHeaderCell>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {capabilities.map((cap) => (
                    <TableRow key={`${cap.engineKind}-${cap.engineVersion}`}>
                      <TableCell>{cap.engineKind}</TableCell>
                      <TableCell>{cap.engineVersion}</TableCell>
                      <TableCell>
                        {cap.source === 'fixture' ? t('a01.sourceFixture') : 'measured'}
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
              <Text weight="semibold">{t('a01.interruptedTitle')}</Text>
              {interrupted.length === 0 ? (
                <Text className={styles.muted}>{t('a01.interruptedNone')}</Text>
              ) : (
                interrupted.map((run) => (
                  <Badge key={run.runId} appearance="ghost">{`${run.runId}: ${run.state} (${run.stopReason ?? 'unknown'})`}</Badge>
                ))
              )}
            </div>
          </>
        )}
        {host === 'audit' && (
          <div className={styles.section}>
            <Text weight="semibold">{t('audit.title', { count: events.length })}</Text>
            {events.length === 0 ? (
              <Text className={styles.muted}>{t('audit.empty')}</Text>
            ) : (
              events.map((event) => (
                <Text key={event.eventId} block>
                  {t('audit.line', { eventId: event.eventId, type: event.type, at: event.at })}
                </Text>
              ))
            )}
          </div>
        )}
        {host === 'scope' && <ScopeAuthorizationScreen apiBase={apiBase} />}
        {host === 'findings' && <FindingsOrganizerScreen apiBase={apiBase} />}
        {host === 'scanPlans' && <ScanPlansScreen apiBase={apiBase} />}
        {host === 'siteMap' && <SiteMapScreen apiBase={apiBase} />}
        {host === 'guidelines' && <GuidelinesCatalogScreen apiBase={apiBase} />}
        {host === 'proxy' && <ProxyInterceptScreen apiBase={apiBase} />}
        {host === 'repeater' && <RepeaterScreen apiBase={apiBase} />}
        {host === 'fuzzer' && <FuzzerScreen apiBase={apiBase} />}
        {host === 'sessions' && <SessionsScreen apiBase={apiBase} />}
        {host === 'decoder' && <DecoderComparerScreen apiBase={apiBase} />}
        {host === 'decoderOnly' && <DecoderScreen apiBase={apiBase} />}
        {host === 'comparerOnly' && <ComparerScreen apiBase={apiBase} />}
        {host === 'sequencerOnly' && <DecoderComparerScreen apiBase={apiBase} sequencerOnly />}
        {host === 'settings' && <SettingsScreen apiBase={apiBase} />}
        {host === undefined && <Text className={styles.muted}>{t('nav.pendingScreen')}</Text>}
      </div>
      <ActivityPanel
        events={activityPanel.events}
        jobs={activityPanel.jobs}
        filter={activityPanel.filter}
        onFilterChange={activityPanel.setFilter}
        collapsed={activityPanel.collapsed}
        onCollapsedChange={activityPanel.setCollapsed}
        onEventClick={handleEventClick}
        onJobClick={handleJobClick}
      />
    </div>
  );
}
