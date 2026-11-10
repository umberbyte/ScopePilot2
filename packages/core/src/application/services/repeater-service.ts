import { domainError, hashStable, type OperatorProfile } from '@scopepilot2/contracts';
import { ScopePolicy } from '../../domain/scope-policy.ts';
import { DraftRegistry, applicableSessionCookies, runRedirects, applyEdit, recordSendAttempt, renderInitialRequest, sendCommand, summarizeResponse, type RepeaterDraft, type SendAttemptRecord } from '../../domain/repeater.ts';
import type { LoginSessionCookie } from '../../ports/engines.ts';
import type { BaselineFlowDeps } from '../baseline-contracts.ts';
import type { ToolWorkspacePort } from './tool-ports.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import type { RuntimeAdapterPolicyPort } from './runtime-profile.ts';
import { requirePermission } from './authorization-policy.ts';
export class RepeaterService {
    private readonly deps: Pick<BaselineFlowDeps, 'ids' | 'repeaterTransport' | 'clock' | 'runtimeProfile' | 'adapterKinds'>;
    private readonly ports: ToolWorkspacePort;
    private readonly events: EventPublisherPort;
    private readonly runtime: RuntimeAdapterPolicyPort;
    private readonly repeaterDrafts = new DraftRegistry();
    private readonly repeaterDraftOrder: string[] = [];
    private readonly repeaterAttempts: SendAttemptRecord[] = [];
    private readonly repeaterSentCommands: import('../../domain/repeater.ts').SendCommand[] = [];
    constructor(deps: RepeaterService['deps'], ports: ToolWorkspacePort, events: EventPublisherPort, runtime: RuntimeAdapterPolicyPort) {
        this.deps = deps;
        this.ports = ports;
        this.events = events;
        this.runtime = runtime;
    }
    repeaterDraftView(draft: RepeaterDraft): {
        draftId: string;
        targetUrl: string;
        protocol: RepeaterDraft['protocol'];
        revision: number;
        requestBytes: string;
        planHash: string;
    } {
        return {
            draftId: draft.draftId,
            targetUrl: draft.targetUrl,
            protocol: draft.protocol,
            revision: draft.revision,
            requestBytes: draft.requestBytes,
            planHash: hashStable('scopepilot2.repeater.request', { bytes: draft.requestBytes, revision: draft.revision, target: draft.targetUrl }),
        };
    }
    listRepeaterDrafts(): readonly ReturnType<RepeaterService['repeaterDraftView']>[] {
        return [...this.repeaterDraftViews().values()];
    }
    private repeaterDraftViews(): Map<string, ReturnType<RepeaterService['repeaterDraftView']>> {
        const views = new Map<string, ReturnType<RepeaterService['repeaterDraftView']>>();
        for (const draft of this.listRepeaterDraftList()) {
            views.set(draft.draftId, this.repeaterDraftView(draft));
        }
        return views;
    }
    private listRepeaterDraftList(): readonly RepeaterDraft[] {
        // DraftRegistry に list は無いが service は get を id 経由で使うため、作成順を別に持つ。
        return this.repeaterDraftOrder.map((draftId) => this.repeaterDrafts.get(draftId)).filter((draft): draft is RepeaterDraft => draft !== undefined);
    }
    createRepeaterDraft(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly protocol: RepeaterDraft['protocol'];
    }): ReturnType<RepeaterService['repeaterDraftView']> {
        requirePermission(operator, 'run.manage');
        const caseRecord = this.ports.currentCase();
        const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
        const decision = ScopePolicy.decide(caseRecord.scope, canonical);
        if (!decision.allowed) {
            throw domainError('OutOfScope', `repeater target is out of scope: ${decision.reason}`);
        }
        const draft = this.repeaterDrafts.create({
            draftId: this.deps.ids.next('draft'),
            baseExchangeId: this.deps.ids.next('exchange'),
            protocol: input.protocol,
            requestBytes: renderInitialRequest(canonical),
            targetUrl: canonical,
        });
        this.repeaterDraftOrder.push(draft.draftId);
        return this.repeaterDraftView(draft);
    }
    editRepeaterDraft(operator: OperatorProfile, draftId: string, edit: {
        readonly headers: readonly (readonly [
            string,
            string
        ])[];
        readonly body: string;
    }): ReturnType<RepeaterService['repeaterDraftView']> {
        requirePermission(operator, 'run.manage');
        const draft = this.repeaterDrafts.get(draftId);
        if (draft === undefined) {
            throw domainError('ValidationFailed', `repeater draft ${draftId} does not exist`);
        }
        applyEdit(draft, edit);
        return this.repeaterDraftView(draft);
    }
    async sendRepeaterDraft(operator: OperatorProfile, draftId: string, confirmedPlanHash: string, role?: string): Promise<{
        sent: boolean;
        reason?: string;
        attempt?: SendAttemptRecord;
        response?: ReturnType<typeof summarizeResponse>;
        sessionCookieNames?: readonly string[];
    }> {
        requirePermission(operator, 'run.manage');
        const adapter = this.runtime.requireAdapter('repeaterTransport', this.deps.repeaterTransport, this.deps.adapterKinds?.repeaterTransport);
        const draft = this.repeaterDrafts.get(draftId);
        if (draft === undefined) {
            throw domainError('ValidationFailed', `repeater draft ${draftId} does not exist`);
        }
        let appliedCookies: readonly LoginSessionCookie[] | undefined;
        if (role !== undefined) {
            const session = this.ports.sessionForRole(role);
            if (session === undefined) {
                throw domainError('ValidationFailed', `no session for role '${role}'; run login first`);
            }
            appliedCookies = applicableSessionCookies([...session.cookies], draft.targetUrl);
        }
        const currentHash = hashStable('scopepilot2.repeater.request', { bytes: draft.requestBytes, revision: draft.revision, target: draft.targetUrl });
        let transportResponse: import('../../ports/engines.ts').RepeaterTransportResponse | undefined;
        const outcome = await sendCommand(draft, confirmedPlanHash, {
            send: async (command) => {
                transportResponse = await adapter.send({
                    targetUrl: draft.targetUrl,
                    requestBytes: draft.requestBytes,
                    ...(appliedCookies === undefined ? {} : { sessionCookies: appliedCookies.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path })) }),
                });
                this.repeaterSentCommands.push(command);
                this.ports.recordObservedExchange({
                    url: draft.targetUrl,
                    method: 'GET',
                    status: transportResponse.status,
                    contentType: transportResponse.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '',
                }, this.deps.clock.now().toISOString(), 'repeater');
            },
        }, appliedCookies === undefined ? undefined : [...appliedCookies]);
        if (!outcome.sent) {
            return { sent: false, reason: 'confirmed plan hash does not match the current draft (revision が進んでいないか確認してください)' };
        }
        // 実 transport の redirect は domain と同じ規則で評価する (scope 外 Location は
        // hop 前に停止 — F04-UT-004)。停止した場合は応答を返さない。
        if (transportResponse !== undefined && transportResponse.redirectLocations.length > 0) {
            const redirects = runRedirects(transportResponse.redirectLocations.map((location) => ({ location })), this.ports.currentCase().scope);
            if (redirects.outcome !== 'completed') {
                return { sent: false, reason: `redirect stopped: ${redirects.outcome}${redirects.lastReason === undefined ? '' : ` (${redirects.lastReason})`}` };
            }
        }
        const body = transportResponse!.body;
        const attempt = recordSendAttempt(draft.draftId, body);
        this.repeaterAttempts.push(attempt);
        const summaryInput = { status: transportResponse!.status, headers: transportResponse!.headers, body };
        return {
            sent: true,
            attempt,
            response: summarizeResponse(summaryInput),
            // 適用した cookie は名前のみ応答に出す (値は出さない — F09-UT-006 と同一規則)。
            ...(appliedCookies === undefined ? {} : { sessionCookieNames: appliedCookies.map((cookie) => cookie.name) }),
        };
    }
    repeaterAttemptLog(): readonly SendAttemptRecord[] {
        return [...this.repeaterAttempts];
    }
}
