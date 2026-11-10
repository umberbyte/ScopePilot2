/** Configured absence, never a transport with empty protocol support. */
export class UnavailableCapability {
  readonly adapterKind = 'unavailable' as const;
  readonly reason: string;
  readonly version = 'unavailable';
  constructor(reason: string) { this.reason = reason; }
}
