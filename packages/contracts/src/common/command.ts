/** 副作用 command の共通 envelope。`docs/detailed-design/01-system-components.md` 4章。 */
import type { DomainError } from './errors.ts';
export const OperatorPermissions = [
  'case.manage',
  'case.read',
  'run.manage',
  'finding.confirm',
  'report.export',
] as const;

export type OperatorPermission = (typeof OperatorPermissions)[number];

export interface OperatorProfile {
  readonly operatorId: string;
  readonly displayName: string;
  readonly permissions: readonly OperatorPermission[];
}

export interface CommandEnvelope<T> {
  readonly commandId: string;
  readonly caseId: string;
  readonly operator: OperatorProfile;
  readonly expectedRevision?: number;
  readonly payload: T;
}

export type CommandResult<T> =
  | { readonly ok: true; readonly value: T; readonly revision: number; readonly evidenceIds: readonly string[] }
  | { readonly ok: false; readonly error: DomainError };
