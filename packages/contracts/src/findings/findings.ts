/** 所見の契約型。`docs/design/17-organizer-reporting.md`、`docs/detailed-design/f19-organizer-reporting.md`。 */

export type FindingSourceKind =
  | 'zap-alert'
  | 'nuclei-match'
  | 'observation'
  | 'document-hint'
  | 'ai-proposal'
  | 'manual';

/** engine 由来の所見は常に `unverified: true` (実影響未確認)。 */
export interface FindingSource {
  readonly kind: FindingSourceKind;
  readonly engineVersion?: string;
  readonly unverified: boolean;
}

export type FindingStatus = 'candidate' | 'confirmed' | 'rejected' | 'merged';

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'unknown';

export interface Finding {
  readonly findingId: string;
  readonly title: string;
  readonly source: FindingSource;
  readonly url: string;
  readonly method?: string;
  readonly param?: string;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly evidenceRefs: readonly string[];
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** 重複除外後の再観測回数。1 が初回。 */
  readonly occurrences: number;
  readonly enginePluginId?: string;
}
