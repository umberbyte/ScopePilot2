/**
 * 操作者権限と対象ロールの分離。`docs/detailed-design/f01-case-scope-authorization.md` §3・§5。
 * operator は ScopePilot 操作者、target role は診断対象アカウントであり、
 * 名前が一致しても権限を付与しない (F01-UT-005)。
 */
import { domainError, type OperatorPermission } from '@scopepilot2/contracts';

export function assertOperatorMayActOnRole(input: {
  operatorId: string;
  permissions: readonly OperatorPermission[];
  targetRole: string;
  required: OperatorPermission;
}): void {
  if (!input.permissions.includes(input.required)) {
    const sameName = input.operatorId === input.targetRole;
    throw domainError(
      'PermissionDenied',
      `operator ${input.operatorId} lacks permission ${input.required}${sameName ? ' (operator name matching the target role grants nothing)' : ''}`,
    );
  }
}
