/**
 * 実行内容の表示 model。`docs/detailed-design/02-ui-information-architecture.md` §3。
 * ScopePilot 強制 (Enforced) と外部 engine 委譲 (Delegated) を分けて表示する (UI-UT-003)。
 */
import type { PlanStep } from '@scopepilot2/contracts';

export interface ExecutionSummaryRow {
  readonly stepId: string;
  readonly kind: string;
  readonly label: string;
  /** ScopePilot が各送信を送信前に判定する場合のみ true。 */
  readonly preSendGuaranteed: boolean;
}

export function executionSummary(steps: readonly PlanStep[]): readonly ExecutionSummaryRow[] {
  return steps.map((step) => ({
    stepId: step.stepId,
    kind: step.kind,
    label:
      step.guarantee === 'Delegated'
        ? `外部 engine (${step.engineKind}) へ委譲 — 個々の送信の送信前拒否は保証しない`
        : step.guarantee === 'Unsupported'
          ? `保証手段なし (${step.engineKind}) — 公開されない`
          : `ScopePilot が各送信を送信前に判定 (${step.engineKind})`,
    preSendGuaranteed: step.guarantee === 'Enforced',
  }));
}
