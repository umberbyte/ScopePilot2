/**
 * domain error を安定した API error 形へ写す mapper。`docs/detailed-design/01-system-components.md` §6 (SYS-UT-003)。
 * API の error 表現は code 一意とし、詳細 (details, correlationId) は log 向けに分離する。
 */
import { DomainError, type DomainErrorCode } from '@scopepilot2/contracts';

export interface ApiErrorShape {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/** DomainError 以外の例外はそのまま伝播させる (内部 error を誤った code に潰さない)。 */
export function apiErrorOf(error: DomainError): ApiErrorShape {
  if (!(error instanceof DomainError)) {
    throw error;
  }
  return { code: error.code, message: error.message, retryable: error.retryable };
}
