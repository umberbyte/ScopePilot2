/** Sequencer inputs and statistics only; raw tokens and replay values never enter results. */
export interface AlphabetClassCounts {
  readonly digit: number;
  readonly lowerAscii: number;
  readonly upperAscii: number;
  readonly base64UrlPunctuation: number;
  readonly base64StandardPunctuation: number;
  readonly padding: number;
  readonly otherAscii: number;
  readonly nonAscii: number;
}

export type SequencerTokenSource = 'body' | 'cookie' | 'hidden' | 'bearer' | 'custom';
export type SequencerSessionRecord = {
  sessionId: string;
  targetUrl: string;
  tokenSource: SequencerTokenSource;
  tokenCookieName?: string;
  tokenFieldName?: string;
  tokenStartDelimiter?: string;
  tokenEndDelimiter?: string;
  requestMethod: string;
  requestHeaderNames: readonly string[];
  requestBodyBytes: number;
  verdict: 'assessed' | 'insufficient';
  sampleCount: number;
  duplicates: number;
  missing: number;
  shannonEntropyBitsPerByte?: number;
  shannonEntropyBitsPerToken?: number;
  distinctByteValues?: number;
  byteFrequencyBuckets?: readonly number[];
  tokenLengthBucketMinimums?: readonly number[];
  tokenByteLengthBuckets?: readonly number[];
  tokenCharacterLengthBuckets?: readonly number[];
  tokenMaximumCharacterRunLengthBuckets?: readonly number[];
  adjacentTokenBitHammingDistanceBuckets?: readonly number[];
  adjacentTokenHammingUnequalByteLengthPairs?: number;
  adjacentNumericAbsoluteDeltaBuckets?: readonly number[];
  adjacentNumericDeltaSignCounts?: Readonly<{ decreasing: number; unchanged: number; increasing: number }>;
  adjacentNumericIneligiblePairs?: number;
  adjacentNumericSerialCorrelationPairs?: number;
  adjacentNumericSerialCorrelation?: number;
  observedAlphabetSize?: number;
  alphabetClassCounts?: AlphabetClassCounts;
  positionAnalysisLimit?: number;
  positionAlphabetClassCounts?: readonly AlphabetClassCounts[];
  positionOverflowSamples?: number;
  minimum?: number;
  sessionCookieNames?: readonly string[];
  executedAt: string;
};
export type SequencerSessionResult = Omit<SequencerSessionRecord, 'executedAt'>;

export interface SequencerJobParams {
  readonly targetUrl: string;
  readonly samples: number;
  readonly role?: string;
  readonly tokenSource?: SequencerTokenSource;
  readonly tokenCookieName?: string;
  readonly tokenFieldName?: string;
  readonly tokenStartDelimiter?: string;
  readonly tokenEndDelimiter?: string;
  readonly replayRequest?: { readonly method?: string; readonly headers?: readonly (readonly [string, string])[]; readonly body?: string };
}
