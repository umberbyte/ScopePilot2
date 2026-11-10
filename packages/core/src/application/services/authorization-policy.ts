import { domainError, type OperatorProfile, type OperatorPermission } from '@scopepilot2/contracts';
export function requirePermission(operator: OperatorProfile, permission: OperatorPermission): void {
    if (!operator.permissions.includes(permission))
        throw domainError('PermissionDenied', `operator ${operator.operatorId} lacks permission ${permission}`);
}
