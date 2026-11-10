import { domainError, type AuthorizationRecord, type CaseRecord, type OperatorProfile } from '@scopepilot2/contracts';
import type { BaselineFlowDeps, GrantAuthorizationInput } from '../baseline-contracts.ts';
import type { CaseSessionContext } from './case-session-context.ts';
import type { EvidenceServicePort } from './evidence-service.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import { requirePermission } from './authorization-policy.ts';
export class AuthorizationService {
    private readonly deps: Pick<BaselineFlowDeps, 'clock' | 'ids' | 'authorizationSink'>;
    private readonly context: CaseSessionContext;
    private readonly queries: {
        currentCase(): CaseRecord;
    };
    private readonly evidence: EvidenceServicePort;
    private readonly events: EventPublisherPort;
    constructor(deps: Pick<BaselineFlowDeps, 'clock' | 'ids' | 'authorizationSink'>, context: CaseSessionContext, queries: {
        currentCase(): CaseRecord;
    }, evidence: EvidenceServicePort, events: EventPublisherPort) {
        this.deps = deps;
        this.context = context;
        this.queries = queries;
        this.evidence = evidence;
        this.events = events;
    }
    currentAuthorization(): AuthorizationRecord {
        if (this.context.authorization === null) {
            throw domainError('ValidationFailed', 'authorization has not been granted yet');
        }
        return this.context.authorization;
    }
    async grantAuthorization(operator: OperatorProfile, input: GrantAuthorizationInput): Promise<AuthorizationRecord> {
        requirePermission(operator, 'case.manage');
        const caseRecord = this.queries.currentCase();
        if (input.validFrom >= input.validUntil) {
            throw domainError('ValidationFailed', 'authorization validFrom must be before validUntil');
        }
        if (input.allowedOperationClasses.length === 0) {
            throw domainError('ValidationFailed', 'authorization must allow at least one operation class');
        }
        const stored = await this.evidence.saveAuthorization(input.evidence.label, input.evidence.content,
        // 許可欄以外の metadata は保存しない (F01-UT-008)。
        input.evidence.metadata ?? {});
        this.context.authorization = {
            authorizationId: this.deps.ids.next('authz'),
            caseId: caseRecord.caseId,
            allowedOperationClasses: input.allowedOperationClasses,
            targetRoles: input.targetRoles,
            validFrom: input.validFrom,
            validUntil: input.validUntil,
            evidenceRef: { evidenceId: stored.evidenceId, sha256: stored.sha256, label: stored.label },
        };
        this.deps.authorizationSink?.save(this.context.authorization);
        this.events.publish({
            type: 'AuthorizationGranted',
            at: this.deps.clock.now().toISOString(),
            authorizationId: this.context.authorization.authorizationId,
            caseId: caseRecord.caseId,
        });
        return this.context.authorization;
    }
}
