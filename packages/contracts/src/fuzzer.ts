/** Fuzzer local API: query insertion positions; response differences use the first result. */
export type FuzzAttack = 'sniper' | 'battering-ram' | 'pitchfork' | 'cluster-bomb';
export interface FuzzInput {
  readonly targetUrl: string;
  readonly positions: readonly { readonly name: string; readonly values: readonly string[]; readonly payloadSet?: string }[];
  readonly request?: { readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; readonly bodyTemplate: string; readonly contentType: string };
  readonly attack?: FuzzAttack;
  readonly maxRequests?: number;
  readonly requestsPerSecond?: number;
  readonly role?: string;
}
export interface FuzzRow {
  readonly index: number;
  readonly payload: readonly string[];
  readonly status: number;
  readonly contentLength: number;
  readonly bodyHash: string;
  readonly elapsedMs: number;
  readonly lengthDiff: number;
  readonly changed: boolean;
}
export interface FuzzPayloadSource {
  readonly position: string;
  readonly name: string;
  readonly source: string;
  readonly version: string;
  readonly sha256: string;
}
export interface FuzzRunView {
  readonly payloadSources?: readonly FuzzPayloadSource[];
  readonly runId: string;
  readonly targetUrl: string;
  readonly transport: 'fixture' | 'http';
  readonly state: 'Running' | 'Completed' | 'Stopped' | 'Failed';
  readonly total: number;
  readonly sent: number;
  readonly rows: readonly FuzzRow[];
  readonly error?: string;
}
