/** Sanitised, passive observations. Bodies, tokens and key material never cross this boundary. */
export interface ClientReviewSignal {
  readonly kind: 'dependency' | 'typosquatting' | 'unsafe-api' | 'component-db' | 'jwt' | 'public-key' | 'secret';
  readonly ruleId: string;
  readonly confidence: number;
  readonly detail: string;
  readonly fingerprint?: string;
  readonly component?: { readonly name: string; readonly version?: string };
}

export interface AssetObservation {
  readonly url: string;
  readonly sourceUrl: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly analyzerVersion: string;
  readonly signals: readonly ClientReviewSignal[];
  readonly database?: { readonly source: string; readonly version: string; readonly sha256: string };
}

export type DiscoverySource = 'robots' | 'sitemap' | 'manifest' | 'wordlist';
