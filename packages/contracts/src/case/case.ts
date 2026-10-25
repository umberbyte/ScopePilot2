/** 案件・scope・認可の契約型。`docs/design/02-case-scope-authorization.md`、`docs/detailed-design/f01-case-scope-authorization.md`。 */
export const OperationClasses = [
  'Passive',
  'Browse',
  'FormSubmit',
  'Upload',
  'ActiveCrawl',
  'ActiveScan',
  'Fuzz',
  'ApiSend',
  'WebSocketSend',
  'NucleiScan',
  'CrossRoleTest',
] as const;

export type OperationClass = (typeof OperationClasses)[number];

/** 案件共有の安全上限。plan の上限はこの範囲内に収まる。 */
export interface ScopeLimits {
  readonly maxRequests: number;
  readonly maxPages: number;
  readonly maxDurationMinutes: number;
}

/** deny を allow より優先する。origin は canonical 形式 (ScopePolicy.canonicalOrigin) で比較する。 */
export interface CaseScope {
  readonly allowedOrigins: readonly string[];
  readonly deniedOrigins: readonly string[];
  readonly limits: ScopeLimits;
}

export type ScopeDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** 証拠の原本参照。秘密値そのものは保持しない。 */
export interface EvidenceRef {
  readonly evidenceId: string;
  readonly sha256: string;
  readonly label: string;
}

export interface AuthorizationRecord {
  readonly authorizationId: string;
  readonly caseId: string;
  readonly allowedOperationClasses: readonly OperationClass[];
  readonly targetRoles: readonly string[];
  readonly validFrom: string;
  readonly validUntil: string;
  readonly evidenceRef: EvidenceRef;
}

export interface CaseRecord {
  readonly caseId: string;
  readonly name: string;
  readonly revision: number;
  readonly scope: CaseScope;
  readonly createdAt: string;
}
