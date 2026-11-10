import { domainError, type OperatorProfile } from '@scopepilot2/contracts';
import { ScopePolicy } from '../../domain/scope-policy.ts';
import { correlate, linkFinding, normalizeCallbacks, OAST_DEFAULT_WAIT_MS, pollDeadline, providerCapability, type OastProtocol, type ProviderEvent } from '../../domain/oast.ts';
import type { OastProviderEvent } from '../../ports/engines.ts';
import type { BaselineFlowDeps } from '../baseline-contracts.ts';
import type { ToolWorkspacePort } from './tool-ports.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import type { RuntimeAdapterPolicyPort } from './runtime-profile.ts';
import { requirePermission } from './authorization-policy.ts';
export class OastService {
    private readonly deps: Pick<BaselineFlowDeps, 'oastProvider' | 'ids' | 'clock' | 'runtimeProfile' | 'adapterKinds'>;
    private readonly ports: ToolWorkspacePort;
    private readonly events: EventPublisherPort;
    private readonly runtime: RuntimeAdapterPolicyPort;
    private readonly oastAttempts: {
        attemptId: string;
        targetUrl: string;
        protocol: OastProtocol;
        token: string;
        issuedAtMs: number;
    }[] = [];
    private readonly oastSeenEventIds = new Set<string>();
    private readonly oastInteractions: {
        token: string;
        payload: string;
        recordedAt: string;
    }[] = [];
    private readonly oastUncorrelated: {
        token: string;
        reason: string;
        recordedAt: string;
    }[] = [];
    constructor(deps: OastService['deps'], ports: ToolWorkspacePort, events: EventPublisherPort, runtime: RuntimeAdapterPolicyPort) {
        this.deps = deps;
        this.ports = ports;
        this.events = events;
        this.runtime = runtime;
    }
    async startOastAttempt(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly protocol: OastProtocol;
    }): Promise<{
        attemptId: string;
        targetUrl: string;
        protocol: OastProtocol;
        token: string;
        waitMs: number;
    }> {
        requirePermission(operator, 'run.manage');
        const adapter = this.runtime.requireAdapter('oastProvider', this.deps.oastProvider, this.deps.adapterKinds?.oastProvider);
        const caseRecord = this.ports.currentCase();
        const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
        const decision = ScopePolicy.decide(caseRecord.scope, canonical);
        if (!decision.allowed) {
            throw domainError('OutOfScope', `oast target is out of scope: ${decision.reason}`);
        }
        const supportedProtocols = adapter.supportedProtocols;
        if (providerCapability(supportedProtocols, input.protocol) === 'Unsupported') {
            throw domainError('CapabilityUnavailable', `oast provider does not support protocol ${input.protocol}`);
        }
        const attemptId = this.deps.ids.next('oast');
        const pendingEvents: OastProviderEvent[][] = [];
        let attemptRegistered = false;
        const { token } = await adapter.startSession({
            attemptId,
            protocol: input.protocol,
            onEvents: (events) => {
                if (!attemptRegistered) {
                    pendingEvents.push([...events]);
                    return;
                }
                this.recordProviderOastCallbacks(events);
            },
        });
        this.oastAttempts.push({ attemptId, targetUrl: canonical, protocol: input.protocol, token, issuedAtMs: this.deps.clock.now().getTime() });
        attemptRegistered = true;
        this.events.publish({ type: 'OastAttemptStarted', at: this.deps.clock.now().toISOString(), attemptId, targetUrl: canonical, protocol: input.protocol });
        for (const events of pendingEvents) {
            this.recordProviderOastCallbacks(events);
        }
        return { attemptId, targetUrl: canonical, protocol: input.protocol, token, waitMs: OAST_DEFAULT_WAIT_MS };
    }
    recordOastCallbacks(operator: OperatorProfile, input: {
        readonly events: readonly ProviderEvent[];
    }): {
        kept: number;
        duplicates: number;
        correlated: number;
        uncorrelated: number;
    } {
        requirePermission(operator, 'run.manage');
        if (input.events.length === 0) {
            throw domainError('ValidationFailed', 'oast callbacks need at least one event');
        }
        return this.recordProviderOastCallbacks(input.events);
    }
    private recordProviderOastCallbacks(events: readonly OastProviderEvent[]): {
        kept: number;
        duplicates: number;
        correlated: number;
        uncorrelated: number;
    } {
        const fresh = events.filter((event) => !this.oastSeenEventIds.has(event.eventId));
        const persistedDuplicates = events.length - fresh.length;
        const { kept, duplicates: inCallDuplicates } = normalizeCallbacks(fresh);
        const duplicates = persistedDuplicates + inCallDuplicates;
        for (const event of kept) {
            this.oastSeenEventIds.add(event.eventId);
        }
        const knownTokens = new Set(this.oastAttempts.map((attempt) => attempt.token));
        const callbacks = correlate(kept, knownTokens);
        let correlatedCount = 0;
        let uncorrelatedCount = 0;
        const at = this.deps.clock.now().toISOString();
        for (const callback of callbacks) {
            if (callback.kind === 'correlated') {
                correlatedCount += 1;
                this.oastInteractions.push({ token: callback.token, payload: callback.payload, recordedAt: at });
            }
            else {
                uncorrelatedCount += 1;
                this.oastUncorrelated.push({ token: callback.token, reason: callback.reason, recordedAt: at });
            }
        }
        this.events.publish({ type: 'OastCallbacksRecorded', at, kept: kept.length, duplicates, correlated: correlatedCount, uncorrelated: uncorrelatedCount });
        return { kept: kept.length, duplicates, correlated: correlatedCount, uncorrelated: uncorrelatedCount };
    }
    listOastAttempts(): readonly {
        attemptId: string;
        targetUrl: string;
        protocol: OastProtocol;
        status: 'waiting' | 'expired';
        interactions: number;
        candidateOnly: boolean;
    }[] {
        const nowMs = this.deps.clock.now().getTime();
        return this.oastAttempts.map((attempt) => {
            const interactions = this.oastInteractions.filter((interaction) => interaction.token === attempt.token);
            const linked = linkFinding(interactions.map(() => ({ kind: 'correlated' as const, token: attempt.token, payload: '' })));
            return {
                attemptId: attempt.attemptId,
                targetUrl: attempt.targetUrl,
                protocol: attempt.protocol,
                status: pollDeadline(attempt.issuedAtMs, nowMs).expired ? ('expired' as const) : ('waiting' as const),
                interactions: interactions.length,
                // 複数 token にまたがる相関は無い (attempt 単位) が、観測 0 件は候補にもしない。
                candidateOnly: linked.linkedTokens.length === 1 && linked.candidateOnly === false ? false : true,
            };
        });
    }
}
