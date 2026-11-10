import { domainError, type OperatorProfile } from '@scopepilot2/contracts';
import { ScopePolicy } from '../../domain/scope-policy.ts';
import { PayloadCatalog, clusterResponses, combinationAt, planCombinations, runFuzz, type FuzzPosition, type FuzzResponseOutcome, type PayloadSetRegistration } from '../../domain/fuzzer.ts';
import { applicableSessionCookies } from '../../domain/repeater.ts';
import type { LoginSessionCookie } from '../../ports/engines.ts';
import type { BaselineFlowDeps } from '../baseline-contracts.ts';
import type { ToolWorkspacePort } from './tool-ports.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import type { RuntimeAdapterPolicyPort } from './runtime-profile.ts';
import { requirePermission } from './authorization-policy.ts';
export class FuzzerService {
    private readonly deps: Pick<BaselineFlowDeps, 'fuzzTransport' | 'clock' | 'ids' | 'runtimeProfile' | 'adapterKinds' | 'sleep'>;
    private readonly ports: ToolWorkspacePort;
    private readonly events: EventPublisherPort;
    private readonly runtime: RuntimeAdapterPolicyPort;
    private readonly payloadCatalog = new PayloadCatalog();
    private readonly payloadSetNames: string[] = [];
    private readonly payloadRegistrations = new Map<string, PayloadSetRegistration>();
    private readonly fuzzRuns: readonly {
        runId: string;
        targetUrl: string;
        total: number;
        sent: number;
        clusters: readonly {
            key: string;
            members: readonly number[];
            representative: readonly string[];
        }[];
        executedAt: string;
    }[] = [];
    constructor(deps: FuzzerService['deps'], ports: ToolWorkspacePort, events: EventPublisherPort, runtime: RuntimeAdapterPolicyPort) {
        this.deps = deps;
        this.ports = ports;
        this.events = events;
        this.runtime = runtime;
    }
    registerPayloadSet(operator: OperatorProfile, registration: PayloadSetRegistration): {
        name: string;
        valueCount: number;
    } {
        requirePermission(operator, 'run.manage');
        this.payloadCatalog.register(registration);
        this.payloadRegistrations.set(registration.name, registration);
        if (!this.payloadSetNames.includes(registration.name)) {
            this.payloadSetNames.push(registration.name);
        }
        return { name: registration.name, valueCount: registration.values.length };
    }
    listPayloadSets(): readonly {
        name: string;
        source: string;
        version: string;
        license: string;
        sha256: string;
        values: readonly string[];
    }[] {
        return this.payloadSetNames.map((name) => {
            const values = this.payloadCatalog.get(name);
            // get は values しか返さないため、登録情報は台帳から返す。
            const registration = this.payloadRegistrations.get(name);
            if (registration === undefined) {
                throw domainError('ValidationFailed', `payload set ${name} is not registered`);
            }
            return { ...registration, values };
        });
    }
    async runFuzzSession(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly positions: readonly FuzzPosition[];
        readonly maxRequests?: number;
        readonly role?: string;
    }): Promise<{
        runId: string;
        targetUrl: string;
        total: number;
        sent: number;
        clusters: readonly {
            key: string;
            members: readonly number[];
            representative: readonly string[];
        }[];
        sessionCookieNames?: readonly string[];
    }> {
        requirePermission(operator, 'run.manage');
        const adapter = this.runtime.requireAdapter('fuzzTransport', this.deps.fuzzTransport, this.deps.adapterKinds?.fuzzTransport);
        const caseRecord = this.ports.currentCase();
        const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
        const decision = ScopePolicy.decide(caseRecord.scope, canonical);
        if (!decision.allowed) {
            throw domainError('OutOfScope', `fuzz target is out of scope: ${decision.reason}`);
        }
        if (input.positions.length === 0) {
            throw domainError('ValidationFailed', 'fuzz needs at least one position');
        }
        // role session の適用 cookie (対象 URL の host/path 一致のみ。別 Origin へは送らない)。
        let appliedCookies: readonly LoginSessionCookie[] | undefined;
        if (input.role !== undefined) {
            const session = this.ports.sessionForRole(input.role);
            if (session === undefined) {
                throw domainError('ValidationFailed', `no session for role '${input.role}'; run login first`);
            }
            appliedCookies = applicableSessionCookies([...session.cookies], canonical);
        }
        const cap = input.maxRequests ?? Math.min(200, caseRecord.scope.limits.maxRequests);
        const { total } = planCombinations(input.positions, cap);
        // 実 transport 構成時は rate (2 req/s) を実時間で守る。fixture は仮想時計のまま。
        const realTransport = adapter;
        let virtualNowMs = 0;
        const outcomes: FuzzResponseOutcome[] = [];
        const result = await runFuzz({
            send: async (_index, combination) => {
                {
                    const response = await realTransport.send({
                        targetUrl: canonical,
                        combination,
                        positions: input.positions,
                        ...(appliedCookies === undefined
                            ? {}
                            : {
                                sessionCookies: appliedCookies.map((cookie) => ({
                                    name: cookie.name,
                                    value: cookie.value,
                                    domain: cookie.domain,
                                    path: cookie.path,
                                })),
                            }),
                    });
                    outcomes.push({ status: response.status, contentLength: response.contentLength, bodyHash: response.bodyHash });
                    this.ports.recordObservedExchange({ url: response.requestUrl, method: 'GET', status: response.status, contentType: response.contentType }, this.deps.clock.now().toISOString(), 'fuzzer');
                    return;
                }
            },
        }, input.positions, total, {
            isCancelled: () => false,
            now: () => (this.deps.sleep === undefined ? Date.now() : virtualNowMs),
            sleep: async (ms) => {
                if (this.deps.sleep !== undefined) {
                    await this.deps.sleep(ms);
                    virtualNowMs += ms;
                }
                else {
                    await new Promise((resolve) => {
                        setTimeout(resolve, ms);
                    });
                }
            },
        });
        const clusters = clusterResponses(outcomes).map((cluster) => ({
            ...cluster,
            representative: combinationAt(input.positions, cluster.members[0] ?? 0),
        }));
        const runId = this.deps.ids.next('fuzz');
        const record = { runId, targetUrl: canonical, total, sent: result.sent, clusters, executedAt: this.deps.clock.now().toISOString() };
        (this.fuzzRuns as {
            runId: string;
            targetUrl: string;
            total: number;
            sent: number;
            clusters: readonly {
                key: string;
                members: readonly number[];
                representative: readonly string[];
            }[];
            executedAt: string;
        }[]).push(record);
        this.events.publish({ type: 'FuzzRunCompleted', at: record.executedAt, runId, targetUrl: canonical, total, sent: result.sent });
        return {
            runId,
            targetUrl: canonical,
            total,
            sent: result.sent,
            clusters,
            // 適用した cookie は名前のみ (値は出さない — Repeater と同一規則)。
            ...(appliedCookies === undefined ? {} : { sessionCookieNames: appliedCookies.map((cookie) => cookie.name) }),
        };
    }
    listFuzzRuns(): readonly {
        runId: string;
        targetUrl: string;
        total: number;
        sent: number;
        clusters: readonly {
            key: string;
            members: readonly number[];
            representative: readonly string[];
        }[];
        executedAt: string;
    }[] {
        return [...this.fuzzRuns];
    }
}
