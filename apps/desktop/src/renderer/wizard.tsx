/**
 * Simple wizard 画面 (S01〜S07)。`docs/detailed-design/02-ui-information-architecture.md` §2。
 * S02 はガイドライン選択のみ、S03 の crawl 上限は表示専用。進行は wizard-state の判定のみを使う。
 * S04〜S07 は次増分で接続する (この file では案内のみ)。
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  ProgressBar,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { executionSummary } from '@scopepilot2/ui';
import { t } from './resources.ts';
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
  root: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', maxWidth: '760px' },
  steps: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
  stepBadge: { padding: '2px 8px', borderRadius: '4px', backgroundColor: tokens.colorNeutralBackground3 },
  stepActive: { fontWeight: 600, backgroundColor: tokens.colorBrandBackground2 },
  actions: { display: 'flex', gap: '8px', justifyContent: 'space-between' },
  hint: { color: tokens.colorNeutralForeground3 },
});

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
  const [exploreSummary, setExploreSummary] = useState<string>('');
  const [candidates, setCandidates] = useState<readonly { candidateId: string; url: string; method: string }[]>([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<readonly string[]>([]);
  const [scanPlan, setScanPlan] = useState<{ plan: { steps: readonly unknown[]; limits: { maxRequests: number } } } | null>(null);
  const [scanConfirmation, setScanConfirmation] = useState<{ confirmationId: string } | null>(null);
  const [runSummary, setRunSummary] = useState('');
  const [findings, setFindings] = useState<readonly { findingId: string; title: string; severity: string; url: string; occurrences: number; source: { unverified: boolean; engineVersion?: string } }[]>([]);
  const [reportContent, setReportContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');

  const progress = useMemo(() => (WIZARD_STEPS.indexOf(step) + 1) / WIZARD_STEPS.length, [step]);

  const openCase = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const record = await callApi<{ name: string }>(apiBase, 'POST', '/api/case', {
        name: 'ScopePilot2 案件',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      });
      await callApi(apiBase, 'POST', '/api/authorization', {
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['unauthenticated'],
        validFrom: '2026-10-18T00:00:00.000Z',
        validUntil: '2026-10-19T00:00:00.000Z',
        evidenceLabel: '認可 (デスクトップ)',
        evidenceContent: 'desktop wizard evidence',
      });
      setCaseName(record.name);
      setData((current) => ({ ...current, caseOpened: true }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase]);

  const runExploration = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const plan = await callApi<{ plan: unknown }>(apiBase, 'POST', '/api/plan/explore', {
        seeds: ['http://fixture.target.test/'],
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
  }, [apiBase]);

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
      setReportContent(report.content);
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
      <div className={styles.steps}>
        {WIZARD_STEPS.map((entry) => (
          <span key={entry} className={`${styles.stepBadge} ${entry === step ? styles.stepActive : ''}`}>
            {entry} {STEP_LABELS[entry]}
          </span>
        ))}
      </div>
      <ProgressBar value={progress} />
      {error !== '' && <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>}

      {step === 'S01' && (
        <>
          <Text size={400}>{STEP_LABELS.S01}</Text>
          {data.caseOpened ? (
            <Text role="status">{t('wizard.s01.opened', { caseName })}</Text>
          ) : (
            <Button appearance="primary" disabled={busy} onClick={() => void openCase()}>
              {t('wizard.s01.openCase')}
            </Button>
          )}
        </>
      )}

      {step === 'S02' && (
        <>
          <Text size={400}>{t('wizard.s02.title')}</Text>
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
        </>
      )}

      {step === 'S03' && (
        <>
          <Text size={400}>{t('wizard.s03.title')}</Text>
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
          <Text size={400}>{t('wizard.s04.title')}</Text>
          <Text className={styles.hint}>{t('wizard.s04.hint')}</Text>
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
          <Button appearance="primary" disabled={busy || selectedCandidateIds.length === 0} onClick={() => void adoptTargets()}>
            {t('wizard.s04.adopt', { count: selectedCandidateIds.length })}
          </Button>
        </>
      )}

      {step === 'S05' && scanPlan !== null && (
        <>
          <Text size={400}>{t('wizard.s05.title')}</Text>
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
          <Text size={400}>{t('wizard.s05.title')}</Text>
          <Button appearance="primary" disabled={busy} onClick={() => void prepareScanPlan()}>
            {t('wizard.s05.build')}
          </Button>
        </>
      )}

      {step === 'S06' && (
        <>
          <Text size={400}>{t('wizard.s06.title')}</Text>
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
          <Text size={400}>{t('wizard.s07.title')}</Text>
          {reportContent === '' ? (
            <Button appearance="primary" disabled={busy} onClick={() => void buildReport()}>
              {t('wizard.s07.generate')}
            </Button>
          ) : (
            <Text style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{reportContent}</Text>
          )}
        </>
      )}

      <div className={styles.actions}>
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
      </div>
    </div>
  );
}
