/**
 * Simple wizard 画面 (S01〜S07)。`docs/detailed-design/02-ui-information-architecture.md` §2。
 * S02 はガイドライン選択のみ、S03 の crawl 上限は表示専用。進行は wizard-state の判定のみを使う。
 * S04〜S07 は対象選定、最終確認、診断実行、結果・報告へ接続する。
 */
import type { ScanStateProjection } from '@scopepilot2/contracts';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  Field,
  Input,
  MessageBar,
  ProgressBar,
  Select,
  Switch,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { t } from './resources.ts';
import { parseHttpOriginInput } from './origin-input.ts';
import {
  INITIAL_RENDERER_REPORT_PROFILE,
  normalizeRendererReportProfile,
  type RendererReportProfile,
} from './report-profile.ts';
import type { AiCatalogSnapshot, AiCliProvider, AiProviderCatalog, AppAiSelection } from '../shared/runtime-settings.ts';
import {
  advance,
  goBack,
  initialWizardData,
  STEP_LABELS,
  WIZARD_STEPS,
  type WizardData,
  type WizardStep,
} from '@scopepilot2/ui';

/** catalog のガイドラインと、国内指針を束ねた運用プロファイル。 */
const GUIDELINES: readonly string[] = [
  'OWASP Top 10-2025',
  'OWASP ASVS 5.0',
  'OWASP WSTG 4.2',
  'OWASP AISVS 1.01',
  'OWASP CNAS Top 10',
  'デジタル庁 DS-221',
  'IPA/NISC/WebAppPentestGuidelines',
];



const useStyles = makeStyles({
  root: {
    display: 'grid',
    gridTemplateColumns: '264px minmax(0, 1fr)',
    flex: 1,
    minHeight: 0,
    color: tokens.colorNeutralForeground1,
  },
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    padding: '24px 16px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  sidebarHeading: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '0 8px' },
  eyebrow: {
    color: tokens.colorBrandForeground1,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  steps: { display: 'flex', flexDirection: 'column', gap: '4px' },
  stepBadge: {
    display: 'grid',
    gridTemplateColumns: '28px minmax(0, 1fr)',
    alignItems: 'center',
    gap: '10px',
    minHeight: '44px',
    padding: '6px 10px',
    borderRadius: '6px',
    color: tokens.colorNeutralForeground2,
    border: '1px solid transparent',
  },
  stepActive: {
    color: tokens.colorNeutralForeground1,
    fontWeight: 600,
    backgroundColor: tokens.colorBrandBackground2,
    borderColor: tokens.colorBrandStroke2,
  },
  stepComplete: { color: tokens.colorNeutralForeground1 },
  stepNumber: {
    display: 'grid',
    width: '24px',
    height: '24px',
    placeItems: 'center',
    borderRadius: '50%',
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground3,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  stepNumberActive: {
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundColor: tokens.colorBrandBackground,
  },
  sidebarNote: {
    marginTop: 'auto',
    padding: '12px',
    borderRadius: '8px',
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  main: {
    display: 'flex',
    minWidth: 0,
    flexDirection: 'column',
    gap: '20px',
    padding: '32px clamp(24px, 5vw, 64px) 48px',
  },
  pageHeader: { display: 'flex', flexDirection: 'column', gap: '6px', maxWidth: '920px' },
  surface: {
    display: 'flex',
    width: '100%',
    maxWidth: '1040px',
    minHeight: '360px',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: '10px',
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
  },
  busyBar: { flexShrink: 0 },
  content: { display: 'flex', flex: 1, flexDirection: 'column', gap: '14px', padding: '24px' },
  choiceList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '8px',
    borderRadius: '8px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  pathCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '16px',
    borderRadius: '8px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  pathRow: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
  },
  pathDetails: { display: 'flex', minWidth: 0, flex: 1, flexDirection: 'column', gap: '2px' },
  pathValue: {
    overflow: 'hidden',
    color: tokens.colorNeutralForeground3,
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  inlineActions: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  fileList: { display: 'flex', flexDirection: 'column', gap: '4px' },
  fileRow: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '8px 10px',
    borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground3,
  },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '14px 18px',
  },
  fullField: { gridColumn: '1 / -1' },
  actions: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'space-between',
    padding: '16px 24px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  hint: { color: tokens.colorNeutralForeground3 },
  report: {
    margin: 0,
    padding: '16px',
    overflowX: 'auto',
    whiteSpace: 'pre-wrap',
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '8px',
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
  },
  reviewToolbar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  reviewSearch: { minWidth: '240px', flex: 1 },
  summaryRow: { display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
  candidateList: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  candidateRow: {
    display: 'grid',
    gridTemplateColumns: '32px minmax(0, 1fr) auto',
    gap: '12px',
    alignItems: 'start',
    padding: '12px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    ':last-child': { borderBottom: 'none' },
  },
  candidateBody: { display: 'flex', minWidth: 0, flexDirection: 'column', gap: '4px' },
  candidateUrl: { overflowWrap: 'anywhere', fontFamily: 'Cascadia Mono, Consolas, monospace' },
  candidateMeta: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '22px',
    padding: '0 8px',
    borderRadius: '999px',
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: tokens.fontSizeBase200,
  },
  dynamicBadge: {
    color: tokens.colorPaletteGreenForeground1,
    backgroundColor: tokens.colorPaletteGreenBackground1,
    borderColor: tokens.colorPaletteGreenBorder1,
  },
  planGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '16px',
    borderRadius: '8px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  planTargets: { display: 'flex', flexDirection: 'column', gap: '6px' },
  planTarget: {
    display: 'grid',
    gridTemplateColumns: '72px minmax(0, 1fr)',
    gap: '10px',
    padding: '8px 10px',
    borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  consolePanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '14px',
    borderRadius: '8px',
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  command: {
    margin: 0,
    padding: '10px 12px',
    overflowX: 'auto',
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: '6px',
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    whiteSpace: 'pre-wrap',
  },
  executionLog: {
    minHeight: '180px',
    maxHeight: '360px',
    margin: 0,
    padding: '12px',
    overflow: 'auto',
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: '6px',
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
  },
  '@media (max-width: 900px)': {
    root: { gridTemplateColumns: '1fr' },
    sidebar: { borderRight: 'none', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
    steps: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(40px, 1fr))' },
    stepBadge: { display: 'flex', justifyContent: 'center', padding: '4px' },
    stepLabel: { display: 'none' },
    sidebarNote: { display: 'none' },
    main: { padding: '24px 16px 32px' },
    pathRow: { alignItems: 'flex-start', flexDirection: 'column' },
    formGrid: { gridTemplateColumns: '1fr' },
    fullField: { gridColumn: 'auto' },
  },
});

interface SelectedDesktopPath {
  readonly path: string;
  readonly name: string;
  readonly inputId?: string;
  readonly relativePath?: string;
}

interface ScanCandidateView {
  readonly candidateId: string;
  readonly url: string;
  readonly method: string;
  readonly category: string;
  readonly guidelineBasis: readonly string[];
  readonly confidence: number;
  readonly observationUrl: string;
  readonly detectionReason?: string;
  readonly dynamic?: boolean;
  readonly inputPoints?: readonly { readonly name: string; readonly location: string; readonly type: string }[];
  readonly requestId?: string;
  readonly contentType?: string;
  readonly diagnosticTracks?: readonly string[];
}

interface ScanPlanStepView {
  readonly stepId: string;
  readonly kind: 'active-scan' | 'workflow-scan' | 'nuclei-scan' | 'explore' | 'report';
  readonly engineKind: 'zap' | 'nuclei' | 'playwright' | 'node-http' | 'oast';
  readonly engineVersion?: string;
  readonly guarantee: 'Enforced' | 'Delegated' | 'Unsupported';
  readonly targetSnapshot: readonly string[];
  readonly limits: { readonly maxRequests: number; readonly maxConcurrency: number; readonly requestsPerSecond: number; readonly maxDurationMinutes: number };
}

interface ScanPlanView {
  readonly plan: {
    readonly steps: readonly ScanPlanStepView[];
    readonly limits: { readonly maxRequests: number };
  };
}

interface ScanRunResultView {
  readonly findings: readonly { findingId: string; title: string; severity: string; url: string; occurrences: number; source: { unverified: boolean; engineVersion?: string } }[];
  readonly engineVersion: string;
  readonly overshootReservation: number;
  readonly requestCorpusEvidenceRef?: string;
  readonly diagnosticRoutes?: readonly {
    readonly track: string;
    readonly targetUrl: string;
    readonly candidateCount: number;
    readonly status: 'delegated' | 'executed' | 'needs-input' | 'unavailable';
    readonly detail: string;
    readonly findingCount?: number;
  }[];
  readonly guidelineRoutes?: readonly {
    readonly routeId: string;
    readonly themeNo: string;
    readonly guidelineIds: readonly string[];
    readonly status: 'delegated' | 'executed' | 'needs-input' | 'unavailable';
    readonly detail: string;
    readonly checkId?: string;
    readonly checkStatus?: 'pass' | 'fail' | 'inconclusive';
  }[];
  readonly workflow?: {
    readonly status: 'completed' | 'failed';
    readonly payloadSet: string;
    readonly baseUrls: readonly string[];
    readonly requestCount: number;
    readonly checkKindCount: number;
    readonly checkCount: number;
    readonly skipCount: number;
    readonly importedCount: number;
    readonly duplicateCount: number;
    readonly evidenceRefs: readonly string[];
    readonly error?: string;
  };
  readonly nuclei?: { status: 'completed' | 'failed'; engineVersion: string; templateBundleHash?: string; importedCount: number; duplicateCount: number; quarantinedCount: number; excludedOutOfScope: number; error?: string };
  readonly payloadVerifications?: readonly {
    readonly findingId: string;
    readonly title: string;
    readonly url: string;
    readonly executed: boolean;
    readonly signals: readonly string[];
    readonly evidenceRef?: string;
    readonly error?: string;
  }[];
}

interface ScanExecutionView extends ScanStateProjection {
  readonly executionId: string;
  readonly currentEngine: 'zap' | 'nuclei' | 'scopepilot';
  readonly currentCommand: string;
  readonly progress: number;
  readonly logs: readonly string[];
  readonly result?: ScanRunResultView;
  readonly error?: string;
}

type InteractiveDiagnosticPlan = Awaited<ReturnType<NonNullable<Window['scopepilotDesktop']>['planInteractiveDiagnostics']>>;
type InteractiveUploadInput = { readonly kind: 'upload-file'; readonly inputRef: 'upload-file'; readonly name: string; readonly mimeType: string; readonly dataBase64: string };
type InteractiveApiInput = { readonly kind: 'api-spec'; readonly inputRef: 'api-spec'; readonly name: string; readonly document: unknown };
interface InteractiveDiagnosticResult {
  readonly itemId: string;
  readonly track: string;
  readonly targetUrl: string;
  readonly status: 'completed' | 'passed' | 'failed' | 'inconclusive';
  readonly detail: string;
  readonly evidenceId?: string;
}

function isDynamicCandidate(candidate: ScanCandidateView): boolean {
  if (candidateSafetyExclusion(candidate) !== undefined) return false;
  if (candidate.dynamic !== undefined) return candidate.dynamic;
  if (candidate.category !== 'page' || candidate.method.toUpperCase() !== 'GET') return true;
  try {
    return new URL(candidate.url).search !== '';
  } catch {
    return false;
  }
}

function candidateSafetyExclusion(candidate: ScanCandidateView): string | undefined {
  try {
    const pathname = new URL(candidate.url).pathname.toLowerCase();
    if (/\/(?:logout|log-out|logoff|signout|sign-out)(?:\.php)?\/?$/.test(pathname)) {
      return t('wizard.s04.sessionEndingExcluded');
    }
    if (/\/(?:setup|install)(?:\.php)?\/?$/.test(pathname)) {
      return t('wizard.s04.setupExcluded');
    }
    return undefined;
  } catch {
    return t('wizard.s04.invalidUrlExcluded');
  }
}

function candidateReason(candidate: ScanCandidateView): string {
  if (candidate.detectionReason !== undefined && candidate.detectionReason !== '') return candidate.detectionReason;
  if (candidate.category === 'form') return `${candidate.observationUrl} で入力フォームを検出`;
  if (candidate.category === 'api-endpoint') return `${candidate.observationUrl} からAPIエンドポイントを検出`;
  return `${candidate.observationUrl} のページ遷移として検出`;
}

function planInspectionLabel(step: ScanPlanStepView): string {
  if (step.engineKind === 'zap') return t('wizard.s05.zapInspection');
  if (step.engineKind === 'nuclei') return t('wizard.s05.nucleiInspection');
  if (step.kind === 'workflow-scan') return t('wizard.s05.workflowInspection');
  return step.kind;
}

async function waitFor(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type ActivatedDesktopWorkspace = Awaited<ReturnType<NonNullable<Window['scopepilotDesktop']>['activateCaseWorkspace']>>;
type ReportProfileState = RendererReportProfile;

async function callApi<T>(apiBase: string, method: string, path: string, body?: unknown): Promise<T> {
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

export function WizardApp({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [step, setStep] = useState<WizardStep>('S01');
  const [data, setData] = useState<WizardData>(initialWizardData);
  const [caseName, setCaseName] = useState<string>('');
  const [caseRevision, setCaseRevision] = useState<number | null>(null);
  const [caseDirectory, setCaseDirectory] = useState<SelectedDesktopPath | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<'create' | 'open'>('create');
  const [materialFiles, setMaterialFiles] = useState<readonly SelectedDesktopPath[]>([]);
  const [startUrl, setStartUrl] = useState('');
  const [allowedOrigins, setAllowedOrigins] = useState('');
  const [supportingOrigins, setSupportingOrigins] = useState('');
  const [targetRoles, setTargetRoles] = useState('unauthenticated');
  const [forbiddenActions, setForbiddenActions] = useState('削除\n購入・決済\n認証情報の変更\n設定変更');
  const [aiProvider, setAiProvider] = useState<'zcode' | 'codex' | 'claude'>('codex');
  const [aiModel, setAiModel] = useState('');
  const [aiCatalog, setAiCatalog] = useState<AiCatalogSnapshot | null>(null);
  const [aiCatalogLoading, setAiCatalogLoading] = useState(true);
  const [aiCatalogRevision, setAiCatalogRevision] = useState(0);
  const [exploreSummary, setExploreSummary] = useState<string>('');
  const [candidates, setCandidates] = useState<readonly ScanCandidateView[]>([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<readonly string[]>([]);
  const [candidateSearch, setCandidateSearch] = useState('');
  const [candidateFilter, setCandidateFilter] = useState<'all' | 'selected' | 'unselected'>('all');
  const [adoptedCandidates, setAdoptedCandidates] = useState<readonly ScanCandidateView[]>([]);
  const [scanPlan, setScanPlan] = useState<ScanPlanView | null>(null);
  const [scanConfirmation, setScanConfirmation] = useState<{ confirmationId: string } | null>(null);
  const [scanExecution, setScanExecution] = useState<ScanExecutionView | null>(null);
  const [runSummary, setRunSummary] = useState('');
  const [findings, setFindings] = useState<readonly { findingId: string; title: string; severity: string; url: string; occurrences: number; source: { unverified: boolean; engineVersion?: string } }[]>([]);
  const [excludeLowAndInfo, setExcludeLowAndInfo] = useState(false);
  const [nucleiEnabled, setNucleiEnabled] = useState(false);
  const [interactiveInstruction, setInteractiveInstruction] = useState('');
  const [interactivePlan, setInteractivePlan] = useState<InteractiveDiagnosticPlan | null>(null);
  const [interactivePlanConfirmed, setInteractivePlanConfirmed] = useState(false);
  const [interactiveUpload, setInteractiveUpload] = useState<InteractiveUploadInput | null>(null);
  const [interactiveApiSpec, setInteractiveApiSpec] = useState<InteractiveApiInput | null>(null);
  const [interactiveResults, setInteractiveResults] = useState<readonly InteractiveDiagnosticResult[]>([]);
  const [interactiveStatus, setInteractiveStatus] = useState('');
  const [reportContent, setReportContent] = useState('');
  const [reportFiles, setReportFiles] = useState<{
    markdownPath: string;
    wordPath: string;
    technicalAnnexHtmlPath: string;
    structuredJsonPath: string;
    manifestPath: string;
  } | null>(null);
  const [reportProfile, setReportProfile] = useState<ReportProfileState>(INITIAL_RENDERER_REPORT_PROFILE);
  const [analysisStatus, setAnalysisStatus] = useState('');
  const [settingsStatus, setSettingsStatus] = useState('');
  const [credentialEditorOpen, setCredentialEditorOpen] = useState(false);
  const [authRole, setAuthRole] = useState('member');
  const [authLoginUrl, setAuthLoginUrl] = useState('');
  const [authExpectedUrlPrefix, setAuthExpectedUrlPrefix] = useState('');
  const [authUsernameSelector, setAuthUsernameSelector] = useState('');
  const [authPasswordSelector, setAuthPasswordSelector] = useState('');
  const [authSubmitSelector, setAuthSubmitSelector] = useState('');
  const [authSuccessMarker, setAuthSuccessMarker] = useState('');
  const [postLoginSetupEnabled, setPostLoginSetupEnabled] = useState(false);
  const [postLoginInstruction, setPostLoginInstruction] = useState('');
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authenticatedRole, setAuthenticatedRole] = useState('');
  const [authStatus, setAuthStatus] = useState('');
  const [reportAiStatus, setReportAiStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const explorationInFlight = useRef(false);

  const progress = useMemo(() => (WIZARD_STEPS.indexOf(step) + 1) / WIZARD_STEPS.length, [step]);
  const visibleFindings = useMemo(
    () => excludeLowAndInfo ? findings.filter((finding) => !['low', 'info'].includes(finding.severity.toLocaleLowerCase())) : findings,
    [excludeLowAndInfo, findings],
  );
  const stepIndex = WIZARD_STEPS.indexOf(step);
  const selectedAiCatalog = useMemo(
    () => aiCatalog?.providers.find((provider) => provider.provider === aiProvider),
    [aiCatalog, aiProvider],
  );
  const filteredCandidates = useMemo(() => {
    const query = candidateSearch.trim().toLocaleLowerCase();
    return candidates.filter((candidate) => {
      const selected = selectedCandidateIds.includes(candidate.candidateId);
      if (candidateFilter === 'selected' && !selected) return false;
      if (candidateFilter === 'unselected' && selected) return false;
      if (query === '') return true;
      return `${candidate.method} ${candidate.url} ${candidate.category} ${candidateReason(candidate)} ${candidate.guidelineBasis.join(' ')}`
        .toLocaleLowerCase()
        .includes(query);
    });
  }, [candidateFilter, candidateSearch, candidates, selectedCandidateIds]);
  const interactiveCandidates = useMemo(() => {
    const deferred = new Set(['workflow-state', 'session-analysis', 'authorization-differential', 'upload-workflow', 'api-schema', 'cryptography-review']);
    return adoptedCandidates.filter((candidate) => candidate.diagnosticTracks?.some((track) => deferred.has(track)) === true);
  }, [adoptedCandidates]);
  const workflowScanEligible = useMemo(() => adoptedCandidates.some((candidate) => {
    try {
      return ['http:', 'https:'].includes(new URL(candidate.url).protocol);
    } catch {
      return false;
    }
  }), [adoptedCandidates]);
  const workflowPlanStep = useMemo(
    () => scanPlan?.plan.steps.find((candidate) => candidate.kind === 'workflow-scan') ?? null,
    [scanPlan],
  );

  const defaultModel = useCallback((provider: AiProviderCatalog): string =>
    provider.models.find((model) => model.isDefault)?.id ?? provider.models[0]?.id ?? '', []);

  const persistAiSelection = useCallback((selection: AppAiSelection): void => {
    void window.scopepilotDesktop?.saveAiSelection(selection).catch((cause: unknown) => setError(String(cause)));
  }, []);

  useEffect(() => {
    const bridge = window.scopepilotDesktop;
    setAiCatalogLoading(true);
    if (bridge === undefined) {
      setAiCatalogLoading(false);
      return;
    }
    bridge.getAiCatalog().then((catalog) => {
      setAiCatalog(catalog);
      const preferred = catalog.providers.find((provider) => provider.provider === catalog.selection.provider);
      const provider = preferred ?? catalog.providers[0];
      if (provider === undefined) return;
      const model = provider.models.some((candidate) => candidate.id === catalog.selection.model)
        ? catalog.selection.model
        : defaultModel(provider);
      setAiProvider(provider.provider);
      setAiModel(model);
    }).catch((cause: unknown) => setError(String(cause))).finally(() => setAiCatalogLoading(false));
  }, [aiCatalogRevision, defaultModel]);

  const completeWorkspaceActivation = useCallback(async (
    activated: ActivatedDesktopWorkspace,
    mode: 'create' | 'open',
    fallbackAllowedOrigins: readonly string[],
  ): Promise<void> => {
    setMaterialFiles(activated.inputs);
    const effective = activated.settings;
    const effectiveAllowed = activated.existingCase?.scope.allowedOrigins ?? fallbackAllowedOrigins;
    const effectiveStart = new URL(effective.startUrl);
    if (!['http:', 'https:'].includes(effectiveStart.protocol)) throw new Error(t('wizard.s01.startUrlInvalid'));
    if (effectiveAllowed.length === 0) throw new Error(t('wizard.s01.allowedOriginsRequired'));
    if (!effectiveAllowed.includes(effectiveStart.origin)) throw new Error(t('wizard.s01.startOriginRequired', { origin: effectiveStart.origin }));
    setStartUrl(effective.startUrl);
    setAllowedOrigins(effectiveAllowed.join('\n'));
    setSupportingOrigins(effective.supportingOrigins.join('\n'));
    setTargetRoles(effective.targetRoles.join('\n'));
    setForbiddenActions(effective.forbiddenActions.join('\n'));
    setAiProvider(effective.aiProvider);
    setAiModel(effective.aiModel);
    setReportProfile(normalizeRendererReportProfile(activated.reportProfile));
    if (mode === 'open' && activated.existingCase === null) throw new Error(t('wizard.s01.existingCaseRequired'));
    const record = activated.existingCase ?? await callApi<{ name: string; revision: number }>(apiBase, 'POST', '/api/case', {
      name: activated.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? activated.directory,
      allowedOrigins: effectiveAllowed,
      deniedOrigins: [],
      limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
    });
    const now = Date.now();
    await callApi(apiBase, 'POST', '/api/authorization', {
      allowedOperationClasses: ['Browse', 'FormSubmit', 'Upload', 'ActiveScan', 'ApiSend', 'NucleiScan', 'CrossRoleTest'],
      targetRoles: effective.targetRoles.length === 0 ? ['unauthenticated'] : effective.targetRoles,
      validFrom: new Date(now - 60_000).toISOString(),
      validUntil: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
      evidenceLabel: '案件資料に基づく認可 (デスクトップ)',
      evidenceContent: JSON.stringify({ inputHashes: activated.inputs.map((input) => input.sha256) }),
    });
    setCaseName(record.name);
    setCaseRevision(record.revision);
    setAuthRole(effective.targetRoles.find((role) => role !== 'unauthenticated') ?? effective.targetRoles[0] ?? 'member');
    setAuthLoginUrl(effective.startUrl);
    setAuthExpectedUrlPrefix(new URL(effective.startUrl).origin);
    setAuthUsernameSelector('');
    setAuthPasswordSelector('');
    setAuthSubmitSelector('');
    setAuthSuccessMarker('');
    setData((current) => ({ ...current, caseOpened: true }));
  }, [apiBase]);

  const selectCaseDirectory = useCallback(async (mode: 'create' | 'open') => {
    setBusy(true);
    setError('');
    try {
      const selection = await window.scopepilotDesktop?.selectCaseDirectory(mode);
      if (selection === undefined) {
        throw new Error(t('wizard.s01.bridgeMissing'));
      }
      if (selection !== null) {
        setWorkspaceMode(mode);
        setCaseDirectory(selection);
        setMaterialFiles([]);
        setCaseName('');
        setCaseRevision(null);
        setCandidates([]);
        setSelectedCandidateIds([]);
        setCandidateSearch('');
        setCandidateFilter('all');
        setAdoptedCandidates([]);
        setScanPlan(null);
        setNucleiEnabled(false);
        setScanConfirmation(null);
        setScanExecution(null);
        setInteractivePlan(null);
        setInteractivePlanConfirmed(false);
        setInteractiveUpload(null);
        setInteractiveApiSpec(null);
        setInteractiveResults([]);
        setInteractiveStatus('');
        setAnalysisStatus('');
        setSettingsStatus('');
        setAuthenticatedRole('');
        setAuthStatus('');
        setAuthUsernameSelector('');
        setAuthPasswordSelector('');
        setAuthSubmitSelector('');
        setAuthSuccessMarker('');
        setData((current) => ({ ...current, caseOpened: false }));
        if (mode === 'open') {
          const bridge = window.scopepilotDesktop;
          if (bridge === undefined) throw new Error(t('wizard.s01.bridgeMissing'));
          // フォルダー選択を「案件を開いた」操作として完結させる。既存資料を先に
          // 表示することで、同じ資料を未登録と誤認して再追加することを防ぐ。
          const activated = await bridge.activateCaseWorkspace({
            directory: selection.path,
            mode,
            materialPaths: [],
            settings: {
              startUrl: '',
              supportingOrigins: [],
              targetRoles: [],
              forbiddenActions: [],
              aiProvider,
              aiModel,
            },
          });
          await completeWorkspaceActivation(activated, mode, []);
        }
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [aiModel, aiProvider, completeWorkspaceActivation]);

  const selectMaterialFiles = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const selections = await window.scopepilotDesktop?.selectMaterialFiles();
      if (selections === undefined) {
        throw new Error(t('wizard.s01.bridgeMissing'));
      }
      if (data.caseOpened) {
        const imported = await window.scopepilotDesktop?.importCaseInputs(selections.map((selection) => selection.path));
        if (imported === undefined) throw new Error(t('wizard.s01.bridgeMissing'));
        setMaterialFiles(imported);
        setAnalysisStatus('');
        return;
      }
      setMaterialFiles((current) => {
        const byPath = new Map(current.map((entry) => [entry.path, entry]));
        for (const selection of selections) {
          byPath.set(selection.path, selection);
        }
        return [...byPath.values()];
      });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [data.caseOpened]);

  const openSelectedPath = useCallback(async (path: string) => {
    setError('');
    try {
      const opened = window.scopepilotDesktop?.openSelectedPath(path);
      if (opened === undefined) {
        throw new Error(t('wizard.s01.bridgeMissing'));
      }
      await opened;
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  const removeMaterial = useCallback(async (file: SelectedDesktopPath) => {
    setBusy(true);
    setError('');
    try {
      if (!data.caseOpened || file.inputId === undefined) {
        setMaterialFiles((current) => current.filter((entry) => entry.path !== file.path));
        return;
      }
      const bridge = window.scopepilotDesktop;
      if (bridge === undefined) throw new Error(t('wizard.s01.bridgeMissing'));
      const inputs = await bridge.removeCaseInput(file.inputId);
      setMaterialFiles(inputs);
      setAnalysisStatus('');
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [data.caseOpened]);

  const saveCaseSettings = useCallback(async () => {
    if (caseRevision === null) return;
    setBusy(true);
    setError('');
    setSettingsStatus('');
    try {
      const bridge = window.scopepilotDesktop;
      if (bridge === undefined) throw new Error(t('wizard.s01.bridgeMissing'));
      let parsedStart: URL;
      try { parsedStart = new URL(startUrl); } catch { throw new Error(t('wizard.s01.startUrlInvalid')); }
      if (!['http:', 'https:'].includes(parsedStart.protocol)) throw new Error(t('wizard.s01.startUrlInvalid'));
      const enteredAllowed = parseHttpOriginInput(allowedOrigins);
      if (enteredAllowed.invalidEntries.length > 0) throw new Error(t('wizard.s01.originInvalid', { value: enteredAllowed.invalidEntries.join(', ') }));
      if (enteredAllowed.origins.length === 0) throw new Error(t('wizard.s01.allowedOriginsRequired'));
      if (!enteredAllowed.origins.includes(parsedStart.origin)) throw new Error(t('wizard.s01.startOriginRequired', { origin: parsedStart.origin }));
      const enteredSupporting = parseHttpOriginInput(supportingOrigins);
      if (enteredSupporting.invalidEntries.length > 0) throw new Error(t('wizard.s01.originInvalid', { value: enteredSupporting.invalidEntries.join(', ') }));
      const scope = await callApi<{ revision: number }>(apiBase, 'POST', '/api/case/scope', {
        expectedRevision: caseRevision,
        allowedOrigins: enteredAllowed.origins,
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      });
      setCaseRevision(scope.revision);
      const saved = await bridge.saveCaseWorkspaceSettings({
        startUrl: parsedStart.toString(),
        allowedOrigins: enteredAllowed.origins,
        supportingOrigins: enteredSupporting.origins,
        targetRoles: targetRoles.split(/[\r\n,]+/).map((entry) => entry.trim()).filter(Boolean),
        forbiddenActions: forbiddenActions.split(/[\r\n]+/).map((entry) => entry.trim()).filter(Boolean),
        aiProvider,
        aiModel,
      });
      setStartUrl(saved.settings.startUrl);
      setAllowedOrigins(saved.allowedOrigins.join('\n'));
      setSupportingOrigins(saved.settings.supportingOrigins.join('\n'));
      setSettingsStatus(t('wizard.s01.settingsSaved'));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [aiModel, aiProvider, allowedOrigins, apiBase, caseRevision, forbiddenActions, startUrl, supportingOrigins, targetRoles]);

  const openCase = useCallback(async () => {
    if (caseDirectory === null) {
      setError(t('wizard.s01.folderRequired'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const bridge = window.scopepilotDesktop;
      if (bridge === undefined) throw new Error(t('wizard.s01.bridgeMissing'));
      const enteredAllowed = parseHttpOriginInput(allowedOrigins);
      if (enteredAllowed.invalidEntries.length > 0) throw new Error(t('wizard.s01.originInvalid', { value: enteredAllowed.invalidEntries.join(', ') }));
      if (workspaceMode === 'create') {
        let parsedStart: URL;
        try {
          parsedStart = new URL(startUrl);
        } catch {
          throw new Error(t('wizard.s01.startUrlInvalid'));
        }
        if (!['http:', 'https:'].includes(parsedStart.protocol)) throw new Error(t('wizard.s01.startUrlInvalid'));
        if (enteredAllowed.origins.length === 0) throw new Error(t('wizard.s01.allowedOriginsRequired'));
        if (!enteredAllowed.origins.includes(parsedStart.origin)) throw new Error(t('wizard.s01.startOriginRequired', { origin: parsedStart.origin }));
      }
      const enteredSupporting = parseHttpOriginInput(supportingOrigins);
      if (enteredSupporting.invalidEntries.length > 0) throw new Error(t('wizard.s01.originInvalid', { value: enteredSupporting.invalidEntries.join(', ') }));
      const activated = await bridge.activateCaseWorkspace({
        directory: caseDirectory.path,
        mode: workspaceMode,
        // DB登録済みの資料は再取込みせず、今回選択されたファイルだけを渡す。
        materialPaths: materialFiles.filter((file) => file.inputId === undefined).map((file) => file.path),
        settings: {
          startUrl,
          supportingOrigins: enteredSupporting.origins,
          targetRoles: targetRoles.split(/[\r\n,]+/).map((entry) => entry.trim()).filter(Boolean),
          forbiddenActions: forbiddenActions.split(/[\r\n]+/).map((entry) => entry.trim()).filter(Boolean),
          aiProvider,
          aiModel,
        },
      });
      setMaterialFiles(activated.inputs);
      const effective = activated.settings;
      const effectiveAllowed = activated.existingCase?.scope.allowedOrigins ?? enteredAllowed.origins;
      const effectiveStart = new URL(effective.startUrl);
      if (!['http:', 'https:'].includes(effectiveStart.protocol)) throw new Error(t('wizard.s01.startUrlInvalid'));
      if (effectiveAllowed.length === 0) throw new Error(t('wizard.s01.allowedOriginsRequired'));
      if (!effectiveAllowed.includes(effectiveStart.origin)) throw new Error(t('wizard.s01.startOriginRequired', { origin: effectiveStart.origin }));
      setStartUrl(effective.startUrl);
      setAllowedOrigins(effectiveAllowed.join('\n'));
      setSupportingOrigins(effective.supportingOrigins.join('\n'));
      setTargetRoles(effective.targetRoles.join('\n'));
      setForbiddenActions(effective.forbiddenActions.join('\n'));
      setAiProvider(effective.aiProvider);
      setAiModel(effective.aiModel);
      if (workspaceMode === 'open' && activated.existingCase === null) throw new Error(t('wizard.s01.existingCaseRequired'));
      const record = activated.existingCase ?? await callApi<{ name: string; revision: number }>(apiBase, 'POST', '/api/case', {
        name: caseDirectory.name,
        allowedOrigins: effectiveAllowed,
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      });
      const now = Date.now();
      await callApi(apiBase, 'POST', '/api/authorization', {
        allowedOperationClasses: ['Browse', 'FormSubmit', 'Upload', 'ActiveScan', 'ApiSend', 'NucleiScan', 'CrossRoleTest'],
        targetRoles: effective.targetRoles.length === 0 ? ['unauthenticated'] : effective.targetRoles,
        validFrom: new Date(now - 60_000).toISOString(),
        validUntil: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
        evidenceLabel: '案件資料に基づく認可 (デスクトップ)',
        evidenceContent: JSON.stringify({ inputHashes: activated.inputs.map((input) => input.sha256) }),
      });
      setCaseName(record.name);
      setCaseRevision(record.revision);
      setAuthRole(effective.targetRoles.find((role) => role !== 'unauthenticated') ?? effective.targetRoles[0] ?? 'member');
      setAuthLoginUrl(effective.startUrl);
      setAuthExpectedUrlPrefix(new URL(effective.startUrl).origin);
      setAuthUsernameSelector('');
      setAuthPasswordSelector('');
      setAuthSubmitSelector('');
      setAuthSuccessMarker('');
      setData((current) => ({ ...current, caseOpened: true }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [aiModel, aiProvider, allowedOrigins, apiBase, caseDirectory, forbiddenActions, materialFiles, startUrl, supportingOrigins, targetRoles, workspaceMode]);

  const inferAuthenticationElements = useCallback(async () => {
    setBusy(true);
    setError('');
    setAuthStatus(t('wizard.s03.authInferring', { provider: aiProvider }));
    try {
      let loginUrl: URL;
      try { loginUrl = new URL(authLoginUrl); } catch { throw new Error(t('wizard.s03.authUrlInvalid')); }
      if (!['http:', 'https:'].includes(loginUrl.protocol)) throw new Error(t('wizard.s03.authUrlInvalid'));
      const allowed = new Set([
        ...parseHttpOriginInput(allowedOrigins).origins,
        ...parseHttpOriginInput(supportingOrigins).origins,
      ]);
      if (!allowed.has(loginUrl.origin)) throw new Error(t('wizard.s03.authOriginRequired'));
      const bridge = window.scopepilotDesktop;
      if (bridge === undefined) throw new Error(t('wizard.s01.bridgeMissing'));
      const inferred = await bridge.inferLoginForm({ loginUrl: loginUrl.toString() });
      setAuthLoginUrl(inferred.loginUrl);
      setAuthUsernameSelector(inferred.usernameSelector);
      setAuthPasswordSelector(inferred.passwordSelector);
      setAuthSubmitSelector(inferred.submitSelector);
      setAuthExpectedUrlPrefix(inferred.expectedUrlPrefix);
      setAuthSuccessMarker(inferred.successMarker);
      setAuthStatus(t('wizard.s03.authInferred', {
        provider: inferred.provider,
        confidence: Math.round(inferred.confidence * 100),
        summary: inferred.summary,
        warnings: inferred.warnings.length === 0 ? t('wizard.s03.authNoWarnings') : inferred.warnings.join(' / '),
      }));
    } catch (cause) {
      setError(String(cause));
      setAuthStatus('');
    } finally {
      setBusy(false);
    }
  }, [aiProvider, allowedOrigins, authLoginUrl, supportingOrigins]);

  const addAuthentication = useCallback(async () => {
    setBusy(true);
    setError('');
    setAuthStatus('');
    const usernameReference = `simple:${authRole.trim()}:username`;
    const passwordReference = `simple:${authRole.trim()}:password`;
    try {
      if ([authRole, authLoginUrl, authExpectedUrlPrefix, authUsernameSelector, authPasswordSelector, authSubmitSelector, authSuccessMarker, authUsername, authPassword]
        .some((value) => value.trim() === '')) throw new Error(t('wizard.s03.authRequired'));
      const loginUrl = new URL(authLoginUrl);
      const expectedUrl = new URL(authExpectedUrlPrefix);
      if (!['http:', 'https:'].includes(loginUrl.protocol) || !['http:', 'https:'].includes(expectedUrl.protocol)) throw new Error(t('wizard.s03.authUrlInvalid'));
      const allowed = new Set([
        ...parseHttpOriginInput(allowedOrigins).origins,
        ...parseHttpOriginInput(supportingOrigins).origins,
      ]);
      if (!allowed.has(loginUrl.origin) || !allowed.has(expectedUrl.origin)) throw new Error(t('wizard.s03.authOriginRequired'));
      let postLoginSteps: readonly (
        | { readonly kind: 'navigate' | 'click' | 'wait' | 'assert'; readonly target: string }
        | { readonly kind: 'select' | 'assertValue'; readonly target: string; readonly value: string }
      )[] = [];
      let postLoginSummary = '';
      let postLoginWarnings: readonly string[] = [];
      let executionExpectedUrlPrefix = expectedUrl.toString();
      if (postLoginSetupEnabled) {
        if (postLoginInstruction.trim() === '') throw new Error(t('wizard.s03.postLoginRequired'));
        const bridge = window.scopepilotDesktop;
        if (bridge === undefined) throw new Error(t('wizard.s01.bridgeMissing'));
        setAuthStatus(t('wizard.s03.postLoginPlanning', { provider: aiProvider }));
        const plan = await bridge.planPostLoginActions({ instruction: postLoginInstruction.trim() });
        postLoginSteps = plan.steps;
        postLoginSummary = plan.summary;
        postLoginWarnings = plan.warnings;
        executionExpectedUrlPrefix = plan.expectedUrlPrefix ?? executionExpectedUrlPrefix;
      }
      await callApi(apiBase, 'POST', '/api/sessions/flows', {
        role: authRole.trim(),
        flowVersion: `simple-${Date.now()}`,
        steps: [
          { kind: 'navigate', target: loginUrl.toString() },
          { kind: 'fill', target: authUsernameSelector.trim(), secretReference: usernameReference },
          { kind: 'fill', target: authPasswordSelector.trim(), secretReference: passwordReference },
          { kind: 'click', target: authSubmitSelector.trim() },
          { kind: 'assert', target: authSuccessMarker.trim() },
          ...postLoginSteps,
        ],
      });
      const result = await callApi<{ authenticated: boolean; finalUrl: string; cookieNames: readonly string[] }>(apiBase, 'POST', '/api/sessions/login', {
        role: authRole.trim(),
        baseUrl: loginUrl.origin,
        expectedUrlPrefix: executionExpectedUrlPrefix,
        secretValues: { [usernameReference]: authUsername, [passwordReference]: authPassword },
      });
      if (result.authenticated) {
        setAuthenticatedRole(authRole.trim());
        setAuthStatus(t(postLoginSetupEnabled ? 'wizard.s03.authSucceededWithSetup' : 'wizard.s03.authSucceeded', {
          role: authRole.trim(),
          cookies: result.cookieNames.join(', ') || '—',
          summary: postLoginSummary,
        }) + (postLoginWarnings.length === 0 ? '' : ` ${t('wizard.s03.postLoginWarnings', { warnings: postLoginWarnings.join(' / ') })}`));
        setCredentialEditorOpen(false);
      } else {
        setAuthenticatedRole('');
        setAuthStatus(t('wizard.s03.authFailed', { url: result.finalUrl }));
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setAuthUsername('');
      setAuthPassword('');
      setBusy(false);
    }
  }, [aiProvider, allowedOrigins, apiBase, authExpectedUrlPrefix, authLoginUrl, authPassword, authPasswordSelector, authRole, authSubmitSelector, authSuccessMarker, authUsername, authUsernameSelector, postLoginInstruction, postLoginSetupEnabled, supportingOrigins]);

  const analyzeMaterials = useCallback(async () => {
    setBusy(true);
    setError('');
    setAnalysisStatus(t('wizard.s01.aiAnalyzing', { provider: aiProvider }));
    try {
      const bridge = window.scopepilotDesktop;
      if (bridge === undefined) throw new Error(t('wizard.s01.bridgeMissing'));
      const result = await bridge.analyzeMaterials();
      let hintCount = 0;
      for (const document of result.documents) {
        if (document.urls.length > 0) {
          await callApi(apiBase, 'POST', '/api/documents/hints', { documentLabel: document.documentLabel, urls: document.urls });
          hintCount += document.urls.length;
        }
        if (document.authHints.length > 0) {
          await callApi(apiBase, 'POST', '/api/documents/auth-hints', { documentLabel: document.documentLabel, entries: document.authHints });
          hintCount += document.authHints.length;
        }
        if (document.priorityRules.length > 0) {
          await callApi(apiBase, 'POST', '/api/documents/priority-hints', { documentLabel: document.documentLabel, rules: document.priorityRules });
          hintCount += document.priorityRules.length;
        }
        if (document.parameters.length > 0) {
          await callApi(apiBase, 'POST', '/api/documents/parameter-hints', { documentLabel: document.documentLabel, parameters: document.parameters });
          hintCount += document.parameters.length;
        }
      }
      setAnalysisStatus(t('wizard.s01.aiAnalyzed', { provider: result.provider, model: result.model, documents: result.documents.length, hints: hintCount }));
    } catch (cause) {
      setAnalysisStatus(t('wizard.s01.aiFailed', { message: String(cause) }));
    } finally {
      setBusy(false);
    }
  }, [aiProvider, apiBase]);

  const runExploration = useCallback(async () => {
    // React の busy 反映前に連続 click が入っても、同じ browser/ZAP context で
    // 探索を二重起動しない。二重起動は片方の navigation/API を abort し得る。
    if (explorationInFlight.current) return;
    explorationInFlight.current = true;
    setBusy(true);
    setError('');
    try {
      setAdoptedCandidates([]);
      setScanPlan(null);
      setScanConfirmation(null);
      setScanExecution(null);
      setInteractivePlan(null);
      setInteractivePlanConfirmed(false);
      setInteractiveUpload(null);
      setInteractiveApiSpec(null);
      setInteractiveResults([]);
      setInteractiveStatus('');
      const plan = await callApi<{ plan: unknown }>(apiBase, 'POST', '/api/plan/explore', {
        seeds: [startUrl],
      });
      const confirmation = await callApi<{ confirmationId: string }>(apiBase, 'POST', '/api/plan/confirm', { plan: plan.plan });
      const run = await callApi<{ observations: readonly unknown[]; candidates: readonly ScanCandidateView[] }>(apiBase, 'POST', '/api/run/explore', {
        plan: plan.plan,
        confirmation,
        maxDepth: 5,
        ...(authenticatedRole === '' ? {} : { role: authenticatedRole }),
      });
      setCandidates(run.candidates);
      setSelectedCandidateIds(run.candidates.filter(isDynamicCandidate).map((candidate) => candidate.candidateId));
      setExploreSummary(t('wizard.s03.done', { observations: run.observations.length, candidates: run.candidates.length }));
      setData((current) => ({ ...current, explorationDone: true }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      explorationInFlight.current = false;
      setBusy(false);
    }
  }, [apiBase, authenticatedRole, startUrl]);

  const adoptTargets = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const selected = candidates.filter((candidate) => selectedCandidateIds.includes(candidate.candidateId));
      const result = await callApi<{ adopted: readonly ScanCandidateView[] }>(apiBase, 'POST', '/api/candidates/adopt', { candidates: selected });
      setAdoptedCandidates(result.adopted);
      setScanPlan(null);
      setScanConfirmation(null);
      setScanExecution(null);
      setData((current) => ({ ...current, selectedTargets: result.adopted.map((entry) => entry.url), planConfirmed: false, runFinished: false }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, candidates, selectedCandidateIds]);

  const prepareScanPlan = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const plan = await callApi<ScanPlanView>(apiBase, 'POST', '/api/plan/scan', {
        targets: data.selectedTargets,
        enableNuclei: nucleiEnabled,
        enableWorkflowScan: workflowScanEligible,
        guidelines: data.selectedGuidelines,
      });
      const confirmation = await callApi<{ confirmationId: string }>(apiBase, 'POST', '/api/plan/confirm', { plan: plan.plan });
      setScanPlan(plan);
      setScanConfirmation(confirmation);
      setScanExecution(null);
      setData((current) => ({ ...current, planConfirmed: true }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, data.selectedGuidelines, data.selectedTargets, nucleiEnabled, workflowScanEligible]);

  const planInteractiveDiagnostics = useCallback(async () => {
    const bridge = window.scopepilotDesktop;
    if (bridge === undefined) {
      setError(t('wizard.s01.bridgeMissing'));
      return;
    }
    setBusy(true);
    setError('');
    setInteractiveStatus('');
    setInteractivePlanConfirmed(false);
    try {
      if (interactiveInstruction.trim() === '') throw new Error(t('wizard.s05.interactiveInstructionRequired'));
      const sessions = await callApi<{ sessions: readonly { role: string; cookieNames: readonly string[] }[] }>(apiBase, 'GET', '/api/sessions');
      const roles = sessions.sessions.filter((session) => session.cookieNames.length > 0).map((session) => session.role);
      const plan = await bridge.planInteractiveDiagnostics({
        instruction: interactiveInstruction.trim(),
        roles,
        candidates: interactiveCandidates.map((candidate) => ({
          url: candidate.url,
          method: candidate.method,
          diagnosticTracks: candidate.diagnosticTracks ?? [],
          inputPoints: (candidate.inputPoints ?? []).map((point) => ({ location: point.location, name: point.name })),
        })),
      });
      setInteractivePlan(plan);
      setInteractiveStatus(t('wizard.s05.interactivePlanned', { provider: plan.provider, model: plan.model, count: plan.items.length }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, interactiveCandidates, interactiveInstruction]);

  const selectInteractiveUpload = useCallback(async () => {
    try {
      const selected = await window.scopepilotDesktop?.selectInteractiveInput('upload-file');
      if (selected !== undefined && selected !== null) setInteractiveUpload(selected);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  const selectInteractiveApiSpec = useCallback(async () => {
    try {
      const selected = await window.scopepilotDesktop?.selectInteractiveInput('api-spec');
      if (selected !== undefined && selected !== null) setInteractiveApiSpec(selected);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  const executeInteractiveDiagnostics = useCallback(async () => {
    if (interactivePlan === null || !interactivePlanConfirmed) return;
    const needsUpload = interactivePlan.items.some((item) => item.requiredInputs.includes('upload-file'));
    const needsApiSpec = interactivePlan.items.some((item) => item.requiredInputs.includes('api-spec'));
    if (needsUpload && interactiveUpload === null) throw new Error(t('wizard.s05.uploadRequired'));
    if (needsApiSpec && interactiveApiSpec === null) throw new Error(t('wizard.s05.apiSpecRequired'));
    setInteractiveStatus(t('wizard.s06.interactiveRunning'));
    const result = await callApi<{ results: readonly InteractiveDiagnosticResult[] }>(apiBase, 'POST', '/api/diagnostics/interactive', {
      confirmed: true,
      items: interactivePlan.items,
      files: interactiveUpload === null ? [] : [interactiveUpload],
      apiDocuments: interactiveApiSpec === null ? [] : [interactiveApiSpec],
    });
    setInteractiveResults(result.results);
    setInteractiveStatus(t('wizard.s06.interactiveDone', { count: result.results.length }));
  }, [apiBase, interactiveApiSpec, interactivePlan, interactivePlanConfirmed, interactiveUpload]);

  const runScan = useCallback(async () => {
    if (scanPlan === null || scanConfirmation === null) {
      return;
    }
    setBusy(true);
    setError('');
    setRunSummary('');
    try {
      if (adoptedCandidates.length === 0) throw new Error(t('wizard.s06.adoptedCandidatesMissing'));
      const started = await callApi<{ executionId: string }>(apiBase, 'POST', '/api/run/scan/start', {
        plan: scanPlan.plan,
        confirmation: scanConfirmation,
        adopted: adoptedCandidates,
        ...(authenticatedRole === '' ? {} : { role: authenticatedRole }),
      });
      let snapshot: ScanExecutionView = {
        executionId: started.executionId,
        state: 'Confirmed',
        runState: 'Confirmed',
        dispatchState: 'queued',
        currentEngine: 'scopepilot',
        currentCommand: '',
        progress: 0,
        logs: [],
      };
      setScanExecution(snapshot);
      while (snapshot.state === 'Confirmed' || snapshot.state === 'Running' || snapshot.state === 'Stopping') {
        await waitFor(400);
        snapshot = await callApi<ScanExecutionView>(apiBase, 'GET', `/api/run/scan/status?executionId=${encodeURIComponent(started.executionId)}`);
        setScanExecution(snapshot);
      }
      if (snapshot.state === 'Stopped') {
        setRunSummary(t('wizard.s06.stopped'));
        return;
      }
      if (snapshot.state === 'Failed' || snapshot.state === 'Interrupted' || snapshot.result === undefined) {
        throw new Error(snapshot.error ?? t('wizard.s06.failed'));
      }
      const run = snapshot.result;
      setFindings(run.findings);
      const nucleiStatus = run.nuclei === undefined
        ? t('wizard.s06.nucleiNotSelected')
        : run.nuclei.status === 'failed'
          ? t('wizard.s06.nucleiFailed', { error: run.nuclei.error ?? 'unknown error' })
          : t('wizard.s06.nucleiDone', { engineVersion: run.nuclei.engineVersion, findings: run.nuclei.importedCount });
      const workflowStatus = run.workflow === undefined
        ? t('wizard.s06.workflowNotSelected')
        : run.workflow.status === 'failed'
          ? t('wizard.s06.workflowFailed', { error: run.workflow.error ?? 'unknown error' })
          : t('wizard.s06.workflowDone', {
              kinds: run.workflow.checkKindCount,
              findings: run.workflow.checkCount,
              requests: run.workflow.requestCount,
              payloadSet: run.workflow.payloadSet,
            });
      const verificationStatus = (run.payloadVerifications ?? []).length === 0
        ? ''
        : ` ${t('wizard.s06.payloadVerificationDone', {
            verified: run.payloadVerifications?.length ?? 0,
            executed: (run.payloadVerifications ?? []).filter((verification) => verification.executed).length,
          })}`;
      setRunSummary(`${t('wizard.s06.done', { engineVersion: run.engineVersion, overshoot: run.overshootReservation, findings: run.findings.length })} ${workflowStatus} ${nucleiStatus}${verificationStatus}`);
      setData((current) => ({ ...current, runFinished: true }));
      if (interactivePlan !== null && interactivePlanConfirmed) {
        await executeInteractiveDiagnostics();
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [adoptedCandidates, apiBase, authenticatedRole, executeInteractiveDiagnostics, interactivePlan, interactivePlanConfirmed, scanPlan, scanConfirmation]);

  const retryInteractiveDiagnostics = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await executeInteractiveDiagnostics();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [executeInteractiveDiagnostics]);

  const stopScan = useCallback(async () => {
    if (scanExecution === null || !['Confirmed', 'Running'].includes(scanExecution.state)) return;
    try {
      const stopped = await callApi<ScanStateProjection & { executionId: string }>(apiBase, 'POST', '/api/run/scan/stop', {
        executionId: scanExecution.executionId,
      });
      setScanExecution((current) => current === null ? current : { ...current, ...stopped });
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase, scanExecution]);

  const buildReport = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const report = await callApi<{
        content: string;
        modelHash: string;
        reportId: string;
        model: Parameters<NonNullable<Window['scopepilotDesktop']>['saveReport']>[0]['model'];
      }>(apiBase, 'POST', '/api/report', {
        guidelines: data.selectedGuidelines,
        excludeLowAndInfo,
      });
      const bridge = window.scopepilotDesktop;
      if (bridge === undefined) throw new Error(t('wizard.s01.bridgeMissing'));
      let content = report.content;
      let findingNarratives: Awaited<ReturnType<NonNullable<Window['scopepilotDesktop']>['generateAiReport']>>['findingNarratives'] | undefined;
      try {
        const drafted = await bridge.generateAiReport({
          baseContent: report.content,
          baseModelHash: report.modelHash,
          guidelines: data.selectedGuidelines,
          findings: report.model.findings.map((finding) => ({
            findingId: finding.findingId,
            title: finding.title,
            url: finding.url,
            method: finding.method ?? 'GET',
            parameter: finding.param ?? '',
          })),
        });
        content = drafted.content;
        findingNarratives = drafted.findingNarratives;
        setReportAiStatus(t('wizard.s07.aiGenerated', { provider: drafted.provider, model: drafted.model }));
      } catch (cause) {
        setReportAiStatus(t('wizard.s07.aiFallback', { message: String(cause) }));
      }
      const saved = await bridge.saveReport({
        content,
        modelHash: report.modelHash,
        reportId: report.reportId,
        model: report.model,
        profile: reportProfile,
        ...(findingNarratives === undefined ? {} : { findingNarratives }),
      });
      setReportFiles(saved);
      setReportContent(content);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, data.selectedGuidelines, excludeLowAndInfo, reportProfile]);

  const advanceResult = advance(step, data);
  const backResult = goBack(step);

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeading}>
          <span className={styles.eyebrow}>{t('wizard.flow.eyebrow')}</span>
          <Text size={400} weight="semibold">{t('wizard.flow.title')}</Text>
          <Text size={200} className={styles.hint}>{t('wizard.flow.progress', { current: stepIndex + 1, total: WIZARD_STEPS.length })}</Text>
        </div>
        <ProgressBar value={progress} thickness="medium" />
        <nav className={styles.steps} aria-label={t('wizard.flow.aria')}>
          {WIZARD_STEPS.map((entry, index) => {
            const isActive = entry === step;
            const isComplete = index < stepIndex;
            return (
              <div
                key={entry}
                className={`${styles.stepBadge} ${isActive ? styles.stepActive : ''} ${isComplete ? styles.stepComplete : ''}`}
                aria-current={isActive ? 'step' : undefined}
              >
                <span className={`${styles.stepNumber} ${isActive ? styles.stepNumberActive : ''}`} aria-hidden="true">
                  {isComplete ? '✓' : index + 1}
                </span>
                <span className={styles.stepLabel}>{entry} {STEP_LABELS[entry]}</span>
              </div>
            );
          })}
        </nav>
        <Text size={200} className={styles.sidebarNote}>{t('wizard.flow.note')}</Text>
      </aside>

      <div className={styles.main}>
        <header className={styles.pageHeader}>
          <span className={styles.eyebrow}>{step}</span>
          <Text as="h1" size={600} weight="semibold">{STEP_LABELS[step]}</Text>
          <Text className={styles.hint}>{t('wizard.flow.help')}</Text>
        </header>

        {error !== '' && <MessageBar intent="error">{error}</MessageBar>}

        <section className={styles.surface} aria-labelledby={`wizard-${step}-title`}>
          {busy && <ProgressBar className={styles.busyBar} />}
          <div className={styles.content}>

      {step === 'S01' && (
        <>
          <Text id="wizard-S01-title" size={400} weight="semibold">{STEP_LABELS.S01}</Text>
          <Text className={styles.hint}>{t('wizard.s01.intro')}</Text>

          <div className={styles.pathCard}>
            <Text weight="semibold">{t('wizard.s01.folderLabel')}</Text>
            {caseDirectory === null ? (
              <div className={styles.inlineActions}>
                <Button appearance="primary" disabled={busy} onClick={() => void selectCaseDirectory('create')}>
                  {t('wizard.s01.createFolder')}
                </Button>
                <Button disabled={busy} onClick={() => void selectCaseDirectory('open')}>
                  {t('wizard.s01.openExistingFolder')}
                </Button>
              </div>
            ) : (
              <div className={styles.pathRow}>
                <div className={styles.pathDetails}>
                  <Text weight="semibold">{caseDirectory.name}</Text>
                  <Text size={200}>{workspaceMode === 'create' ? t('wizard.s01.modeCreate') : t('wizard.s01.modeOpen')}</Text>
                  <Text size={200} className={styles.pathValue} title={caseDirectory.path}>{caseDirectory.path}</Text>
                </div>
                <div className={styles.inlineActions}>
                  <Button size="small" onClick={() => void openSelectedPath(caseDirectory.path)}>
                    {t('wizard.s01.openFolder')}
                  </Button>
                  <Button size="small" appearance="subtle" disabled={busy} onClick={() => void selectCaseDirectory(workspaceMode)}>
                    {t('wizard.s01.changeFolder')}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className={styles.pathCard}>
            <Text weight="semibold">{t('wizard.s01.settingsTitle')}</Text>
            <div className={styles.formGrid}>
              <Field className={styles.fullField} label={t('wizard.s01.startUrl')} required>
                <Input value={startUrl} onChange={(_event, state) => {
                  setStartUrl(state.value);
                  try {
                    const origin = new URL(state.value).origin;
                    if (allowedOrigins.trim() === '') setAllowedOrigins(origin);
                  } catch { /* 入力途中は確定時に検証する。 */ }
                }} />
              </Field>
              <Field label={t('wizard.s01.allowedOrigins')} required hint={t('wizard.s01.onePerLine')}>
                <Textarea value={allowedOrigins} resize="vertical" onChange={(_event, state) => setAllowedOrigins(state.value)} />
              </Field>
              <Field label={t('wizard.s01.supportingOrigins')} hint={t('wizard.s01.onePerLine')}>
                <Textarea value={supportingOrigins} resize="vertical" onChange={(_event, state) => setSupportingOrigins(state.value)} />
              </Field>
              <Field label={t('wizard.s01.roles')} hint={t('wizard.s01.onePerLine')}>
                <Textarea value={targetRoles} resize="vertical" onChange={(_event, state) => setTargetRoles(state.value)} />
              </Field>
              <Field label={t('wizard.s01.forbiddenActions')} hint={t('wizard.s01.onePerLine')}>
                <Textarea value={forbiddenActions} resize="vertical" onChange={(_event, state) => setForbiddenActions(state.value)} />
              </Field>
              <Field label={t('wizard.s01.aiProvider')}>
                <Select
                  value={selectedAiCatalog === undefined ? '' : aiProvider}
                  disabled={aiCatalogLoading || aiCatalog?.providers.length === 0}
                  onChange={(event) => {
                    const provider = event.target.value as AiCliProvider;
                    const catalog = aiCatalog?.providers.find((candidate) => candidate.provider === provider);
                    if (catalog === undefined) return;
                    const model = defaultModel(catalog);
                    setAiProvider(provider);
                    setAiModel(model);
                    persistAiSelection({ provider, model });
                  }}
                >
                  {aiCatalogLoading && <option value="">{t('wizard.s01.aiLoading')}</option>}
                  {!aiCatalogLoading && aiCatalog?.providers.length === 0 && <option value="">{t('wizard.s01.aiUnavailable')}</option>}
                  {aiCatalog?.providers.map((provider) => <option key={provider.provider} value={provider.provider}>{provider.label}</option>)}
                </Select>
              </Field>
              <Field label={t('wizard.s01.aiModel')} hint={t('wizard.s01.aiModelHint')}>
                <Select
                  value={aiModel}
                  disabled={aiCatalogLoading || selectedAiCatalog === undefined}
                  onChange={(event) => {
                    const model = event.target.value;
                    setAiModel(model);
                    persistAiSelection({ provider: aiProvider, model });
                  }}
                >
                  {selectedAiCatalog?.models.length === 0 && <option value="">{t('wizard.s01.aiCliDefault')}</option>}
                  {selectedAiCatalog?.models.map((model) => <option key={model.id || '__default'} value={model.id}>{model.label}</option>)}
                </Select>
              </Field>
              {!aiCatalogLoading && aiCatalog?.providers.length === 0 && (
                <MessageBar className={styles.fullField} intent="warning">
                  {t('wizard.s01.aiLoginRequired')}{' '}
                  <Button appearance="transparent" size="small" onClick={() => void window.scopepilotDesktop?.openSettings()}>{t('app.settings')}</Button>
                  <Button appearance="transparent" size="small" onClick={() => setAiCatalogRevision((value) => value + 1)}>{t('wizard.s01.aiRefresh')}</Button>
                </MessageBar>
              )}
            </div>
          </div>

          <div className={styles.pathCard}>
            <div className={styles.pathRow}>
              <div className={styles.pathDetails}>
                <Text weight="semibold">{t('wizard.s01.materialsTitle')}</Text>
                <Text size={200} className={styles.hint}>{t('wizard.s01.materialsHint')}</Text>
              </div>
              <Button disabled={busy || caseDirectory === null} onClick={() => void selectMaterialFiles()}>
                {t('wizard.s01.addMaterials')}
              </Button>
            </div>
            {materialFiles.length === 0 ? (
              <Text size={200} className={styles.hint}>{t('wizard.s01.noMaterials')}</Text>
            ) : (
              <div className={styles.fileList}>
                {materialFiles.map((file) => (
                  <div className={styles.fileRow} key={file.path}>
                    <div className={styles.pathDetails}>
                      <Text>{file.name}</Text>
                      <Text size={200} className={styles.pathValue} title={file.path}>{file.path}</Text>
                    </div>
                    <Button size="small" appearance="subtle" onClick={() => void openSelectedPath(file.path)}>
                      {t('wizard.s01.openFile')}
                    </Button>
                    <Button size="small" appearance="subtle" disabled={busy} onClick={() => void removeMaterial(file)}>
                      {t('wizard.s01.removeFile')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {data.caseOpened ? (
            <>
              <Text role="status">{t('wizard.s01.opened', { caseName })}</Text>
              <div className={styles.inlineActions}>
                <Button appearance="primary" disabled={busy} onClick={() => void saveCaseSettings()}>
                  {t('wizard.s01.saveSettings')}
                </Button>
                {materialFiles.length > 0 && (
                  <Button disabled={busy} onClick={() => void analyzeMaterials()}>
                    {t('wizard.s01.analyzeMaterials', { provider: aiProvider })}
                  </Button>
                )}
              </div>
              {settingsStatus !== '' && <Text role="status" className={styles.hint}>{settingsStatus}</Text>}
              {analysisStatus !== '' && <Text role="status" className={styles.hint}>{analysisStatus}</Text>}
            </>
          ) : (
            <Button appearance="primary" disabled={busy || caseDirectory === null || selectedAiCatalog === undefined} onClick={() => void openCase()}>
              {workspaceMode === 'create' ? t('wizard.s01.createCase') : t('wizard.s01.openCase')}
            </Button>
          )}
        </>
      )}

      {step === 'S02' && (
        <>
          <Text id="wizard-S02-title" size={400} weight="semibold">{t('wizard.s02.title')}</Text>
          <div className={styles.choiceList}>
            {GUIDELINES.map((guideline) => (
              <Checkbox
                key={guideline}
                label={guideline}
                checked={data.selectedGuidelines.includes(guideline)}
                onChange={(_event, state) => {
                  setData((current) => ({
                    ...current,
                    selectedGuidelines:
                      state.checked === true
                        ? [...current.selectedGuidelines, guideline]
                        : current.selectedGuidelines.filter((entry) => entry !== guideline),
                  }));
                }}
              />
            ))}
          </div>
        </>
      )}

      {step === 'S03' && (
        <>
          <Text id="wizard-S03-title" size={400} weight="semibold">{t('wizard.s03.title')}</Text>
          <Text className={styles.hint}>{t('wizard.s03.defaultLimits')}</Text>
          <div className={styles.pathCard}>
            <div className={styles.pathRow}>
              <div className={styles.pathDetails}>
                <Text weight="semibold">{t('wizard.s03.authTitle')}</Text>
                <Text size={200} className={styles.hint}>{t('wizard.s03.authIntro')}</Text>
              </div>
              <Button disabled={busy} onClick={() => {
                setCredentialEditorOpen((current) => {
                  if (current) {
                    setAuthUsername('');
                    setAuthPassword('');
                  }
                  return !current;
                });
              }}>
                {credentialEditorOpen ? t('wizard.s03.authCancel') : t('wizard.s03.authAdd')}
              </Button>
            </div>
            {credentialEditorOpen && (
              <div className={styles.formGrid}>
                <Field label={t('wizard.s03.authRole')} required>
                  <Input value={authRole} onChange={(_event, state) => setAuthRole(state.value)} />
                </Field>
                <Field label={t('wizard.s03.authLoginUrl')} required>
                  <Input value={authLoginUrl} onChange={(_event, state) => setAuthLoginUrl(state.value)} />
                </Field>
                <div className={`${styles.fullField} ${styles.inlineActions}`}>
                  <Button disabled={busy || authLoginUrl.trim() === ''} onClick={() => void inferAuthenticationElements()}>
                    {t('wizard.s03.authInfer')}
                  </Button>
                  <Text size={200} className={styles.hint}>{t('wizard.s03.authInferHint', { provider: aiProvider })}</Text>
                </div>
                <Field label={t('wizard.s03.authUsername')} required>
                  <Input value={authUsername} autoComplete="off" onChange={(_event, state) => setAuthUsername(state.value)} />
                </Field>
                <Field label={t('wizard.s03.authPassword')} required>
                  <Input type="password" value={authPassword} autoComplete="new-password" onChange={(_event, state) => setAuthPassword(state.value)} />
                </Field>
                <Field label={t('wizard.s03.authUsernameSelector')} required>
                  <Input value={authUsernameSelector} onChange={(_event, state) => setAuthUsernameSelector(state.value)} />
                </Field>
                <Field label={t('wizard.s03.authPasswordSelector')} required>
                  <Input value={authPasswordSelector} onChange={(_event, state) => setAuthPasswordSelector(state.value)} />
                </Field>
                <Field label={t('wizard.s03.authSubmitSelector')} required>
                  <Input value={authSubmitSelector} onChange={(_event, state) => setAuthSubmitSelector(state.value)} />
                </Field>
                <Field label={t('wizard.s03.authExpectedPrefix')} required>
                  <Input value={authExpectedUrlPrefix} onChange={(_event, state) => setAuthExpectedUrlPrefix(state.value)} />
                </Field>
                <Field className={styles.fullField} label={t('wizard.s03.authSuccessMarker')} required hint={t('wizard.s03.authSuccessMarkerHint')}>
                  <Input value={authSuccessMarker} onChange={(_event, state) => setAuthSuccessMarker(state.value)} />
                </Field>
                <div className={styles.fullField}>
                  <Checkbox
                    checked={postLoginSetupEnabled}
                    label={t('wizard.s03.postLoginSetup')}
                    onChange={(_event, state) => setPostLoginSetupEnabled(state.checked === true)}
                  />
                  <Text size={200} className={styles.hint}>{t('wizard.s03.postLoginSetupHint')}</Text>
                </div>
                {postLoginSetupEnabled && (
                  <Field
                    className={styles.fullField}
                    label={t('wizard.s03.postLoginInstruction')}
                    required
                  >
                    <Textarea
                      rows={4}
                      resize="vertical"
                      placeholder={t('wizard.s03.postLoginInstructionPlaceholder')}
                      value={postLoginInstruction}
                      onChange={(_event, state) => setPostLoginInstruction(state.value)}
                    />
                  </Field>
                )}
                <Button className={styles.fullField} appearance="primary" disabled={busy} onClick={() => void addAuthentication()}>
                  {t('wizard.s03.authRun')}
                </Button>
              </div>
            )}
            {authStatus !== '' && <Text role="status">{authStatus}</Text>}
          </div>
          {data.explorationDone ? (
            <Text role="status">{exploreSummary}</Text>
          ) : (
            <Button appearance="primary" disabled={busy} onClick={() => void runExploration()}>
              {t('wizard.s03.explore')}
            </Button>
          )}
        </>
      )}

      {step === 'S04' && (
        <>
          <Text id="wizard-S04-title" size={400} weight="semibold">{t('wizard.s04.title')}</Text>
          <Text className={styles.hint}>{t('wizard.s04.hint')}</Text>
          <div className={styles.reviewToolbar}>
            <Input
              className={styles.reviewSearch}
              value={candidateSearch}
              placeholder={t('wizard.s04.searchPlaceholder')}
              aria-label={t('wizard.s04.searchLabel')}
              onChange={(_event, state) => setCandidateSearch(state.value)}
            />
            <Button appearance={candidateFilter === 'all' ? 'primary' : 'secondary'} onClick={() => setCandidateFilter('all')}>{t('wizard.s04.filterAll')}</Button>
            <Button appearance={candidateFilter === 'selected' ? 'primary' : 'secondary'} onClick={() => setCandidateFilter('selected')}>{t('wizard.s04.filterSelected')}</Button>
            <Button appearance={candidateFilter === 'unselected' ? 'primary' : 'secondary'} onClick={() => setCandidateFilter('unselected')}>{t('wizard.s04.filterUnselected')}</Button>
          </div>
          <div className={styles.reviewToolbar}>
            <Button onClick={() => setSelectedCandidateIds((current) => [...new Set([...current, ...filteredCandidates.filter((candidate) => candidateSafetyExclusion(candidate) === undefined).map((candidate) => candidate.candidateId)])])}>
              {t('wizard.s04.selectVisible')}
            </Button>
            <Button onClick={() => {
              const visibleIds = new Set(filteredCandidates.map((candidate) => candidate.candidateId));
              setSelectedCandidateIds((current) => current.filter((id) => !visibleIds.has(id)));
            }}>
              {t('wizard.s04.clearVisible')}
            </Button>
            <Button onClick={() => setSelectedCandidateIds(candidates.filter((candidate) => candidateSafetyExclusion(candidate) === undefined).map((candidate) => candidate.candidateId))}>{t('wizard.s04.selectAll')}</Button>
            <Button onClick={() => setSelectedCandidateIds([])}>{t('wizard.s04.clearAll')}</Button>
          </div>
          <div className={styles.summaryRow}>
            <Text weight="semibold">{t('wizard.s04.summary', { shown: filteredCandidates.length, total: candidates.length, selected: selectedCandidateIds.length })}</Text>
            <Text className={styles.hint}>{t('wizard.s04.dynamicDefault')}</Text>
          </div>
          <div className={styles.candidateList}>
            {filteredCandidates.map((candidate) => {
              const dynamic = isDynamicCandidate(candidate);
              const safetyExclusion = candidateSafetyExclusion(candidate);
              return (
                <div className={styles.candidateRow} key={candidate.candidateId}>
                  <Checkbox
                    aria-label={`${candidate.method} ${candidate.url}`}
                    checked={selectedCandidateIds.includes(candidate.candidateId)}
                    disabled={safetyExclusion !== undefined}
                    onChange={(_event, state) => {
                      setSelectedCandidateIds((current) =>
                        state.checked === true
                          ? [...new Set([...current, candidate.candidateId])]
                          : current.filter((entry) => entry !== candidate.candidateId),
                      );
                      setAdoptedCandidates([]);
                      setScanPlan(null);
                      setScanConfirmation(null);
                      setData((current) => ({ ...current, selectedTargets: [], planConfirmed: false }));
                    }}
                  />
                  <div className={styles.candidateBody}>
                    <Text weight="semibold" className={styles.candidateUrl}>{candidate.method.toUpperCase()} {candidate.url}</Text>
                    <Text>{candidateReason(candidate)}</Text>
                    {safetyExclusion !== undefined && <Text size={200} className={styles.hint}>{safetyExclusion}</Text>}
                    <Text size={200} className={styles.hint}>{t('wizard.s04.inputPoints', {
                      points: candidate.inputPoints?.map((point) => `${point.location}:${point.name}`).join(', ') || t('wizard.s04.noInputPoints'),
                    })}</Text>
                    {candidate.contentType !== undefined && <Text size={200} className={styles.hint}>{t('wizard.s04.contentType', { contentType: candidate.contentType })}</Text>}
                    <Text size={200} className={styles.hint}>{t('wizard.s04.diagnosticTracks', {
                      tracks: candidate.diagnosticTracks?.join(', ') || 'zap-active',
                    })}</Text>
                    <Text size={200} className={styles.hint}>{t('wizard.s04.observedAt', { url: candidate.observationUrl })}</Text>
                    <Text size={200} className={styles.hint}>{t('wizard.s04.guidelineBasis', { basis: candidate.guidelineBasis.join(', ') || '-' })}</Text>
                  </div>
                  <div className={styles.candidateMeta}>
                    <span className={styles.badge}>{candidate.category}</span>
                    {dynamic && <span className={`${styles.badge} ${styles.dynamicBadge}`}>{t('wizard.s04.dynamic')}</span>}
                    {safetyExclusion !== undefined && <span className={styles.badge}>{t('wizard.s04.safetyExcluded')}</span>}
                    <span className={styles.badge}>{Math.round(candidate.confidence * 100)}%</span>
                  </div>
                </div>
              );
            })}
          </div>
          <Button appearance="primary" disabled={busy || selectedCandidateIds.length === 0} onClick={() => void adoptTargets()}>
            {t('wizard.s04.adopt', { count: selectedCandidateIds.length })}
          </Button>
        </>
      )}

      {step === 'S05' && scanPlan !== null && (
        <>
          <Text id="wizard-S05-title" size={400} weight="semibold">{t('wizard.s05.title')}</Text>
          <div className={styles.pathCard}>
            <Switch
              checked={nucleiEnabled}
              label={t('wizard.s05.nucleiToggle')}
              onChange={(_event, state) => {
                setNucleiEnabled(state.checked);
                setScanPlan(null);
                setScanConfirmation(null);
                setData((current) => ({ ...current, planConfirmed: false }));
              }}
            />
            <Text size={200} className={styles.hint}>{t('wizard.s05.nucleiToggleHint')}</Text>
          </div>
          <div className={styles.pathCard}>
            <Text weight="semibold">{t('wizard.s05.workflowTitle')}</Text>
            <Text size={200} className={styles.hint}>
              {t(workflowScanEligible ? 'wizard.s05.workflowEnabled' : 'wizard.s05.workflowUnavailable')}
            </Text>
            {workflowPlanStep?.engineVersion !== undefined && (
              <Text size={200} className={styles.hint}>
                {t('wizard.s05.workflowCatalog', { catalog: workflowPlanStep.engineVersion })}
              </Text>
            )}
          </div>
          <div className={styles.pathCard}>
            <Switch
              checked={excludeLowAndInfo}
              label={t('wizard.s05.excludeLowInfo')}
              onChange={(_event, state) => setExcludeLowAndInfo(state.checked)}
            />
            <Text size={200} className={styles.hint}>{t('wizard.s05.excludeLowInfoHint')}</Text>
          </div>
          <Text>{t('wizard.s05.purpose')}</Text>
          <Text>{t('wizard.s05.targets', { targets: data.selectedTargets.length, maxRequests: scanPlan.plan.limits.maxRequests })}</Text>
          <Text>{t('wizard.s05.forbidden')}</Text>
          <section className={styles.planGroup}>
            <Text size={400} weight="semibold">{t('wizard.s05.requestCorpus')}</Text>
            <Text className={styles.hint}>{t('wizard.s05.requestCorpusHint')}</Text>
            <div className={styles.planTargets}>
              {adoptedCandidates.map((candidate) => (
                <div className={styles.planTarget} key={`request:${candidate.candidateId}`}>
                  <Text weight="semibold">{candidate.method.toUpperCase()}</Text>
                  <div className={styles.candidateBody}>
                    <Text className={styles.candidateUrl}>{candidate.url}</Text>
                    <Text size={200} className={styles.hint}>{t('wizard.s04.inputPoints', {
                      points: candidate.inputPoints?.map((point) => `${point.location}:${point.name}`).join(', ') || t('wizard.s04.noInputPoints'),
                    })}</Text>
                    {candidate.contentType !== undefined && <Text size={200} className={styles.hint}>{t('wizard.s04.contentType', { contentType: candidate.contentType })}</Text>}
                    <Text size={200} className={styles.hint}>{t('wizard.s04.diagnosticTracks', {
                      tracks: candidate.diagnosticTracks?.join(', ') || 'zap-active',
                    })}</Text>
                  </div>
                </div>
              ))}
            </div>
          </section>
          {scanPlan.plan.steps.map((planStep) => (
            <section className={styles.planGroup} key={planStep.stepId}>
              <div className={styles.summaryRow}>
                <Text size={400} weight="semibold">{planStep.engineKind.toUpperCase()} — {planInspectionLabel(planStep)}</Text>
                <span className={styles.badge}>{planStep.guarantee}</span>
              </div>
              <Text className={styles.hint}>{t('wizard.s05.engineDetails', {
                version: planStep.engineVersion ?? '-',
                requests: planStep.limits.maxRequests,
                concurrency: planStep.limits.maxConcurrency,
                rate: planStep.limits.requestsPerSecond,
                minutes: planStep.limits.maxDurationMinutes,
              })}</Text>
              {planStep.guarantee === 'Delegated' && <Text className={styles.hint}>{t('wizard.s05.delegatedWarning')}</Text>}
              <div className={styles.planTargets}>
                {planStep.targetSnapshot.map((target) => (
                  <div className={styles.planTarget} key={`${planStep.stepId}:${target}`}>
                    <Text weight="semibold">{planStep.engineKind.toUpperCase()}</Text>
                    <div className={styles.candidateBody}>
                      <Text className={styles.candidateUrl}>{target}</Text>
                      <Text size={200} className={styles.hint}>{planInspectionLabel(planStep)}</Text>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {interactiveCandidates.length > 0 && (
            <section className={styles.planGroup}>
              <Text size={400} weight="semibold">{t('wizard.s05.interactiveTitle')}</Text>
              <Text className={styles.hint}>{t('wizard.s05.interactiveHint', { count: interactiveCandidates.length })}</Text>
              <Field label={t('wizard.s05.interactiveInstruction')} required>
                <Textarea
                  resize="vertical"
                  rows={5}
                  value={interactiveInstruction}
                  placeholder={t('wizard.s05.interactivePlaceholder')}
                  onChange={(_event, value) => {
                    setInteractiveInstruction(value.value);
                    setInteractivePlan(null);
                    setInteractivePlanConfirmed(false);
                    setInteractiveResults([]);
                  }}
                />
              </Field>
              <div className={styles.inlineActions}>
                <Button disabled={busy || interactiveInstruction.trim() === ''} onClick={() => void planInteractiveDiagnostics()}>
                  {t('wizard.s05.interactiveBuild')}
                </Button>
                {interactiveStatus !== '' && <Text role="status">{interactiveStatus}</Text>}
              </div>
              {interactivePlan !== null && (
                <>
                  <Text weight="semibold">{interactivePlan.summary}</Text>
                  {interactivePlan.warnings.map((warning) => <Text key={warning} className={styles.hint}>⚠ {warning}</Text>)}
                  <div className={styles.planTargets}>
                    {interactivePlan.items.map((item) => (
                      <div className={styles.pathCard} key={item.itemId}>
                        <div className={styles.summaryRow}>
                          <Text weight="semibold">{item.track}</Text>
                          <span className={styles.badge}>{item.role || 'unauthenticated'}</span>
                        </div>
                        <Text>{item.summary}</Text>
                        <Text className={styles.candidateUrl}>{item.targetUrl}</Text>
                        {item.roles.length > 0 && <Text className={styles.hint}>{t('wizard.s05.interactiveRoles', { roles: item.roles.join(', ') })}</Text>}
                        {item.steps.map((planStep, index) => (
                          <pre className={styles.command} key={`${item.itemId}:${index}`}>
                            {`${index + 1}. ${planStep.kind} ${planStep.target}${'value' in planStep ? ` = ${planStep.value}` : ''}${'inputRef' in planStep ? ` <${planStep.inputRef}>` : ''}`}
                          </pre>
                        ))}
                      </div>
                    ))}
                  </div>
                  {interactivePlan.items.some((item) => item.requiredInputs.includes('upload-file')) && (
                    <div className={styles.pathRow}>
                      <div className={styles.pathDetails}>
                        <Text weight="semibold">{t('wizard.s05.uploadInput')}</Text>
                        <Text className={styles.pathValue}>{interactiveUpload?.name ?? t('wizard.s05.notSelected')}</Text>
                      </div>
                      <Button onClick={() => void selectInteractiveUpload()}>{t('wizard.s05.selectFile')}</Button>
                    </div>
                  )}
                  {interactivePlan.items.some((item) => item.requiredInputs.includes('api-spec')) && (
                    <div className={styles.pathRow}>
                      <div className={styles.pathDetails}>
                        <Text weight="semibold">{t('wizard.s05.apiSpecInput')}</Text>
                        <Text className={styles.pathValue}>{interactiveApiSpec?.name ?? t('wizard.s05.notSelected')}</Text>
                      </div>
                      <Button onClick={() => void selectInteractiveApiSpec()}>{t('wizard.s05.selectFile')}</Button>
                    </div>
                  )}
                  <Button
                    appearance={interactivePlanConfirmed ? 'secondary' : 'primary'}
                    onClick={() => setInteractivePlanConfirmed((current) => !current)}
                  >
                    {interactivePlanConfirmed ? t('wizard.s05.interactiveConfirmed') : t('wizard.s05.interactiveConfirm')}
                  </Button>
                </>
              )}
            </section>
          )}
          <Text className={styles.hint}>{t('wizard.s05.finalNote')}</Text>
        </>
      )}

      {step === 'S05' && scanPlan === null && (
        <>
          <Text id="wizard-S05-title" size={400} weight="semibold">{t('wizard.s05.title')}</Text>
          <div className={styles.pathCard}>
            <Switch
              checked={nucleiEnabled}
              label={t('wizard.s05.nucleiToggle')}
              onChange={(_event, state) => setNucleiEnabled(state.checked)}
            />
            <Text size={200} className={styles.hint}>{t('wizard.s05.nucleiToggleHint')}</Text>
          </div>
          <div className={styles.pathCard}>
            <Text weight="semibold">{t('wizard.s05.workflowTitle')}</Text>
            <Text size={200} className={styles.hint}>
              {t(workflowScanEligible ? 'wizard.s05.workflowEnabled' : 'wizard.s05.workflowUnavailable')}
            </Text>
          </div>
          <div className={styles.pathCard}>
            <Switch
              checked={excludeLowAndInfo}
              label={t('wizard.s05.excludeLowInfo')}
              onChange={(_event, state) => setExcludeLowAndInfo(state.checked)}
            />
            <Text size={200} className={styles.hint}>{t('wizard.s05.excludeLowInfoHint')}</Text>
          </div>
          <Button appearance="primary" disabled={busy} onClick={() => void prepareScanPlan()}>
            {t('wizard.s05.build')}
          </Button>
        </>
      )}

      {step === 'S06' && (
        <>
          <Text id="wizard-S06-title" size={400} weight="semibold">{t('wizard.s06.title')}</Text>
          <div className={styles.pathCard}>
            <Switch
              checked={excludeLowAndInfo}
              label={t('wizard.s05.excludeLowInfo')}
              onChange={(_event, state) => setExcludeLowAndInfo(state.checked)}
            />
            <Text size={200} className={styles.hint}>{t('wizard.s05.excludeLowInfoHint')}</Text>
          </div>
          {scanExecution !== null && (
            <div className={styles.consolePanel}>
              <div className={styles.summaryRow}>
                <Text weight="semibold">{t('wizard.s06.state', { state: scanExecution.dispatchState === 'queued' ? t('run.dispatch.queued') : t(`run.state.${scanExecution.runState}`), engine: scanExecution.currentEngine.toUpperCase() })}</Text>
                <Text>{scanExecution.progress}%</Text>
              </div>
              <ProgressBar value={scanExecution.progress / 100} thickness="medium" />
              <Text weight="semibold">{t('wizard.s06.currentCommand')}</Text>
              <pre className={styles.command}>{scanExecution.currentCommand || t('wizard.s06.waitingCommand')}</pre>
              <div className={styles.summaryRow}>
                <Text weight="semibold">{t('wizard.s06.log')}</Text>
                {(scanExecution.state === 'Confirmed' || scanExecution.state === 'Running') && (
                  <Button appearance="primary" onClick={() => void stopScan()}>{t('wizard.s06.stop')}</Button>
                )}
                {scanExecution.state === 'Stopping' && <Button disabled>{t('wizard.s06.stopping')}</Button>}
              </div>
              <pre className={styles.executionLog} aria-live="polite">{scanExecution.logs.join('\n')}</pre>
            </div>
          )}
          {data.runFinished ? (
            <>
              <Text role="status">{runSummary}</Text>
              {excludeLowAndInfo && (
                <Text role="status">{t('wizard.s06.filteredSummary', {
                  visible: visibleFindings.length,
                  excluded: findings.length - visibleFindings.length,
                })}</Text>
              )}
              {(scanExecution?.result?.diagnosticRoutes?.length ?? 0) > 0 && (
                <div className={styles.pathCard}>
                  <Text weight="semibold">{t('wizard.s06.diagnosticRoutes')}</Text>
                  {scanExecution?.result?.diagnosticRoutes?.map((route) => (
                    <Text key={`${route.track}:${route.targetUrl}`} className={styles.hint}>
                      {t('wizard.s06.diagnosticRoute', {
                        track: route.track,
                        status: route.status,
                        url: route.targetUrl,
                        detail: route.detail,
                      })}
                    </Text>
                  ))}
                </div>
              )}
              {(scanExecution?.result?.guidelineRoutes?.length ?? 0) > 0 && (
                <div className={styles.pathCard}>
                  <Text weight="semibold">{t('wizard.s06.guidelineRoutes')}</Text>
                  {scanExecution?.result?.guidelineRoutes?.map((route) => (
                    <Text key={route.routeId} className={styles.hint}>
                      {t('wizard.s06.guidelineRoute', {
                        route: route.routeId,
                        status: route.status,
                        guidelines: route.guidelineIds.join(', '),
                        detail: route.detail,
                      })}
                    </Text>
                  ))}
                </div>
              )}
              {interactiveStatus !== '' && <Text role="status">{interactiveStatus}</Text>}
              {interactiveResults.map((result) => (
                <Text key={result.itemId} className={styles.hint}>
                  {t('wizard.s06.interactiveResult', { status: result.status, track: result.track, url: result.targetUrl, detail: result.detail })}
                </Text>
              ))}
              {interactivePlan !== null && interactivePlanConfirmed && interactiveResults.length === 0 && (
                <Button disabled={busy} onClick={() => void retryInteractiveDiagnostics()}>{t('wizard.s06.retryInteractive')}</Button>
              )}
              {visibleFindings.map((finding) => (
                <Text key={finding.findingId} className={styles.hint}>
                  {t('wizard.s06.finding', {
                    severity: finding.severity,
                    title: finding.title,
                    url: finding.url,
                    occurrences: finding.occurrences,
                    unverified: finding.source.unverified ? t('wizard.s06.unverified') : '',
                  })}
                </Text>
              ))}
            </>
          ) : (
            <Button appearance="primary" disabled={busy || (interactivePlan !== null && !interactivePlanConfirmed)} onClick={() => void runScan()}>
              {t('wizard.s06.run')}
            </Button>
          )}
        </>
      )}

      {step === 'S07' && (
        <>
          <Text id="wizard-S07-title" size={400} weight="semibold">{t('wizard.s07.title')}</Text>
          <Text className={styles.hint}>{t('wizard.s07.profileHint')}</Text>
          <div className={styles.pathCard}>
            <Text weight="semibold">{t('wizard.s07.profileTitle')}</Text>
            <div className={styles.formGrid}>
              <Field label={t('wizard.s07.systemName')}>
                <Input value={reportProfile.systemName} onChange={(_event, state) => setReportProfile((current) => ({ ...current, systemName: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.clientName')}>
                <Input value={reportProfile.clientName} onChange={(_event, state) => setReportProfile((current) => ({ ...current, clientName: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.serviceProvider')}>
                <Input value={reportProfile.serviceProvider} onChange={(_event, state) => setReportProfile((current) => ({ ...current, serviceProvider: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.version')}>
                <Input value={reportProfile.version} onChange={(_event, state) => setReportProfile((current) => ({ ...current, version: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.documentStatus')}>
                <Input value={reportProfile.documentStatus} onChange={(_event, state) => setReportProfile((current) => ({ ...current, documentStatus: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.classification')}>
                <Input value={reportProfile.classification} onChange={(_event, state) => setReportProfile((current) => ({ ...current, classification: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.author')}>
                <Input value={reportProfile.author} onChange={(_event, state) => setReportProfile((current) => ({ ...current, author: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.reviewer')}>
                <Input value={reportProfile.reviewer} onChange={(_event, state) => setReportProfile((current) => ({ ...current, reviewer: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.approver')}>
                <Input value={reportProfile.approver} onChange={(_event, state) => setReportProfile((current) => ({ ...current, approver: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.assessmentType')}>
                <Input value={reportProfile.assessmentType} onChange={(_event, state) => setReportProfile((current) => ({ ...current, assessmentType: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.sourceIps')} hint={t('wizard.s01.onePerLine')}>
                <Textarea value={reportProfile.sourceIps} resize="vertical" onChange={(_event, state) => setReportProfile((current) => ({ ...current, sourceIps: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.distribution')} hint={t('wizard.s01.onePerLine')}>
                <Textarea value={reportProfile.distribution} resize="vertical" onChange={(_event, state) => setReportProfile((current) => ({ ...current, distribution: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.exclusions')} hint={t('wizard.s01.onePerLine')}>
                <Textarea value={reportProfile.exclusions} resize="vertical" onChange={(_event, state) => setReportProfile((current) => ({ ...current, exclusions: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.assumptions')} hint={t('wizard.s01.onePerLine')}>
                <Textarea value={reportProfile.assumptions} resize="vertical" onChange={(_event, state) => setReportProfile((current) => ({ ...current, assumptions: state.value }))} />
              </Field>
              <Field className={styles.fullField} label={t('wizard.s07.conclusion')}>
                <Textarea value={reportProfile.conclusion} resize="vertical" onChange={(_event, state) => setReportProfile((current) => ({ ...current, conclusion: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.priorities')} hint={t('wizard.s01.onePerLine')}>
                <Textarea value={reportProfile.priorities} resize="vertical" onChange={(_event, state) => setReportProfile((current) => ({ ...current, priorities: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.majorLimitations')} hint={t('wizard.s01.onePerLine')}>
                <Textarea value={reportProfile.majorLimitations} resize="vertical" onChange={(_event, state) => setReportProfile((current) => ({ ...current, majorLimitations: state.value }))} />
              </Field>
              <Field className={styles.fullField} label={t('wizard.s07.contact')}>
                <Input value={reportProfile.contact} onChange={(_event, state) => setReportProfile((current) => ({ ...current, contact: state.value }))} />
              </Field>
              <Field label={t('wizard.s07.evidenceBodyMode')} hint={t('wizard.s07.evidenceBodyModeHint')}>
                <Select
                  value={reportProfile.evidenceBodyMode}
                  onChange={(event) => setReportProfile((current) => ({
                    ...current,
                    evidenceBodyMode: event.target.value as RendererReportProfile['evidenceBodyMode'],
                  }))}
                >
                  <option value="relevant">{t('wizard.s07.evidenceBodyRelevant')}</option>
                  <option value="omit">{t('wizard.s07.evidenceBodyOmit')}</option>
                  <option value="full">{t('wizard.s07.evidenceBodyFull')}</option>
                </Select>
              </Field>
              <div className={styles.fullField}>
                <Switch
                  checked={reportProfile.highlightEvidence}
                  label={t('wizard.s07.highlightEvidence')}
                  onChange={(_event, state) => setReportProfile((current) => ({ ...current, highlightEvidence: state.checked }))}
                />
                <Text size={200} className={styles.hint}>{t('wizard.s07.highlightEvidenceHint')}</Text>
              </div>
            </div>
          </div>
          {reportContent === '' ? (
            <Button appearance="primary" disabled={busy} onClick={() => void buildReport()}>
              {t('wizard.s07.generate')}
            </Button>
          ) : (
            <>
              <Text role="status">{reportFiles === null ? t('wizard.s07.saving') : t('wizard.s07.saved', { path: reportFiles.wordPath })}</Text>
              <Text className={styles.hint}>{reportAiStatus || t('wizard.s07.generationDisclosure', { provider: aiProvider })}</Text>
              {reportFiles !== null && (
                <div className={styles.inlineActions}>
                  <Button onClick={() => void openSelectedPath(reportFiles.wordPath)}>{t('wizard.s07.openWord')}</Button>
                  <Button onClick={() => void openSelectedPath(reportFiles.technicalAnnexHtmlPath)}>{t('wizard.s07.openTechnicalAnnex')}</Button>
                  <Button onClick={() => void openSelectedPath(reportFiles.markdownPath)}>{t('wizard.s07.openMarkdown')}</Button>
                  <Button onClick={() => void openSelectedPath(reportFiles.structuredJsonPath)}>{t('wizard.s07.openStructuredJson')}</Button>
                  <Button onClick={() => void openSelectedPath(reportFiles.manifestPath)}>{t('wizard.s07.openManifest')}</Button>
                </div>
              )}
              <pre className={styles.report}>{reportContent}</pre>
            </>
          )}
        </>
      )}

          </div>
          <footer className={styles.actions}>
            <Button disabled={!backResult.ok} onClick={() => {
              if (backResult.ok) {
                setStep(backResult.previous);
              }
            }}>
              {t('wizard.nav.back')}
            </Button>
            <Button
              appearance="primary"
              disabled={!advanceResult.ok || busy}
              onClick={() => {
                if (advanceResult.ok) {
                  setStep(advanceResult.next);
                }
              }}
            >
              {t('wizard.nav.next')} {!advanceResult.ok && step !== 'S07' ? t('wizard.nav.nextBlocked') : ''}
            </Button>
          </footer>
        </section>
      </div>
    </div>
  );
}
