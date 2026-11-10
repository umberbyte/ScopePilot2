import { type PageObservation } from '@scopepilot2/contracts';
import { RoleSessionRegistry, type LoginFlowStep } from '../../domain/authentication-session.ts';
import type { BrowserSessionState, LoginSessionCookie } from '../../ports/engines.ts';
/** Memory-only browser secrets. This object is never passed to a durable repository. */
export class SessionVault {
    readonly loginFlows = new Map<string, {
        flowVersion: string;
        steps: readonly LoginFlowStep[];
        secretReferences: readonly string[];
    }>();
    readonly roleRegistry = new RoleSessionRegistry();
    readonly sessionRevisions = new Map<string, number>();
    readonly roleSessionCookies = new Map<string, {
        readonly cookies: readonly LoginSessionCookie[];
        readonly browserState: BrowserSessionState;
        readonly createdAt: string;
        readonly expectedUrlPrefix?: string;
        readonly verificationUrl?: string;
        readonly verificationMarkers?: readonly string[];
    }>();
    readonly loginObservations = new Map<string, PageObservation>();
}
