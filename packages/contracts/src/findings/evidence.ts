/** Public projection only. Original bodies and filesystem locations never cross the API. */
export interface EvidenceView {
  readonly evidenceId: string;
  readonly sha256: string;
  readonly savedAt: string;
  readonly kind: "original";
  readonly findingIds: readonly string[];
  readonly source: string;
  readonly sourceRunId: string | null;
  readonly sourceJobId: string | null;
  readonly display: {
    readonly kind: "display";
    readonly request: string | null;
    readonly response: string | null;
    readonly bodies: "omitted";
  };
  readonly sharing: "not-generated";
}
