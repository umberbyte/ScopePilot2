/** 探索の観測と診断候補。`docs/design/07-exploration-browser.md`、`docs/detailed-design/f08-browser-exploration.md`。 */

/** D-07 の 5 種 form 分類。 */
export const FormClassifications = ['search', 'login', 'data-write', 'filter', 'unknown'] as const;

export type FormClassification = (typeof FormClassifications)[number];

export interface FormFieldDescriptor {
  readonly name: string;
  readonly type: string;
}

/**
 * An attackable input observed by the browser. Values are deliberately not
 * retained: CSRF tokens, passwords and personal data must not cross the
 * renderer/API boundary just to describe scan coverage.
 */
export interface RequestInputPoint {
  readonly name: string;
  readonly location: 'query' | 'body' | 'path' | 'header' | 'cookie' | 'file';
  readonly type: string;
}

/** Sanitised HTTP request metadata captured while rendering a page. */
export interface ObservedHttpRequest {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly contentType?: string;
  readonly inputPoints: readonly RequestInputPoint[];
  readonly sourceUrl: string;
}

export interface FormDescriptor {
  readonly actionUrl: string;
  readonly method: string;
  readonly fields: readonly FormFieldDescriptor[];
  readonly classification: FormClassification;
}

export interface PageObservation {
  readonly assets?: readonly import('./assets.ts').AssetObservation[];
  readonly clientRoutes?: readonly { readonly url: string; readonly source: 'history' | 'hash' | 'workflow' }[];
  readonly discoveryLinks?: readonly { readonly url: string; readonly source: string }[];
  /** Fingerprint of bounded text for discovery negative controls. No body is returned. */
  readonly contentFingerprint?: string;
  /** canonical URL。 */
  readonly url: string;
  /** Final main-frame URL after redirects or client-side routing. */
  readonly finalUrl?: string;
  readonly status: number;
  readonly contentType: string;
  readonly title?: string;
  /** 発見元 URL。seed の場合は null。 */
  readonly discoveredFrom: string | null;
  readonly depth: number;
  readonly originType: 'crawl' | 'document-hint';
  readonly links: readonly string[];
  /**
   * SPA route templates (absolute, same-origin, with `:param` segments) found
   * in already-loaded scripts. Templates are discovery facts only: they are
   * never navigated as-is, only instantiated with observed resource ids.
   */
  readonly routeTemplates?: readonly string[];
  /**
   * Identifier-like values (short numerics, UUIDs) observed in same-origin API
   * JSON responses and in request URL path segments while rendering the page.
   * They ground dynamic route instantiation; response bodies are not retained.
   */
  readonly observedResourceIds?: readonly string[];
  /**
   * HTTP API calls extracted from already-loaded application scripts
   * (absolute, same-origin). Write methods (POST/PUT/PATCH/DELETE) only fire
   * on user interaction and are invisible to browse-only crawling, so their
   * definition in the client code is the discovery evidence. Script bodies
   * are not retained.
   */
  readonly scriptApiCalls?: readonly { readonly url: string; readonly method: string }[];
  readonly forms: readonly FormDescriptor[];
  /** Same-origin browser requests. No header/body values are retained. */
  readonly requests?: readonly ObservedHttpRequest[];
  /** DOMから実測したクライアント側実行要素。値やスクリプト本文は保存しない。 */
  readonly javascriptSignals?: {
    readonly scriptElements: number;
    readonly inlineEventHandlers: number;
    readonly javascriptUrls: number;
  };
}

export const CandidateCategories = ['page', 'form', 'api-endpoint'] as const;

export type CandidateCategory = (typeof CandidateCategories)[number];

/** 候補は観測事実から生成される。guidelineBasis は例えば `WSTG-INFO-06` の参照識別子。 */
export interface ScanCandidate {
  readonly score?: number;
  readonly scoreSignals?: readonly string[];
  readonly provenance?: readonly { readonly source: string; readonly url: string }[];
  readonly candidateId: string;
  readonly url: string;
  readonly method: string;
  readonly category: CandidateCategory;
  readonly guidelineBasis: readonly string[];
  readonly confidence: number;
  /** provenance: この候補の根拠となった観測 URL。 */
  readonly observationUrl: string;
  /** 探索結果からこの候補を作った理由。UI で採否判断の根拠として表示する。 */
  readonly detectionReason?: string;
  /** 静的なページ遷移ではなく、入力・状態変化を伴う候補なら true。 */
  readonly dynamic?: boolean;
  /** Concrete insertion points which justify active testing. */
  readonly inputPoints?: readonly RequestInputPoint[];
  /** Sanitised browser request that produced this candidate. */
  readonly requestId?: string;
  /** Observed request media type; parameters such as multipart boundaries may be replaced on replay. */
  readonly contentType?: string;
  /** Engine/workflow tracks required for meaningful coverage. */
  readonly diagnosticTracks?: readonly DiagnosticTrack[];
}

export const DiagnosticTracks = [
  'zap-active',
  'browser-dom',
  'workflow-state',
  'session-analysis',
  'authorization-differential',
  'upload-workflow',
  'api-schema',
  'cryptography-review',
] as const;

export type DiagnosticTrack = (typeof DiagnosticTracks)[number];
