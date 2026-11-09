import { domainError, type OperatorProfile } from '@scopepilot2/contracts';
import { SessionCoordinator, checkFlowDeadline, validateLoginFlow, vaultEvidenceProjection, type LoginFlowStep } from '../../domain/authentication-session.ts';
import type { BaselineFlowDeps } from '../baseline-contracts.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import type { SessionVault } from './session-vault.ts';
import { requirePermission } from './authorization-policy.ts';
export interface SessionServicePorts {
}
export class SessionService {
    private readonly deps: Pick<BaselineFlowDeps, 'loginExecutor' | 'clock' | 'loginProxyServer' | 'ids'>;
    private readonly ports: SessionServicePorts;
    private readonly events: EventPublisherPort;
    private readonly vault: SessionVault;
    private readonly sessionCoordinator = new SessionCoordinator({
        refresh: async (role: string) => {
            // Coordinator bookkeeping token only; preserves the existing refresh/lockout contract.
            return `session-${role}-${this.deps.ids.next('token')}`;
        },
    });
    constructor(deps: SessionService['deps'], ports: SessionServicePorts, events: EventPublisherPort, vault: SessionVault) {
        this.deps = deps;
        this.ports = ports;
        this.events = events;
        this.vault = vault;
    }
    registerLoginFlow(operator: OperatorProfile, input: {
        readonly role: string;
        readonly flowVersion: string;
        readonly steps: readonly LoginFlowStep[];
    }): {
        role: string;
        stepCount: number;
        secretReferences: readonly {
            flowVersion: string;
            secretReference: string;
        }[];
    } {
        requirePermission(operator, 'run.manage');
        if (input.role.trim() === '') {
            throw domainError('ValidationFailed', 'role must not be empty');
        }
        if (input.steps.some((step) => (step as {
            secretValue?: unknown;
        }).secretValue !== undefined)) {
            // secret 値の持ち込みは最初から拒否 (F09-UT-006: 参照のみ)。
            throw domainError('ValidationFailed', 'inline secret values are not accepted; use secretReference');
        }
        const { stepCount } = validateLoginFlow(input.steps);
        const secretReferences = input.steps
            .filter((step) => step.secretReference !== undefined)
            .map((step) => vaultEvidenceProjection({ flowVersion: input.flowVersion, secretReference: step.secretReference ?? '' }));
        this.vault.loginFlows.set(input.role, { flowVersion: input.flowVersion, steps: input.steps, secretReferences: secretReferences.map((entry) => entry.secretReference) });
        return { role: input.role, stepCount, secretReferences };
    }
    async runLogin(operator: OperatorProfile, input: {
        readonly role: string;
        readonly baseUrl: string;
        readonly secretValues: Readonly<Record<string, string>>;
        readonly expectedUrlPrefix: string;
        readonly proxyServer?: string;
    }): Promise<{
        role: string;
        authenticated: boolean;
        finalUrl: string;
        cookieNames: readonly string[];
        sharedCookieNames: boolean;
    }> {
        requirePermission(operator, 'run.manage');
        const flow = this.vault.loginFlows.get(input.role);
        if (flow === undefined) {
            throw domainError('ValidationFailed', `login flow for ${input.role} is not registered`);
        }
        const executor = this.deps.loginExecutor;
        if (executor === undefined) {
            throw domainError('ValidationFailed', 'login executor is not configured for this service');
        }
        for (const reference of flow.secretReferences) {
            if (input.secretValues[reference] === undefined) {
                throw domainError('NeedsInput', `secret value for reference '${reference}' was not provided`);
            }
        }
        const startedAtMs = this.deps.clock.now().getTime();
        const result = await executor.execute({
            baseUrl: input.baseUrl,
            steps: flow.steps,
            secretValues: input.secretValues,
            expectedUrlPrefix: input.expectedUrlPrefix,
            ...((input.proxyServer ?? this.deps.loginProxyServer) === undefined
                ? {}
                : { proxyServer: input.proxyServer ?? this.deps.loginProxyServer }),
        });
        checkFlowDeadline(this.deps.clock.now().getTime() - startedAtMs);
        if (result.authenticated) {
            this.vault.roleSessionCookies.set(input.role, {
                cookies: result.cookies,
                browserState: result.browserState ?? { cookies: result.cookies, origins: [] },
                createdAt: this.deps.clock.now().toISOString(),
                expectedUrlPrefix: input.expectedUrlPrefix,
                verificationUrl: result.finalUrl,
                verificationMarkers: flow.steps.flatMap((step) => step.kind === 'assert' && step.target !== undefined ? [step.target] : []),
            });
        }
        // login 実行時の観測を候補の根拠として保持する (探索結果へ合成する)。
        // 観測には値が含まれず、scope は探索の合成時に改めて判定する。
        if ((result.observedRequests?.length ?? 0) > 0) {
            this.vault.loginObservations.set(input.role, {
                url: result.finalUrl,
                status: result.authenticated ? 200 : 401,
                contentType: 'text/html',
                discoveredFrom: null,
                depth: 0,
                originType: 'crawl',
                links: [],
                forms: [],
                requests: result.observedRequests!,
            });
        }
        const cookieNames = result.cookies.map((cookie) => cookie.name);
        const jar = this.vault.roleRegistry.assignJar(input.role, cookieNames);
        this.events.publish({
            type: 'LoginCompleted',
            at: this.deps.clock.now().toISOString(),
            role: input.role,
            authenticated: result.authenticated,
            secretReferences: flow.secretReferences,
        });
        return { role: input.role, authenticated: result.authenticated, finalUrl: result.finalUrl, cookieNames, sharedCookieNames: jar.shared };
    }
    listSessions(): readonly {
        role: string;
        flowVersion: string;
        stepCount: number;
        secretReferences: readonly string[];
        cookieNames: readonly string[];
        sessionRevision: number;
        verificationUrl: string | null;
    }[] {
        return [...this.vault.loginFlows.keys()].map((role) => {
            const flow = this.vault.loginFlows.get(role);
            if (flow === undefined) {
                throw domainError('ValidationFailed', `login flow for ${role} is not registered`);
            }
            const jar = this.vault.roleRegistry.jarOf(role);
            return {
                role,
                flowVersion: flow.flowVersion,
                stepCount: flow.steps.length,
                secretReferences: flow.secretReferences,
                cookieNames: jar?.cookieNames ?? [],
                sessionRevision: this.vault.sessionRevisions.get(role) ?? 0,
                verificationUrl: this.vault.roleSessionCookies.get(role)?.verificationUrl ?? null,
            };
        });
    }
    async refreshSession(operator: OperatorProfile, role: string): Promise<{
        outcome: 'refreshed' | 'stopped-lockout-guard';
        sessionRevision: number;
    }> {
        requirePermission(operator, 'run.manage');
        if (!this.vault.loginFlows.has(role)) {
            throw domainError('ValidationFailed', `login flow for ${role} is not registered`);
        }
        const result = await this.sessionCoordinator.refresh(role);
        if (result.outcome === 'refreshed') {
            this.vault.sessionRevisions.set(role, result.sessionRevision);
        }
        return result;
    }
    assignRoleCookies(operator: OperatorProfile, role: string, cookieNames: readonly string[]): {
        role: string;
        shared: boolean;
    } {
        requirePermission(operator, 'run.manage');
        if (!this.vault.loginFlows.has(role)) {
            throw domainError('ValidationFailed', `login flow for ${role} is not registered`);
        }
        return this.vault.roleRegistry.assignJar(role, cookieNames);
    }
}
