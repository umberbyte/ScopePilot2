/** 安定した API error とするための domain error 規約。`docs/detailed-design/01-system-components.md` 6章。 */
export const DomainErrorCodes = [
  'ValidationFailed',
  'PermissionDenied',
  'OutOfScope',
  'ConfirmationRequired',
  'Conflict',
  'CapabilityUnavailable',
  'NeedsInput',
  'Unsupported',
  'EngineFailure',
  'Cancelled',
] as const;

export type DomainErrorCode = (typeof DomainErrorCodes)[number];

export interface DomainErrorOptions {
  retryable?: boolean;
  details?: Readonly<Record<string, unknown>>;
  correlationId?: string;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;

  constructor(code: DomainErrorCode, message: string, options?: DomainErrorOptions) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
    if (options?.correlationId !== undefined) {
      this.correlationId = options.correlationId;
    }
  }
}

export function domainError(
  code: DomainErrorCode,
  message: string,
  options?: DomainErrorOptions,
): DomainError {
  return new DomainError(code, message, options);
}
