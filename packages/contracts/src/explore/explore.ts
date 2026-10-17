/** 探索の観測と診断候補。`docs/design/07-exploration-browser.md`、`docs/detailed-design/f08-browser-exploration.md`。 */

/** D-07 の 5 種 form 分類。 */
export type FormClassification = 'search' | 'login' | 'data-write' | 'filter' | 'unknown';

export interface FormFieldDescriptor {
  readonly name: string;
  readonly type: string;
}

export interface FormDescriptor {
  readonly actionUrl: string;
  readonly method: string;
  readonly fields: readonly FormFieldDescriptor[];
  readonly classification: FormClassification;
}

export interface PageObservation {
  /** canonical URL。 */
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly title?: string;
  /** 発見元 URL。seed の場合は null。 */
  readonly discoveredFrom: string | null;
  readonly depth: number;
  readonly originType: 'crawl' | 'document-hint';
  readonly links: readonly string[];
  readonly forms: readonly FormDescriptor[];
}

export type CandidateCategory = 'page' | 'form' | 'api-endpoint';

/** 候補は観測事実から生成される。guidelineBasis は例えば `WSTG-INFO-06` の参照識別子。 */
export interface ScanCandidate {
  readonly candidateId: string;
  readonly url: string;
  readonly method: string;
  readonly category: CandidateCategory;
  readonly guidelineBasis: readonly string[];
  readonly confidence: number;
  /** provenance: この候補の根拠となった観測 URL。 */
  readonly observationUrl: string;
}
