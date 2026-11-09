import { domainError, type OperatorProfile } from '@scopepilot2/contracts';
import { ScopePolicy } from '../../domain/scope-policy.ts';
import { applicableSessionCookies } from '../../domain/repeater.ts';
import { buildWsSendPlan, importFrames, validateWsSubprotocols, wsEvidence, type WsFrame } from '../../domain/websocket.ts';
import type { LoginSessionCookie } from '../../ports/engines.ts';
import type { BaselineFlowDeps } from '../baseline-contracts.ts';
import type { ToolWorkspacePort } from './tool-ports.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import type { RuntimeAdapterPolicyPort } from './runtime-profile.ts';
import { requirePermission } from './authorization-policy.ts';
export class WebSocketService {
    private readonly deps: Pick<BaselineFlowDeps, 'ids' | 'clock' | 'webSocketTransport' | 'runtimeProfile' | 'adapterKinds'>;
    private readonly ports: ToolWorkspacePort;
    private readonly events: EventPublisherPort;
    private readonly runtime: RuntimeAdapterPolicyPort;
    private readonly wsFrames: WsFrame[] = [];
    private readonly wsSeenFingerprints = new Set<string>();
    private wsSessionRevision = 1;
    constructor(deps: WebSocketService['deps'], ports: ToolWorkspacePort, events: EventPublisherPort, runtime: RuntimeAdapterPolicyPort) {
        this.deps = deps;
        this.ports = ports;
        this.events = events;
        this.runtime = runtime;
    }
    importWsFrames(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly frames: readonly {
            readonly direction: 'sent' | 'received';
            readonly payload: string;
        }[];
    }): {
        imported: number;
        duplicates: number;
    } {
        requirePermission(operator, 'run.manage');
        const caseRecord = this.ports.currentCase();
        const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
        const decision = ScopePolicy.decide(caseRecord.scope, canonical);
        if (!decision.allowed) {
            throw domainError('OutOfScope', `websocket target is out of scope: ${decision.reason}`);
        }
        if (input.frames.length === 0) {
            throw domainError('ValidationFailed', 'websocket import needs at least one frame');
        }
        const staged: WsFrame[] = input.frames.map((frame, index) => ({
            frameId: this.deps.ids.next('ws'),
            direction: frame.direction,
            payload: frame.payload,
            receivedAtMs: this.deps.clock.now().getTime() + index,
        }));
        // dedupe は direction+payload の fingerprint で (frameId は取込ごとに新規のため
        // domain の id 含む fingerprint には一致しない)。呼出内と持越しの両方で重複を数える。
        const batchFingerprints = new Set<string>();
        const fresh: WsFrame[] = [];
        let duplicates = 0;
        for (const frame of staged) {
            const fingerprint = `${frame.direction}:${frame.payload}`;
            if (this.wsSeenFingerprints.has(fingerprint) || batchFingerprints.has(fingerprint)) {
                duplicates += 1;
                continue;
            }
            batchFingerprints.add(fingerprint);
            fresh.push(frame);
        }
        const { imported } = importFrames(fresh);
        for (const frame of imported) {
            this.wsSeenFingerprints.add(`${frame.direction}:${frame.payload}`);
            this.wsFrames.push(frame);
        }
        this.events.publish({ type: 'WsFramesImported', at: this.deps.clock.now().toISOString(), targetUrl: canonical, imported: imported.length, duplicates });
        return { imported: imported.length, duplicates };
    }
    listWsFrames(): readonly {
        frameId: string;
        direction: 'sent' | 'received';
        text: string;
        rawHash: string;
    }[] {
        return this.wsFrames.map((frame) => ({ frameId: frame.frameId, direction: frame.direction, text: wsEvidence(frame).text, rawHash: wsEvidence(frame).rawHash.slice(0, 12) }));
    }
    async sendWsMessages(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly messages: readonly string[];
        readonly role?: string;
        readonly subprotocols?: readonly string[];
    }): Promise<{
        planHash: string;
        sent: number;
        rejected: 'size' | 'rate' | null;
        sessionCookieNames?: readonly string[];
        negotiatedSubprotocol?: string;
    }> {
        requirePermission(operator, 'run.manage');
        const adapter = this.runtime.requireAdapter('webSocketTransport', this.deps.webSocketTransport, this.deps.adapterKinds?.webSocketTransport);
        const caseRecord = this.ports.currentCase();
        const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
        const decision = ScopePolicy.decide(caseRecord.scope, canonical);
        if (!decision.allowed) {
            throw domainError('OutOfScope', `websocket target is out of scope: ${decision.reason}`);
        }
        if (input.messages.length === 0) {
            throw domainError('ValidationFailed', 'websocket send needs at least one message');
        }
        const subprotocols = validateWsSubprotocols(input.subprotocols ?? []);
        let appliedCookies: readonly LoginSessionCookie[] | undefined;
        if (input.role !== undefined) {
            const session = this.ports.sessionForRole(input.role);
            if (session === undefined) {
                throw domainError('ValidationFailed', `no session for role '${input.role}'; run login first`);
            }
            appliedCookies = applicableSessionCookies([...session.cookies], canonical);
        }
        const plan = buildWsSendPlan({
            targetUrl: canonical,
            messages: input.messages.map((message) => ({ kind: 'text' as const, payload: message })),
            sessionRevision: this.wsSessionRevision,
            subprotocols,
        });
        {
            if (input.messages.some((message) => Buffer.byteLength(message, 'utf8') > 1000000)) {
                this.events.publish({ type: 'WsMessagesSent', at: this.deps.clock.now().toISOString(), targetUrl: canonical, sent: 0, rejected: 'size' });
                return { planHash: plan.planHash, sent: 0, rejected: 'size' };
            }
            const recordFrame = (direction: 'sent' | 'received', payload: string): void => {
                const frame: WsFrame = { frameId: this.deps.ids.next('ws'), direction, payload, receivedAtMs: this.deps.clock.now().getTime() };
                this.wsFrames.push(frame);
                this.wsSeenFingerprints.add(`${frame.direction}:${frame.payload}`);
            };
            const transported = await adapter.exchange({
                targetUrl: canonical,
                messages: input.messages,
                ...(subprotocols.length === 0 ? {} : { subprotocols }),
                ...(appliedCookies === undefined ? {} : {
                    sessionCookies: appliedCookies.map((cookie) => ({
                        name: cookie.name,
                        value: cookie.value,
                        domain: cookie.domain,
                        path: cookie.path,
                    })),
                }),
                onSentFrame: (payload) => recordFrame('sent', payload),
                onTextFrame: (payload) => recordFrame('received', payload),
            });
            this.events.publish({ type: 'WsMessagesSent', at: this.deps.clock.now().toISOString(), targetUrl: canonical, sent: transported.sent });
            return {
                planHash: plan.planHash,
                sent: transported.sent,
                rejected: null,
                ...(transported.negotiatedSubprotocol === undefined ? {} : { negotiatedSubprotocol: transported.negotiatedSubprotocol }),
                ...(appliedCookies === undefined ? {} : { sessionCookieNames: appliedCookies.map((cookie) => cookie.name) }),
            };
        }
    }
}
