import { domainError } from '@scopepilot2/contracts';
/** Composition metadata receiver; fixtures are never constructed by application services. */
export type RuntimeProfile = 'production' | 'simulation' | 'test';
export type AdapterKind = 'real' | 'fixture' | 'unavailable';
export interface RuntimeAdapterPolicyPort {
    requireAdapter<T>(name: string, adapter: T | undefined, kind?: AdapterKind): T;
}
export class RuntimeProfileService {
    readonly profile: RuntimeProfile;
    constructor(profile: RuntimeProfile = 'production') { this.profile = profile; }
    requireAdapter<T>(name: string, adapter: T | undefined, kind: AdapterKind = 'real'): T {
        if (adapter === undefined || kind === 'unavailable' || (this.profile === 'production' && kind === 'fixture')) {
            throw domainError('CapabilityUnavailable', name + ' adapter is unavailable for ' + this.profile);
        }
        return adapter;
    }
}
