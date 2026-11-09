/** A09 configuration contains references only; credentials and browser state stay transient. */
export const AuthenticationMethods = ['Form', 'Bearer', 'Basic', 'ApiKey', 'Cookie', 'Manual'] as const;
export type AuthenticationMethod = (typeof AuthenticationMethods)[number];

export interface AuthenticationUser {
  /** Unique session identity used by existing role-based execution APIs. */
  readonly role: string;
  readonly displayName: string;
  readonly authorizationRole: string;
  readonly method: AuthenticationMethod;
  readonly enabled: boolean;
}

export interface SessionVerification {
  readonly role: string;
  readonly state: 'valid' | 'expired' | 'unverified';
  readonly checkedAt: string;
  readonly source: 'adapter' | 'unavailable';
  readonly reason: string;
}

export interface AuthenticationCapabilities {
  readonly login: 'adapter' | 'unavailable';
  readonly loginEngineVersion: string | null;
  readonly verification: 'adapter' | 'unavailable';
  readonly verificationEngineVersion: string | null;
  readonly refresh: 'fixture';
  readonly executableMethods: readonly AuthenticationMethod[];
  readonly configurationStorage: 'memory';
}
