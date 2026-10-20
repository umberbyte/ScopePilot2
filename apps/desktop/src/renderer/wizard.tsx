/**
 * Simple wizard 画面 (S01〜S07)。`docs/detailed-design/02-ui-information-architecture.md` §2。
 * S02 はガイドライン選択のみ、S03 の crawl 上限は表示専用。進行は wizard-state の判定のみを使う。
 * S04〜S07 は次増分で接続する (この file では案内のみ)。
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  Field,
  Input,
  MessageBar,
  ProgressBar,
  Select,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { executionSummary } from '@scopepilot2/ui';
import { t } from './resources.ts';
import { parseHttpOriginInput } from './origin-input.ts';
import {
  advance,
  goBack,
  initialWizardData,
  STEP_LABELS,
  WIZARD_STEPS,
  type WizardData,
  type WizardStep,
} from '@scopepilot2/ui';

/** catalog (`docs/generated/guideline-catalog.json`) のガイドライン 6 sheet 名。 */
const GUIDELINES: readonly string[] = [
  'OWASP Top 10-2025',
  'OWASP ASVS 5.0',
  'OWASP WSTG 4.2',
  'OWASP AISVS 1.01',
  'OWASP CNAS Top 10',
  'デジタル庁 DS-221',
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
}

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
  const [caseDirectory, setCaseDirectory] = useState<SelectedDesktopPath | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<'create' | 'open'>('create');
  const [materialFiles, setMaterialFiles] = useState<readonly SelectedDesktopPath[]>([]);
  const [startUrl, setStartUrl] = useState('');
  const [allowedOrigins, setAllowedOrigins] = useState('');
  const [supportingOrigins, setSupportingOrigins] = useState('');
  const [targetRoles, setTargetRoles] = useState('unauthenticated');
  const [forbiddenActions, setForbiddenActions] = useState('削除\n購入・決済\n認証情報の変更');
  const [aiProvider, setAiProvider] = useState<'zcode' | 'codex' | 'claude'>('codex');
  const [aiModel, setAiModel] = useState('');
  const [exploreSummary, setExploreSummary] = useState<string>('');
  const [candidates, setCandidates] = useState<readonly { candidateId: string; url: string; method: string }[]>([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<readonly string[]>([]);
  const [scanPlan, setScanPlan] = useState<{ plan: { steps: readonly unknown[]; limits: { maxRequests: number } } } | null>(null);
  const [scanConfirmation, setScanConfirmation] = useState<{ confirmationId: string } | null>(null);
  const [runSummary, setRunSummary] = useState('');
  const [findings, setFindings] = useState<readonly { findingId: string; title: string; severity: string; url: string; occurrences: number; source: { unverified: boolean; engineVersion?: string } }[]>([]);
  const [reportContent, setReportContent] = useState('');
  const [reportFiles, setReportFiles] = useState<{ markdownPath: string; wordPath: string } | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState('');
  const [reportAiStatus, setReportAiStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');

  const progress = useMemo(() => (WIZARD_STEPS.indexOf(step) + 1) / WIZARD_STEPS.length, [step]);
  const stepIndex = WIZARD_STEPS.indexOf(step);

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
        setAnalysisStatus('');
        setData((current) => ({ ...current, caseOpened: false }));
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const selectMaterialFiles = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const selections = await window.scopepilotDesktop?.selectMaterialFiles();
      if (selections === undefined) {
        throw new Error(t('wizard.s01.bridgeMissing'));
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
  }, []);

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
      let parsedStart: URL;
      try {
        parsedStart = new URL(startUrl);
      } catch {
        throw new Error(t('wizard.s01.startUrlInvalid'));
      }
      if (!['http:', 'https:'].includes(parsedStart.protocol)) throw new Error(t('wizard.s01.startUrlInvalid'));
      const enteredAllowed = parseHttpOriginInput(allowedOrigins);
      if (enteredAllowed.invalidEntries.length > 0) throw new Error(t('wizard.s01.originInvalid', { value: enteredAllowed.invalidEntries.join(', ') }));
      if (enteredAllowed.origins.length === 0) throw new Error(t('wizard.s01.allowedOriginsRequired'));
      if (!enteredAllowed.origins.includes(parsedStart.origin)) throw new Error(t('wizard.s01.startOriginRequired', { origin: parsedStart.origin }));
      const enteredSupporting = parseHttpOriginInput(supportingOrigins);
      if (enteredSupporting.invalidEntries.length > 0) throw new Error(t('wizard.s01.originInvalid', { value: enteredSupporting.invalidEntries.join(', ') }));
      const activated = await bridge.activateCaseWorkspace({
        directory: caseDirectory.path,
        mode: workspaceMode,
        materialPaths: materialFiles.map((file) => file.path),
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
      const record = activated.existingCase ?? await callApi<{ name: string }>(apiBase, 'POST', '/api/case', {
        name: caseDirectory.name,
        allowedOrigins: effectiveAllowed,
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      });
      const now = Date.now();
      await callApi(apiBase, 'POST', '/api/authorization', {
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: effective.targetRoles.length === 0 ? ['unauthenticated'] : effective.targetRoles,
        validFrom: new Date(now - 60_000).toISOString(),
        validUntil: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
        evidenceLabel: '案件資料に基づく認可 (デスクトップ)',
        evidenceContent: JSON.stringify({ inputHashes: activated.inputs.map((input) => input.sha256) }),
      });
      setCaseName(record.name);
      setData((current) => ({ ...current, caseOpened: true }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [aiModel, aiProvider, allowedOrigins, apiBase, caseDirectory, forbiddenActions, materialFiles, startUrl, supportingOrigins, targetRoles, workspaceMode]);

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
    setBusy(true);
    setError('');
    try {
      const plan = await callApi<{ plan: unknown }>(apiBase, 'POST', '/api/plan/explore', {
        seeds: [startUrl],
      });
      const confirmation = await callApi<{ confirmationId: string }>(apiBase, 'POST', '/api/plan/confirm', { plan: plan.plan });
      const run = await callApi<{ observations: readonly unknown[]; candidates: readonly { candidateId: string; url: string; method: string }[] }>(apiBase, 'POST', '/api/run/explore', {
        plan: plan.plan,
        confirmation,
        maxDepth: 5,
      });
      setCandidates(run.candidates);
      setExploreSummary(t('wizard.s03.done', { observations: run.observations.length, candidates: run.candidates.length }));
      setData((current) => ({ ...current, explorationDone: true }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, startUrl]);

  const adoptTargets = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const selected = candidates.filter((candidate) => selectedCandidateIds.includes(candidate.candidateId));
      const result = await callApi<{ adopted: readonly { candidateId: string; url: string; method: string }[] }>(apiBase, 'POST', '/api/candidates/adopt', { candidates: selected });
      setData((current) => ({ ...current, selectedTargets: result.adopted.map((entry) => entry.url) }));
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
      const plan = await callApi<{ plan: { steps: readonly unknown[]; limits: { maxRequests: number } } }>(apiBase, 'POST', '/api/plan/scan', { targets: data.selectedTargets });
      const confirmation = await callApi<{ confirmationId: string }>(apiBase, 'POST', '/api/plan/confirm', { plan: plan.plan });
      setScanPlan(plan);
      setScanConfirmation(confirmation);
      setData((current) => ({ ...current, planConfirmed: true }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, data.selectedTargets]);

  const runScan = useCallback(async () => {
    if (scanPlan === null || scanConfirmation === null) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const adopted = data.selectedTargets.map((url, index) => ({ candidateId: `cand-${index}`, url, method: 'GET', category: 'page', guidelineBasis: ['provisional:page'], confidence: 0.7, observationUrl: url }));
      const run = await callApi<{ findings: readonly { findingId: string; title: string; severity: string; url: string; occurrences: number; source: { unverified: boolean; engineVersion?: string } }[]; engineVersion: string; overshootReservation: number }>(apiBase, 'POST', '/api/run/scan', {
        plan: scanPlan.plan,
        confirmation: scanConfirmation,
        adopted,
      });
      await callApi(apiBase, 'POST', '/api/import/nuclei', { engineVersion: run.engineVersion, lines: [] });
      setFindings(run.findings);
      setRunSummary(t('wizard.s06.done', { engineVersion: run.engineVersion, overshoot: run.overshootReservation, findings: run.findings.length }));
      setData((current) => ({ ...current, runFinished: true }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, data.selectedTargets, scanPlan, scanConfirmation]);

  const buildReport = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const report = await callApi<{ content: string; modelHash: string }>(apiBase, 'POST', '/api/report', { guidelines: data.selectedGuidelines });
      const bridge = window.scopepilotDesktop;
      if (bridge === undefined) throw new Error(t('wizard.s01.bridgeMissing'));
      let content = report.content;
      let modelHash = report.modelHash;
      try {
        const drafted = await bridge.generateAiReport({ baseContent: report.content, baseModelHash: report.modelHash, guidelines: data.selectedGuidelines });
        content = drafted.content;
        modelHash = drafted.modelHash;
        setReportAiStatus(t('wizard.s07.aiGenerated', { provider: drafted.provider, model: drafted.model }));
      } catch (cause) {
        setReportAiStatus(t('wizard.s07.aiFallback', { message: String(cause) }));
      }
      const saved = await bridge.saveReport({ content, modelHash });
      setReportFiles(saved);
      setReportContent(content);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, data.selectedGuidelines]);

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
                <Select value={aiProvider} onChange={(event) => setAiProvider(event.target.value as 'zcode' | 'codex' | 'claude')}>
                  <option value="zcode">zcode</option>
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </Select>
              </Field>
              <Field label={t('wizard.s01.aiModel')} hint={t('wizard.s01.aiModelHint')}>
                <Input value={aiModel} onChange={(_event, state) => setAiModel(state.value)} />
              </Field>
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
                  </div>
                ))}
              </div>
            )}
          </div>

          {data.caseOpened ? (
            <>
              <Text role="status">{t('wizard.s01.opened', { caseName })}</Text>
              {materialFiles.length > 0 && (
                <Button disabled={busy} onClick={() => void analyzeMaterials()}>
                  {t('wizard.s01.analyzeMaterials', { provider: aiProvider })}
                </Button>
              )}
              {analysisStatus !== '' && <Text role="status" className={styles.hint}>{analysisStatus}</Text>}
            </>
          ) : (
            <Button appearance="primary" disabled={busy || caseDirectory === null} onClick={() => void openCase()}>
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
          <div className={styles.choiceList}>
            {candidates.map((candidate) => (
              <Checkbox
                key={candidate.candidateId}
                label={`${candidate.method} ${candidate.url}`}
                checked={selectedCandidateIds.includes(candidate.candidateId)}
                onChange={(_event, state) => {
                  setSelectedCandidateIds((current) =>
                    state.checked === true
                      ? [...current, candidate.candidateId]
                      : current.filter((entry) => entry !== candidate.candidateId),
                  );
                }}
              />
            ))}
          </div>
          <Button appearance="primary" disabled={busy || selectedCandidateIds.length === 0} onClick={() => void adoptTargets()}>
            {t('wizard.s04.adopt', { count: selectedCandidateIds.length })}
          </Button>
        </>
      )}

      {step === 'S05' && scanPlan !== null && (
        <>
          <Text id="wizard-S05-title" size={400} weight="semibold">{t('wizard.s05.title')}</Text>
          <Text>{t('wizard.s05.purpose')}</Text>
          <Text>{t('wizard.s05.targets', { targets: data.selectedTargets.length, maxRequests: scanPlan.plan.limits.maxRequests })}</Text>
          <Text>{t('wizard.s05.forbidden')}</Text>
          {executionSummary(scanPlan.plan.steps as never).map((row) => (
            <Text key={row.stepId} className={styles.hint}>
              {row.kind}: {row.label}
            </Text>
          ))}
          <Text className={styles.hint}>{t('wizard.s05.finalNote')}</Text>
        </>
      )}

      {step === 'S05' && scanPlan === null && (
        <>
          <Text id="wizard-S05-title" size={400} weight="semibold">{t('wizard.s05.title')}</Text>
          <Button appearance="primary" disabled={busy} onClick={() => void prepareScanPlan()}>
            {t('wizard.s05.build')}
          </Button>
        </>
      )}

      {step === 'S06' && (
        <>
          <Text id="wizard-S06-title" size={400} weight="semibold">{t('wizard.s06.title')}</Text>
          {data.runFinished ? (
            <>
              <Text role="status">{runSummary}</Text>
              {findings.map((finding) => (
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
            <Button appearance="primary" disabled={busy} onClick={() => void runScan()}>
              {t('wizard.s06.run')}
            </Button>
          )}
        </>
      )}

      {step === 'S07' && (
        <>
          <Text id="wizard-S07-title" size={400} weight="semibold">{t('wizard.s07.title')}</Text>
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
                  <Button onClick={() => void openSelectedPath(reportFiles.markdownPath)}>{t('wizard.s07.openMarkdown')}</Button>
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
