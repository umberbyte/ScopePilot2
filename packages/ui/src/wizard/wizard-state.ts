/**
 * Simple wizard (S01〜S07) の状態機械。`docs/detailed-design/02-ui-information-architecture.md` §2。
 * 一本道: 各 step のデータ要件を満たした次 step への進行だけを許可し、戻りは常に可能。
 * 詳細 crawl limit 等の変更導線は持たない (S03 は表示専用)。
 */
import type { UiRoute } from '../app/mode-policy.ts';

export type WizardStep = 'S01' | 'S02' | 'S03' | 'S04' | 'S05' | 'S06' | 'S07';

export const WIZARD_STEPS: readonly WizardStep[] = ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07'];

export interface WizardData {
  /** S01: 案件を開いた。 */
  readonly caseOpened: boolean;
  /** S02: 選択したガイドライン (1つ以上)。 */
  readonly selectedGuidelines: readonly string[];
  /** S03: 探索が完了した。 */
  readonly explorationDone: boolean;
  /** S04: 採用した対象 (1つ以上)。 */
  readonly selectedTargets: readonly string[];
  /** S05: 実行計画を確認した。 */
  readonly planConfirmed: boolean;
  /** S06: 診断実行が終了した。 */
  readonly runFinished: boolean;
}

export function initialWizardData(): WizardData {
  return {
    caseOpened: false,
    selectedGuidelines: [],
    explorationDone: false,
    selectedTargets: [],
    planConfirmed: false,
    runFinished: false,
  };
}

/** step の完了条件 (次へ進む要件)。 */
export function stepComplete(step: WizardStep, data: WizardData): boolean {
  switch (step) {
    case 'S01':
      return data.caseOpened;
    case 'S02':
      return data.selectedGuidelines.length > 0;
    case 'S03':
      return data.explorationDone;
    case 'S04':
      return data.selectedTargets.length > 0;
    case 'S05':
      return data.planConfirmed;
    case 'S06':
      return data.runFinished;
    case 'S07':
      return true;
  }
}

export function canAdvance(step: WizardStep, data: WizardData): boolean {
  if (step === 'S07') {
    return false;
  }
  return stepComplete(step, data);
}

/** 未完了 step は先へ進めない (UI-UT-009)。 */
export function advance(step: WizardStep, data: WizardData): { ok: true; next: WizardStep } | { ok: false; reason: string } {
  if (step === 'S07') {
    return { ok: false, reason: 'step S07 has no next step' };
  }
  if (!canAdvance(step, data)) {
    return { ok: false, reason: `step ${step} is not complete yet` };
  }
  const index = WIZARD_STEPS.indexOf(step);
  const next = WIZARD_STEPS[index + 1];
  if (next === undefined) {
    return { ok: false, reason: `step ${step} has no next step` };
  }
  return { ok: true, next };
}

/** 戻りは常に許可 (S01 を除く)。データは保持する (UI-UT-011)。 */
export function goBack(step: WizardStep): { ok: true; previous: WizardStep } | { ok: false; reason: string } {
  const index = WIZARD_STEPS.indexOf(step);
  if (index <= 0) {
    return { ok: false, reason: 'S01 has no previous step' };
  }
  const previous = WIZARD_STEPS[index - 1];
  if (previous === undefined) {
    return { ok: false, reason: 'unknown previous step' };
  }
  return { ok: true, previous };
}

const STEP_ROUTES: Readonly<Record<WizardStep, UiRoute>> = {
  S01: 'wizard.case-open',
  S02: 'wizard.guideline',
  S03: 'wizard.explore',
  S04: 'wizard.target-select',
  S05: 'wizard.final-confirm',
  S06: 'wizard.run',
  S07: 'wizard.report',
};

/** 各 step は対応する wizard route に写る (Simple の許可 route と一致、UI-UT-010)。 */
export function routeForStep(step: WizardStep): UiRoute {
  return STEP_ROUTES[step];
}

export const STEP_LABELS: Readonly<Record<WizardStep, string>> = {
  S01: '案件を開く',
  S02: 'ガイドライン選択',
  S03: '認証準備・探索開始',
  S04: '探索結果から対象選定',
  S05: '実行計画の最終確認',
  S06: '実行状況',
  S07: '結果レビュー・報告',
};
