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

const DEFAULT_EXPLORE_LIMITS = '上限 (既定・表示専用): 500 ページ / 2 req/s / 30 分 / 深さ 5';

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
      setExploreSummary(`探索完了: ${run.observations.length} 件を観測、診断候補 ${run.candidates.length} 件を生成`);
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
      setRunSummary(`診断完了 (engine ${run.engineVersion}・overshoot 予約 ${run.overshootReservation} 件分): 所見 ${run.findings.length} 件`);
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
          <Text size={400}>S01 案件を開く</Text>
          {data.caseOpened ? (
            <Text role="status">案件「{caseName}」を開きました。</Text>
          ) : (
            <Button appearance="primary" disabled={busy} onClick={() => void openCase()}>
              案件を開く (fixture)
            </Button>
          )}
        </>
      )}

      {step === 'S02' && (
        <>
          <Text size={400}>S02 ガイドライン選択</Text>
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
          <Text size={400}>S03 認証準備・探索開始</Text>
          <Text className={styles.hint}>{DEFAULT_EXPLORE_LIMITS}</Text>
          {data.explorationDone ? (
            <Text role="status">{exploreSummary}</Text>
          ) : (
            <Button appearance="primary" disabled={busy} onClick={() => void runExploration()}>
              探索を開始する
            </Button>
          )}
        </>
      )}

      {step === 'S04' && (
        <>
          <Text size={400}>S04 探索結果から対象選定</Text>
          <Text className={styles.hint}>観測された候補から診断対象を選んでください (全選択可)。</Text>
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
            選択を採用する ({selectedCandidateIds.length} 件)
          </Button>
        </>
      )}

      {step === 'S05' && scanPlan !== null && (
        <>
          <Text size={400}>S05 実行計画の最終確認</Text>
          <Text>送信目的: 探索結果に対する能動診断 (ZAP 委譲)。</Text>
          <Text>対象: {data.selectedTargets.length} 件 / 概算通信数上限: {scanPlan.plan.limits.maxRequests} 件</Text>
          <Text>禁止操作: 本案件では破壊的操作・認証情報変更を禁止します。</Text>
          {executionSummary(scanPlan.plan.steps as never).map((row) => (
            <Text key={row.stepId} className={styles.hint}>
              {row.kind}: {row.label}
            </Text>
          ))}
          <Text className={styles.hint}>この確認が、送信前の最終操作です。</Text>
        </>
      )}

      {step === 'S05' && scanPlan === null && (
        <>
          <Text size={400}>S05 実行計画の最終確認</Text>
          <Button appearance="primary" disabled={busy} onClick={() => void prepareScanPlan()}>
            計画を作成して確認する
          </Button>
        </>
      )}

      {step === 'S06' && (
        <>
          <Text size={400}>S06 実行状況</Text>
          {data.runFinished ? (
            <>
              <Text role="status">{runSummary}</Text>
              {findings.map((finding) => (
                <Text key={finding.findingId} className={styles.hint}>
                  [{finding.severity}] {finding.title} — {finding.url} (観測 {finding.occurrences} 回)
                  {finding.source.unverified ? ' ・実影響未確認' : ''}
                </Text>
              ))}
            </>
          ) : (
            <Button appearance="primary" disabled={busy} onClick={() => void runScan()}>
              診断を実行する
            </Button>
          )}
        </>
      )}

      {step === 'S07' && (
        <>
          <Text size={400}>S07 結果レビュー・報告</Text>
          {reportContent === '' ? (
            <Button appearance="primary" disabled={busy} onClick={() => void buildReport()}>
              報告書を生成する
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
          戻る
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
          次へ {!advanceResult.ok && step !== 'S07' ? `(要件未達)` : ''}
        </Button>
      </div>
    </div>
  );
}
