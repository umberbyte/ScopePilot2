/**
 * 確認画面の command builder。`docs/detailed-design/02-ui-information-architecture.md` §4。
 * 表示後に plan hash が変化したら confirmation を無効化する (UI-UT-005)。
 * hash 計算は core 契約の内側にあるため、UI は受領した hash 値を比較するだけにする。
 */
import type { PlanConfirmation } from '@scopepilot2/contracts';

export interface ConfirmationViewState {
  readonly displayedPlanHash: string;
  readonly confirmation?: PlanConfirmation;
}

export function confirmationStillValid(state: ConfirmationViewState, currentPlanHash: string): boolean {
  const confirmation = state.confirmation;
  if (confirmation === undefined) {
    return false;
  }
  return state.displayedPlanHash === confirmation.planHash && state.displayedPlanHash === currentPlanHash;
}
