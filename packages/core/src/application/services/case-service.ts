import { domainError, type AuthorizationRecord, type CaseRecord, type OperatorProfile, type ScopeLimits, type DocumentAuthHint, type DocumentAuthHintEntry, type DocumentPriorityRule, type DocumentParameterHint, type DocumentParameterHintEntry, DocumentAuthMethods, DocumentPriorityCategories } from '@scopepilot2/contracts';
import { ScopePolicy } from '../../domain/scope-policy.ts';
import { mergeDocumentHintSeeds } from '../../domain/exploration.ts';
import { CaseAggregate } from '../../domain/case-aggregate.ts';
import type { BaselineFlowDeps, CreateCaseInput } from '../baseline-contracts.ts';
import { CaseSessionContext } from './case-session-context.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import { requirePermission } from './authorization-policy.ts';
export class CaseService {
    private readonly deps: Pick<BaselineFlowDeps, 'clock' | 'ids' | 'caseSink'>;
    private readonly context: CaseSessionContext;
    private readonly events: EventPublisherPort;
    constructor(deps: Pick<BaselineFlowDeps, 'clock' | 'ids' | 'caseSink'>, context: CaseSessionContext, events: EventPublisherPort) {
        this.deps = deps;
        this.context = context;
        this.events = events;
    }
    registerConfirmation(confirmation: {
        confirmationId: string;
        planHash: string;
    }): void { this.currentAggregate().registerConfirmation(confirmation); }
    isConfirmationInvalidated(id: string): boolean { return this.currentAggregate().isConfirmationInvalidated(id); }
    invalidationReason(id: string) { return this.currentAggregate().invalidationReason(id); }
    restoreWorkspace(record: CaseRecord, authorization?: AuthorizationRecord): void {
        this.requirePositiveLimits(record.scope.limits, 'case');
        if (record.name.trim() === '' || record.caseId.trim() === '') {
            throw domainError('ValidationFailed', 'stored case is invalid');
        }
        const allowed = record.scope.allowedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
        const denied = record.scope.deniedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
        if (allowed.length === 0) {
            throw domainError('ValidationFailed', 'stored case must have at least one allowed origin');
        }
        if (authorization !== undefined && authorization.caseId !== record.caseId) {
            throw domainError('ValidationFailed', 'stored authorization belongs to another case');
        }
        this.context.aggregate = CaseAggregate.open({
            ...record,
            scope: {
                allowedOrigins: [...new Set(allowed)],
                deniedOrigins: [...new Set(denied)],
                limits: record.scope.limits,
            },
        });
        this.context.authorization = authorization ?? null;
    }
    currentCase(): CaseRecord {
        if (this.context.aggregate === null) {
            throw domainError('ValidationFailed', 'case has not been created yet');
        }
        return this.context.aggregate.record;
    }
    createCase(operator: OperatorProfile, input: CreateCaseInput): CaseRecord {
        requirePermission(operator, 'case.manage');
        if (input.name.trim() === '') {
            throw domainError('ValidationFailed', 'case name must not be empty');
        }
        this.requirePositiveLimits(input.limits, 'case');
        const allowed = input.allowedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
        const denied = input.deniedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
        if (allowed.length === 0) {
            throw domainError('ValidationFailed', 'case must have at least one allowed origin');
        }
        this.context.aggregate = CaseAggregate.open({
            caseId: this.deps.ids.next('case'),
            name: input.name,
            revision: 1,
            scope: { allowedOrigins: [...new Set(allowed)], deniedOrigins: [...new Set(denied)], limits: input.limits },
            createdAt: this.deps.clock.now().toISOString(),
        });
        this.deps.caseSink?.save(this.context.aggregate.record);
        this.events.publish({ type: 'CaseCreated', at: this.deps.clock.now().toISOString(), caseId: this.context.aggregate.record.caseId, revision: 1 });
        return this.context.aggregate.record;
    }
    updateCaseScope(operator: OperatorProfile, input: {
        expectedRevision: number;
        allowedOrigins: readonly string[];
        deniedOrigins: readonly string[];
        limits: ScopeLimits;
    }): {
        revision: number;
        narrowed: boolean;
        invalidatedConfirmationIds: readonly string[];
    } {
        requirePermission(operator, 'case.manage');
        const aggregate = this.context.aggregate;
        if (aggregate === null) {
            throw domainError('ValidationFailed', 'case has not been created yet');
        }
        const allowed = input.allowedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
        const denied = input.deniedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
        if (allowed.length === 0) {
            throw domainError('ValidationFailed', 'case must have at least one allowed origin');
        }
        this.requirePositiveLimits(input.limits, 'case');
        const outcome = aggregate.updateScope({
            expectedRevision: input.expectedRevision,
            scope: { allowedOrigins: [...new Set(allowed)], deniedOrigins: [...new Set(denied)], limits: input.limits },
        });
        const at = this.deps.clock.now().toISOString();
        this.events.publish({ type: 'CaseScopeUpdated', at, caseId: outcome.record.caseId, revision: outcome.revision, narrowed: outcome.narrowed });
        if (outcome.invalidatedConfirmationIds.length > 0) {
            this.events.publish({
                type: 'ConfirmationsInvalidated',
                at,
                caseId: outcome.record.caseId,
                confirmationIds: [...outcome.invalidatedConfirmationIds],
                reason: 'case scope narrowed',
            });
        }
        this.deps.caseSink?.save(outcome.record);
        return outcome;
    }
    registerDocumentHints(operator: OperatorProfile, input: {
        readonly documentLabel: string;
        readonly urls: readonly string[];
    }): {
        documentLabel: string;
        urlCount: number;
        acceptedUrlCount: number;
    } {
        requirePermission(operator, 'case.manage');
        if (input.documentLabel.trim() === '') {
            throw domainError('ValidationFailed', 'documentLabel must not be empty');
        }
        if (input.urls.length === 0) {
            throw domainError('ValidationFailed', 'document hints need at least one URL');
        }
        const caseRecord = this.currentCase();
        const acceptedUrlCount = mergeDocumentHintSeeds([], input.urls, caseRecord.scope).hintTargets.length;
        this.context.documentHintDocuments.push({ documentLabel: input.documentLabel, urls: [...input.urls] });
        this.events.publish({
            type: 'DocumentHintsRegistered',
            at: this.deps.clock.now().toISOString(),
            documentLabel: input.documentLabel,
            urlCount: input.urls.length,
            acceptedUrlCount,
        });
        return { documentLabel: input.documentLabel, urlCount: input.urls.length, acceptedUrlCount };
    }
    listDocumentHints(): readonly {
        documentLabel: string;
        urls: readonly string[];
    }[] {
        return [...this.context.documentHintDocuments];
    }
    registerDocumentAuthHints(operator: OperatorProfile, input: {
        readonly documentLabel: string;
        readonly entries: readonly DocumentAuthHint[];
    }): {
        documentLabel: string;
        entryCount: number;
    } {
        requirePermission(operator, 'case.manage');
        if (input.documentLabel.trim() === '') {
            throw domainError('ValidationFailed', 'documentLabel must not be empty');
        }
        if (input.entries.length === 0) {
            throw domainError('ValidationFailed', 'auth hints need at least one entry');
        }
        for (const [index, entry] of input.entries.entries()) {
            if (entry.role.trim() === '') {
                throw domainError('ValidationFailed', `auth hints[${index}]: role must not be empty`);
            }
            if (!DocumentAuthMethods.includes(entry.authMethod)) {
                throw domainError('ValidationFailed', `auth hints[${index}]: authMethod not allowed: ${String(entry.authMethod)}`);
            }
            if (entry.documentLocation.trim() === '') {
                throw domainError('ValidationFailed', `auth hints[${index}]: documentLocation must not be empty`);
            }
        }
        this.context.documentAuthHintDocuments.push({ documentLabel: input.documentLabel, entries: [...input.entries] });
        this.events.publish({
            type: 'DocumentAuthHintsRegistered',
            at: this.deps.clock.now().toISOString(),
            documentLabel: input.documentLabel,
            entryCount: input.entries.length,
        });
        return { documentLabel: input.documentLabel, entryCount: input.entries.length };
    }
    listDocumentAuthHints(): readonly DocumentAuthHintEntry[] {
        return [...this.context.documentAuthHintDocuments];
    }
    registerDocumentPriorityHints(operator: OperatorProfile, input: {
        readonly documentLabel: string;
        readonly rules: readonly DocumentPriorityRule[];
    }): {
        documentLabel: string;
        ruleCount: number;
    } {
        requirePermission(operator, 'case.manage');
        if (input.documentLabel.trim() === '') {
            throw domainError('ValidationFailed', 'documentLabel must not be empty');
        }
        if (input.rules.length === 0) {
            throw domainError('ValidationFailed', 'priority hints need at least one rule');
        }
        for (const [index, rule] of input.rules.entries()) {
            if (rule.urlIncludes.trim() === '') {
                throw domainError('ValidationFailed', `rules[${index}]: urlIncludes must not be empty`);
            }
            if (!DocumentPriorityCategories.includes(rule.category)) {
                throw domainError('ValidationFailed', `rules[${index}]: category not allowed: ${String(rule.category)}`);
            }
        }
        (this.context.documentPriorityRules as DocumentPriorityRule[]).push(...input.rules);
        this.events.publish({
            type: 'DocumentPriorityHintsRegistered',
            at: this.deps.clock.now().toISOString(),
            documentLabel: input.documentLabel,
            ruleCount: input.rules.length,
        });
        return { documentLabel: input.documentLabel, ruleCount: input.rules.length };
    }
    listDocumentPriorityRules(): readonly DocumentPriorityRule[] {
        return [...this.context.documentPriorityRules];
    }
    registerDocumentParameterHints(operator: OperatorProfile, input: {
        readonly documentLabel: string;
        readonly parameters: readonly DocumentParameterHint[];
    }): {
        documentLabel: string;
        parameterCount: number;
    } {
        requirePermission(operator, 'case.manage');
        if (input.documentLabel.trim() === '') {
            throw domainError('ValidationFailed', 'documentLabel must not be empty');
        }
        if (input.parameters.length === 0) {
            throw domainError('ValidationFailed', 'parameter hints need at least one parameter');
        }
        for (const [index, parameter] of input.parameters.entries()) {
            if (parameter.name.trim() === '') {
                throw domainError('ValidationFailed', `parameters[${index}]: name must not be empty`);
            }
            if (parameter.values.length === 0) {
                throw domainError('ValidationFailed', `parameters[${index}]: values need at least one entry`);
            }
        }
        this.context.documentParameterHintDocuments.push({ documentLabel: input.documentLabel, parameters: [...input.parameters] });
        this.events.publish({
            type: 'DocumentParameterHintsRegistered',
            at: this.deps.clock.now().toISOString(),
            documentLabel: input.documentLabel,
            parameterCount: input.parameters.length,
        });
        return { documentLabel: input.documentLabel, parameterCount: input.parameters.length };
    }
    listDocumentParameterHints(): readonly DocumentParameterHintEntry[] {
        return [...this.context.documentParameterHintDocuments];
    }
    isPrioritizedUrl(canonical: string): boolean {
        return this.context.documentPriorityRules.some((rule) => canonical.includes(rule.urlIncludes));
    }
    private canonicalOriginOrThrow(origin: string): string {
        try {
            return ScopePolicy.canonicalOrigin(origin);
        }
        catch (cause) {
            throw domainError('ValidationFailed', `invalid origin: ${origin}`, { details: { cause: String(cause) } });
        }
    }
    private requirePositiveLimits(limits: ScopeLimits, label: string): void {
        for (const [key, value] of Object.entries(limits)) {
            if (!Number.isInteger(value) || value <= 0) {
                throw domainError('ValidationFailed', `${label} limit ${key} must be a positive integer`);
            }
        }
    }
    private currentAggregate(): CaseAggregate {
        if (this.context.aggregate === null) {
            throw domainError('ValidationFailed', 'case has not been created yet');
        }
        return this.context.aggregate;
    }
}
