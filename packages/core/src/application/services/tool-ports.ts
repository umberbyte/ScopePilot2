import { type CaseRecord } from '@scopepilot2/contracts';
import type { LoginSessionCookie } from '../../ports/engines.ts';
/** Queries return memory-only session material; tools must never persist cookie values. */
export interface ToolWorkspacePort {
    currentCase(): CaseRecord;
    sessionForRole(role: string): {
        readonly cookies: readonly LoginSessionCookie[];
    } | undefined;
    recordObservedExchange(summary: {
        url: string;
        method: string;
        status: number;
        contentType: string;
    }, at: string, source: 'explore' | 'repeater' | 'fuzzer' | 'sequencer'): void;
}
