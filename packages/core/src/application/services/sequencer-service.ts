import { domainError, type OperatorProfile } from '@scopepilot2/contracts';
import { ScopePolicy } from '../../domain/scope-policy.ts';
import { applicableSessionCookies } from '../../domain/repeater.ts';
import { assess, createSamplePlan, createSequencerExtractor, createSequencerReplayRequest, extractSequencerToken, reportProjection, SampleCollector } from '../../domain/sequencer.ts';
import type { LoginSessionCookie } from '../../ports/engines.ts';
import type { BaselineFlowDeps, SequencerTokenSource, SequencerSessionResult, SequencerSessionRecord } from '../baseline-contracts.ts';
import type { ToolWorkspacePort } from './tool-ports.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import type { RuntimeAdapterPolicyPort } from './runtime-profile.ts';
import { requirePermission } from './authorization-policy.ts';
export class SequencerService {
    private readonly deps: Pick<BaselineFlowDeps, 'sequencerTransport' | 'clock' | 'ids' | 'runtimeProfile' | 'adapterKinds'>;
    private readonly ports: ToolWorkspacePort;
    private readonly events: EventPublisherPort;
    private readonly runtime: RuntimeAdapterPolicyPort;
    private readonly sequencerSessions: readonly SequencerSessionRecord[] = [];
    constructor(deps: SequencerService['deps'], ports: ToolWorkspacePort, events: EventPublisherPort, runtime: RuntimeAdapterPolicyPort) {
        this.deps = deps;
        this.ports = ports;
        this.events = events;
        this.runtime = runtime;
    }
    async runSequencerSession(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly samples: number;
        readonly role?: string;
        readonly tokenSource?: SequencerTokenSource;
        readonly tokenCookieName?: string;
        readonly tokenFieldName?: string;
        readonly tokenStartDelimiter?: string;
        readonly tokenEndDelimiter?: string;
        readonly replayRequest?: {
            readonly method?: string;
            readonly headers?: readonly (readonly [
                string,
                string
            ])[];
            readonly body?: string;
        };
        readonly signal?: AbortSignal;
    }): Promise<SequencerSessionResult> {
        requirePermission(operator, 'run.manage');
        const adapter = this.runtime.requireAdapter('sequencerTransport', this.deps.sequencerTransport, this.deps.adapterKinds?.sequencerTransport);
        const caseRecord = this.ports.currentCase();
        const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
        const decision = ScopePolicy.decide(caseRecord.scope, canonical);
        if (!decision.allowed) {
            throw domainError('OutOfScope', `sequencer target is out of scope: ${decision.reason}`);
        }
        let appliedCookies: readonly LoginSessionCookie[] | undefined;
        if (input.role !== undefined) {
            const session = this.ports.sessionForRole(input.role);
            if (session === undefined) {
                throw domainError('ValidationFailed', `no session for role '${input.role}'; run login first`);
            }
            appliedCookies = applicableSessionCookies([...session.cookies], canonical);
        }
        const plan = createSamplePlan(input.samples);
        const replayRequest = createSequencerReplayRequest(input.replayRequest);
        const collector = new SampleCollector();
        const extractor = createSequencerExtractor(input.tokenSource ?? 'body', input.tokenCookieName, input.tokenFieldName, input.tokenStartDelimiter, input.tokenEndDelimiter);
        const pattern = /token=([A-Za-z0-9_-]+)/;
        const throwIfCancelled = (): void => {
            if (input.signal?.aborted === true) {
                throw domainError('Cancelled', 'sequencer session cancelled');
            }
        };
        throwIfCancelled();
        {
            try {
                await adapter.collect({
                    targetUrl: canonical,
                    samples: plan.target,
                    replayRequest,
                    ...(input.signal === undefined ? {} : { signal: input.signal }),
                    ...(appliedCookies === undefined ? {} : {
                        sessionCookies: appliedCookies.map((cookie) => ({
                            name: cookie.name,
                            value: cookie.value,
                            domain: cookie.domain,
                            path: cookie.path,
                        })),
                    }),
                    onResponse: (response) => {
                        collector.record(extractSequencerToken(response, extractor, pattern));
                        this.ports.recordObservedExchange({ url: response.requestUrl, method: replayRequest.method, status: response.status, contentType: response.contentType }, this.deps.clock.now().toISOString(), 'sequencer');
                    },
                });
            }
            catch (cause) {
                if (input.signal?.aborted === true) {
                    throw domainError('Cancelled', 'sequencer session cancelled');
                }
                throw cause;
            }
        }
        throwIfCancelled();
        const collection = collector.snapshot();
        const projection = reportProjection(collection);
        const assessment = assess(collection.tokens);
        const sessionId = this.deps.ids.next('seq');
        const verdict = assessment.verdict;
        const record = {
            sessionId,
            targetUrl: canonical,
            tokenSource: extractor.source,
            ...(extractor.source === 'cookie' ? { tokenCookieName: extractor.cookieName } : {}),
            ...(extractor.source === 'hidden' ? { tokenFieldName: extractor.fieldName } : {}),
            ...(extractor.source === 'custom' ? { tokenStartDelimiter: extractor.startDelimiter, tokenEndDelimiter: extractor.endDelimiter } : {}),
            requestMethod: replayRequest.method,
            requestHeaderNames: replayRequest.headers.map(([name]) => name),
            requestBodyBytes: Buffer.byteLength(replayRequest.body, 'utf8'),
            verdict,
            ...projection,
            ...(verdict === 'assessed' ? {
                shannonEntropyBitsPerByte: assessment.entropy.shannonEntropyBitsPerByte,
                shannonEntropyBitsPerToken: assessment.entropy.shannonEntropyBitsPerToken,
                distinctByteValues: assessment.entropy.distinctByteValues,
                byteFrequencyBuckets: assessment.entropy.byteFrequencyBuckets,
                tokenLengthBucketMinimums: assessment.entropy.tokenLengthBucketMinimums,
                tokenByteLengthBuckets: assessment.entropy.tokenByteLengthBuckets,
                tokenCharacterLengthBuckets: assessment.entropy.tokenCharacterLengthBuckets,
                tokenMaximumCharacterRunLengthBuckets: assessment.entropy.tokenMaximumCharacterRunLengthBuckets,
                adjacentTokenBitHammingDistanceBuckets: assessment.entropy.adjacentTokenBitHammingDistanceBuckets,
                adjacentTokenHammingUnequalByteLengthPairs: assessment.entropy.adjacentTokenHammingUnequalByteLengthPairs,
                adjacentNumericAbsoluteDeltaBuckets: assessment.entropy.adjacentNumericAbsoluteDeltaBuckets,
                adjacentNumericDeltaSignCounts: assessment.entropy.adjacentNumericDeltaSignCounts,
                adjacentNumericIneligiblePairs: assessment.entropy.adjacentNumericIneligiblePairs,
                adjacentNumericSerialCorrelationPairs: assessment.entropy.adjacentNumericSerialCorrelationPairs,
                ...(assessment.entropy.adjacentNumericSerialCorrelation === undefined ? {} : { adjacentNumericSerialCorrelation: assessment.entropy.adjacentNumericSerialCorrelation }),
                observedAlphabetSize: assessment.entropy.observedAlphabetSize,
                alphabetClassCounts: assessment.entropy.alphabetClassCounts,
                positionAnalysisLimit: assessment.entropy.positionAnalysisLimit,
                positionAlphabetClassCounts: assessment.entropy.positionAlphabetClassCounts,
                positionOverflowSamples: assessment.entropy.positionOverflowSamples,
            } : { minimum: assessment.minimum }),
            ...(appliedCookies === undefined ? {} : { sessionCookieNames: appliedCookies.map((cookie) => cookie.name) }),
            executedAt: this.deps.clock.now().toISOString(),
        };
        (this.sequencerSessions as typeof record[]).push(record);
        this.events.publish({
            type: 'SequencerSessionCompleted',
            at: record.executedAt,
            sessionId,
            targetUrl: canonical,
            verdict,
            sampleCount: projection.sampleCount,
            duplicates: projection.duplicates,
            missing: projection.missing,
        });
        const { executedAt: _executedAt, ...result } = record;
        return result;
    }
    listSequencerSessions(): readonly SequencerSessionRecord[] {
        return [...this.sequencerSessions];
    }
}
