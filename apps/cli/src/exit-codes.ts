/**
 * 終了コード規約。`docs/design/19-cli-automation.md` §3。
 * 完了・所見あり・上限停止・範囲違反・認証失敗・engine 失敗・入力不正・中断を区別し、
 * 所見の有無と実行成否を同じ code に押し込めない。
 */
import type { DomainErrorCode, StopReason } from '@scopepilot2/contracts';

export const ExitCodes = {
  /** 完了 (所見なし)。 */
  Success: 0,
  /** 予期しない内部 error。 */
  Unexpected: 1,
  /** 入力不正。 */
  Validation: 2,
  /** 権限・認証失敗。 */
  Permission: 3,
  /** 完了したが所見あり。CI policy で失敗扱いにするかを選べる。 */
  FindingsPresent: 4,
  /** 上限停止。 */
  BudgetStop: 5,
  /** 範囲違反。 */
  OutOfScope: 6,
  /** engine 失敗。 */
  EngineFailure: 7,
  /** 中断・取消。 */
  Cancelled: 8,
  /** 確認が必要 (対話がないと実行できない)。 */
  ConfirmationRequired: 9,
} as const;

export function exitCodeForDomainError(code: DomainErrorCode): number {
  switch (code) {
    case 'ValidationFailed':
    case 'Conflict':
    case 'Unsupported':
      return ExitCodes.Validation;
    case 'PermissionDenied':
      return ExitCodes.Permission;
    case 'OutOfScope':
      return ExitCodes.OutOfScope;
    case 'ConfirmationRequired':
    case 'NeedsInput':
      return ExitCodes.ConfirmationRequired;
    case 'EngineFailure':
      return ExitCodes.EngineFailure;
    case 'Cancelled':
      return ExitCodes.Cancelled;
    case 'CapabilityUnavailable':
      return ExitCodes.EngineFailure;
  }
}

export function exitCodeForStopReason(reason: StopReason): number {
  switch (reason) {
    case 'completed':
      return ExitCodes.Success;
    case 'user-request':
    case 'interrupted':
      return ExitCodes.Cancelled;
    case 'budget-exhausted':
      return ExitCodes.BudgetStop;
    case 'scope-violation':
      return ExitCodes.OutOfScope;
    case 'authorization-expired':
      return ExitCodes.Permission;
    case 'engine-failure':
      return ExitCodes.EngineFailure;
  }
}
