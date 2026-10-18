/** 所見の契約型。`docs/design/17-organizer-reporting.md`、`docs/detailed-design/f19-organizer-reporting.md`。 */

export const FindingSourceKinds = [
  'zap-alert',
  'nuclei-match',
  'observation',
  'document-hint',
  'ai-proposal',
  'manual',
] as const;

export type FindingSourceKind = (typeof FindingSourceKinds)[number];

/** engine 由来の所見は常に `unverified: true` (実影響未確認)。 */
export interface FindingSource {
  readonly kind: FindingSourceKind;
  readonly engineVersion?: string;
  readonly unverified: boolean;
}

export const FindingStatuses = ['candidate', 'confirmed', 'rejected', 'merged'] as const;

export type FindingStatus = (typeof FindingStatuses)[number];

export const FindingSeverities = ['info', 'low', 'medium', 'high', 'unknown'] as const;

export type FindingSeverity = (typeof FindingSeverities)[number];

export interface Finding {
  readonly findingId: string;
  readonly title: string;
  readonly source: FindingSource;
  readonly url: string;
  readonly method?: string;
  readonly param?: string;
  readonly severity: FindingSeverity;
  /** engine 由来の severity 原値。正規化で値が変わる場合に併記する (f18 §5)。 */
  readonly sourceSeverity?: string;
  readonly status: FindingStatus;
  readonly evidenceRefs: readonly string[];
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** 重複除外後の再観測回数。1 が初回。 */
  readonly occurrences: number;
  readonly enginePluginId?: string;
}
