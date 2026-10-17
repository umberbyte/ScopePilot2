/**
 * 案件 aggregate。revision lifecycle と、scope 縮小時の confirmation 無効化を担う。
 * `docs/detailed-design/f01-case-scope-authorization.md` §4、`docs/design/22-execution-control.md` §2。
 *
 * - 更新は expectedRevision を比較し、不一致なら state を変えず `Conflict` (F01-UT-007, SYS-UT-002)。
 * - scope が狭くなった場合、既存 confirmation を無効化する (F01-UT-006)。
 *   広がる変更は計画 hash が変わらないため confirmation を無効化しない (設計は「狭くなった場合」のみ定義)。
 */
import { domainError, type CaseRecord, type CaseScope } from '@scopepilot2/contracts';

export interface RegisteredConfirmation {
  readonly confirmationId: string;
  readonly planHash: string;
}

export interface ScopeUpdateOutcome {
  readonly record: CaseRecord;
  readonly revision: number;
  readonly narrowed: boolean;
  /** 今回の更新で無効化した confirmation。 */
  readonly invalidatedConfirmationIds: readonly string[];
}

/** 許可 origin 減・deny 増・上限減のいずれかで「狭くなった」と判定する。 */
export function isScopeNarrower(previous: CaseScope, next: CaseScope): boolean {
  const allowedShrunk =
    next.allowedOrigins.length < previous.allowedOrigins.length &&
    next.allowedOrigins.every((origin) => previous.allowedOrigins.includes(origin));
  const denyGrew =
    next.deniedOrigins.length > previous.deniedOrigins.length &&
    previous.deniedOrigins.every((origin) => next.deniedOrigins.includes(origin));
  const limitsShrunk =
    next.limits.maxRequests < previous.limits.maxRequests ||
    next.limits.maxPages < previous.limits.maxPages ||
    next.limits.maxDurationMinutes < previous.limits.maxDurationMinutes;
  return allowedShrunk || denyGrew || limitsShrunk;
}

export class CaseAggregate {
  private current: CaseRecord;
  private readonly activeConfirmations = new Map<string, RegisteredConfirmation>();
  private readonly invalidatedConfirmations = new Map<string, string>();

  private constructor(initial: CaseRecord) {
    this.current = initial;
  }

  static open(initial: CaseRecord): CaseAggregate {
    return new CaseAggregate(initial);
  }

  get record(): CaseRecord {
    return this.current;
  }

  get revision(): number {
    return this.current.revision;
  }

  get scope(): CaseScope {
    return this.current.scope;
  }

  registerConfirmation(confirmation: RegisteredConfirmation): void {
    if (this.invalidatedConfirmations.has(confirmation.confirmationId)) {
      return;
    }
    this.activeConfirmations.set(confirmation.confirmationId, confirmation);
  }

  isConfirmationInvalidated(confirmationId: string): boolean {
    return this.invalidatedConfirmations.has(confirmationId);
  }

  invalidationReason(confirmationId: string): string | undefined {
    return this.invalidatedConfirmations.get(confirmationId);
  }

  activeConfirmationIds(): readonly string[] {
    return [...this.activeConfirmations.keys()];
  }

  /** scope 更新。expectedRevision が不一致なら state を変えず Conflict。 */
  updateScope(input: { expectedRevision: number; scope: CaseScope }): ScopeUpdateOutcome {
    if (input.expectedRevision !== this.current.revision) {
      throw domainError('Conflict', `expected revision ${input.expectedRevision} does not match current revision ${this.current.revision}`, {
        details: { currentRevision: this.current.revision, expectedRevision: input.expectedRevision },
      });
    }
    const narrowed = isScopeNarrower(this.current.scope, input.scope);
    const record: CaseRecord = { ...this.current, scope: input.scope, revision: this.current.revision + 1 };
    this.current = record;

    const invalidated: string[] = [];
    if (narrowed) {
      for (const confirmationId of this.activeConfirmations.keys()) {
        invalidated.push(confirmationId);
      }
      for (const confirmationId of invalidated) {
        this.activeConfirmations.delete(confirmationId);
        this.invalidatedConfirmations.set(confirmationId, 'case scope narrowed');
      }
    }
    return { record, revision: record.revision, narrowed, invalidatedConfirmationIds: invalidated };
  }
}
