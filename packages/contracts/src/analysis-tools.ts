/** Local analysis utilities; none of these operations send target requests. */
export interface FingerprintResult {
  readonly sha256: string;
  readonly md5: string;
}

export interface BinaryComparisonResult {
  readonly equal: boolean;
  readonly leftBytes: number;
  readonly rightBytes: number;
  readonly firstDifferenceOffset: number | null;
  readonly commonPrefixBytes: number;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly rows: readonly { readonly offset: number; readonly leftHex: string; readonly rightHex: string }[];
  readonly differingRows: number;
  readonly truncated: boolean;
  readonly provenance: { readonly leftHash: string; readonly rightHash: string; readonly options: { readonly normalizeNewlines?: boolean; readonly ignoreHeaderOrder?: boolean } };
}
