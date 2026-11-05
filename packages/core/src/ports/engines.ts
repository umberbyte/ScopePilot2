/** 外部 engine への port。adapters が実装し、simulation は固定 fixture で実装する。 */
import type { ActiveScanRequest, EngineAlert, EngineProgress, ObservedHttpRequest, PageObservation, RequestInputPoint } from '@scopepilot2/contracts';
import type { LoginFlowStep } from '../domain/authentication-session.ts';

/** payload 実行検証の結果 (browser で攻撃コードが実際に実行されたか)。 */
export interface PayloadExecutionVerification {
  /** dialog (alert/confirm/prompt) の発火など、コード実行の根拠が得られたか。 */
  readonly executed: boolean;
  /** 実行の根拠となった信号 (dialog 種別と先頭のみ。長文は切り詰める)。 */
  readonly signals: readonly string[];
}

/** 探索 (Playwright 相当)。実 adapter は browser context の request interception で scope を強制する。 */
export interface ExplorationPort {
  readonly engineVersion: string;
  observe(url: string): Promise<PageObservation | null>;
  /**
   * Observe with an authenticated browser state. Implementations must keep
   * storage values in memory only and must not place them in observations,
   * events, evidence, or API responses.
   */
  observeWithSession?(url: string, session: BrowserSessionState): Promise<PageObservation | null>;
  /**
   * 検証用 URL (payload 付き) を実 browser で開き、攻撃コードの実行 (dialog 発火等)
   * を観測する (design/f08: 反射の所見と実行確認を区別する)。未実装は省略可能。
   */
  verifyPayloadExecution?(url: string, session?: BrowserSessionState): Promise<PayloadExecutionVerification>;
}

/** 認証済み session の cookie (探索・診断へ一時的に渡す。永続層へ置かない)。 */
export interface LoginSessionCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
}

/** A browser storage value. The value is secret-bearing and memory-only. */
export interface BrowserStorageEntry {
  readonly name: string;
  readonly value: string;
}

/** Origin-scoped storage captured from an authenticated browser context. */
export interface BrowserOriginStorage {
  readonly origin: string;
  readonly localStorage: readonly BrowserStorageEntry[];
  readonly sessionStorage: readonly BrowserStorageEntry[];
}

/**
 * Authenticated browser state used only between Core and browser adapters.
 * It is deliberately absent from contracts and persistence repositories.
 */
export interface BrowserSessionState {
  readonly cookies: readonly LoginSessionCookie[];
  readonly origins: readonly BrowserOriginStorage[];
}

/** 能動診断 engine (ZAP 相当、Delegated)。停止は冪等とする (F11-UT-005)。 */
export interface ActiveScanEnginePort {
  readonly engineVersion: string;
  start(request: ActiveScanRequest, context?: ActiveScanExecutionContext): Promise<string>;
  progress(engineRunId: string): Promise<EngineProgress>;
  alerts(engineRunId: string, cursor: number): Promise<{ readonly alerts: readonly EngineAlert[]; readonly nextCursor: number }>;
  stop(engineRunId: string): Promise<void>;
}

/**
 * Sensitive and request-specific data used only at the Core -> adapter call.
 * It is intentionally separate from ActiveScanRequest because that object is
 * returned by the local API and rendered in the UI.
 */
export interface ActiveScanExecutionContext {
  readonly sessionCookies?: readonly LoginSessionCookie[];
  readonly requestSeeds: readonly {
    readonly url: string;
    readonly method: string;
    readonly contentType?: string;
    readonly inputPoints: readonly RequestInputPoint[];
  }[];
  readonly expectedAuthenticatedUrlPrefix?: string;
  readonly authenticationProbe?: {
    readonly url: string;
    readonly markers: readonly string[];
  };
}

/** Nuclei CLIによる既知脆弱性診断。対象snapshotはCoreでscope確認してから渡す。 */
export interface NucleiScanPort {
  readonly engineVersion: string;
  readonly templateBundleHash?: string;
  run(input: {
    readonly targets: readonly string[];
    readonly limits: {
      readonly maxRequests: number;
      readonly maxDurationMinutes: number;
      readonly maxConcurrency: number;
      readonly requestsPerSecond: number;
    };
    readonly signal?: AbortSignal;
    /** Nuclei の進捗・統計出力。JSONL 所見とは分離された表示専用ログ。 */
    readonly onLog?: (line: string) => void;
    /** 審査済み manifest のうち指定 id だけを実行する (テーマ22等のスポット実行)。 */
    readonly templateIds?: readonly string[];
  }): Promise<{ readonly lines: readonly string[] }>;
}

export interface LoginExecutionInput {
  /** 対象の base (login URL・期待 URL prefix の解決に使う)。 */
  readonly baseUrl: string;
  /** f09 の step DSL。fill の secretReference は secretValues の key として解決する。 */
  readonly steps: readonly LoginFlowStep[];
  /** 秘密値は実行中のみ使い、監査・応答へ出さない (F09-UT-006)。 */
  readonly secretValues: Readonly<Record<string, string>>;
  /** 認証済みと判断する最終 URL prefix (URL 一致だけでは足りない — assert と併用)。 */
  readonly expectedUrlPrefix: string;
  /** 経由する proxy (例: ZAP。login を通すことで engine 側の cookie jar へ session を渡す)。 */
  readonly proxyServer?: string;
}

export interface LoginExecutionResult {
  readonly authenticated: boolean;
  readonly finalUrl: string;
  readonly cookies: readonly LoginSessionCookie[];
  /** Full browser state for cookie-, localStorage-, and sessionStorage-based applications. */
  readonly browserState?: BrowserSessionState;
  /**
   * login 実行中に観測した同一Originリクエスト (入力点の名前・種類のみ。値は含まない)。
   * SPA の XHR 裏付け認証 API (POST /login 相当) は探索では観測できないため、
   * 診断候補の根拠として使う。秘密値が観測結果へ露出しないことは契約で保証する。
   */
  readonly observedRequests?: readonly ObservedHttpRequest[];
}

/** login 実行 (browser 駆動・f09 相当)。実 adapter は Playwright、UT は fake で差し替える。 */
export interface LoginExecutorPort {
  readonly engineVersion: string;
  execute(input: LoginExecutionInput): Promise<LoginExecutionResult>;
}

/**
 * 許可済み fixture の OTP inbox (テーマ6 OTP sub-check 用)。
 * mailboxRef は秘密値ではなく、事前審査済み fixture 設定の参照。実 adapter は
 * 許可された fixture だけを接続先とし、任意の外部 mailbox へ接続しない。
 * OTP 値は Core と adapter の呼び出し中だけ保持し、probe 結果・証跡へ保存しない。
 */
export interface OtpInboxPort {
  readonly engineVersion: string;
  waitForOtp(input: {
    readonly mailboxRef: string;
    readonly issuedAfter: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly otp: string; readonly receivedAt: string } | null>;
}

/**
 * 隔離された試験 IdP / SP を使う SAML assertion replay (テーマ6 sub-check 用)。
 * Core は直接送信せず、事前審査済み fixture adapter が全体を駆動する
 * (IdP / SP の両方が隔離 fixture であることを adapter 側で保証する)。
 * assertion 本文・署名・NameID は adapter の呼び出し中だけ保持し、
 * 返り値には hash だけを載せる。新しい assertion の生成・改ざんは行わない。
 * replayAccepted は「同一 assertion の再送が新しい session として受理された」
 * 観測 (単なる既存 session 継続とは区別)。区別できなければ null。
 */
export interface SamlFixturePort {
  readonly engineVersion: string;
  issueAndReplay(input: {
    readonly idpStartUrl: string;
    readonly acsUrl: string;
    readonly role: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly controlAccepted: boolean;
    readonly replayAccepted: boolean | null;
    readonly controlStatus: number | null;
    readonly replayStatus: number | null;
    readonly assertionHash: string;
  }>;
}

/** proxy listener が傍受した通信の観測 (design/f02)。値は core へ渡す素材のみ。 */
export interface ObservedProxyMessage {
  readonly messageReference: string;
  readonly method: string;
  readonly url: string;
  readonly direction: 'sent' | 'received';
}

/** Repeater 実送信の結果 (f04)。binary は text 化せず bytes のみ返す。 */
export interface RepeaterTransportResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Buffer;
  readonly redirectLocations: readonly string[];
}

/** Fuzz 実送信の 1 件の結果 (f05)。cluster 集約の素材のみ。 */
export interface FuzzTransportResponse {
  /** 実際に送信した URL（position を query parameter へ適用済み）。 */
  readonly requestUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly contentLength: number;
  readonly bodyHash: string;
}

/** Fuzz の実 transport。未構成の service は fixture 応答を使う。 */
export interface FuzzTransportPort {
  send(input: {
    readonly targetUrl: string;
    readonly combination: readonly string[];
    readonly positions: readonly { readonly name: string; readonly values: readonly string[] }[];
    readonly sessionCookies?: readonly { readonly name: string; readonly value: string; readonly domain: string; readonly path: string }[];
  }): Promise<FuzzTransportResponse>;
}

/** Sequencer の 1 応答。body は token 抽出 callback の間だけ保持し、保存しない。 */
export interface SequencerTransportResponse {
  readonly requestUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  /** Raw Set-Cookie lines. Core extracts during the callback; adapters and ledgers must not retain them. */
  readonly setCookieHeaders?: readonly string[];
  /** Response Authorization value. Core extracts Bearer during the callback; never retain it. */
  readonly authorizationHeader?: string;
}

/** Sequencer の実収集 transport。adapter 内で rate を守り、応答を逐次 core へ渡す。 */
export interface SequencerTransportPort {
  collect(input: {
    readonly targetUrl: string;
    readonly samples: number;
    /** Coreで検証済みの採取専用再送要求。値はtransport外へ保存しない。 */
    readonly replayRequest: import('../domain/sequencer.ts').SequencerReplayRequest;
    /** Stop before the next request and abort an in-flight request when signalled. */
    readonly signal?: AbortSignal;
    /** Core-filtered role cookies for this target. Values must stay inside the transport. */
    readonly sessionCookies?: readonly LoginSessionCookie[];
    readonly onResponse: (response: SequencerTransportResponse) => void;
  }): Promise<void>;
}

/** OAST provider が background poll で渡す正規化済み callback。 */
export interface OastProviderEvent {
  readonly eventId: string;
  readonly token: string;
  readonly payload: string;
}

/**
 * OAST provider session。実 adapter は明示設定された外部 runtime だけを起動し、
 * callback を逐次 core へ渡す。token/config secret は監査へ渡さない。
 */
export interface OastProviderPort {
  readonly supportedProtocols: readonly ('http' | 'dns' | 'smtp' | 'icmp')[];
  startSession(input: {
    readonly attemptId: string;
    readonly protocol: 'http' | 'dns' | 'smtp' | 'icmp';
    readonly onEvents: (events: readonly OastProviderEvent[]) => void;
  }): Promise<{ readonly token: string }>;
}

/** WebSocket text message の実送受信。scope と size は core、rate は adapter でも強制する。 */
export interface WebSocketTransportPort {
  exchange(input: {
    /** 案件 scope と同じ http(s) URL。adapter 内で ws(s) へ写像する。 */
    readonly targetUrl: string;
    readonly messages: readonly string[];
    /** Handshake Origin. Omitted for normal product traffic; CSWSH checks set this explicitly. */
    readonly origin?: string;
    /** Ordered client offer for Sec-WebSocket-Protocol. */
    readonly subprotocols?: readonly string[];
    /** Core-filtered role cookies for the handshake target. Values must stay inside the transport. */
    readonly sessionCookies?: readonly LoginSessionCookie[];
    readonly onSentFrame: (payload: string) => void;
    readonly onTextFrame: (payload: string) => void;
  }): Promise<{ readonly sent: number; readonly negotiatedSubprotocol?: string }>;
}

/** HTTP/2 capability probe. Scope is enforced by core before this port is called. */
export interface TransportProbeResponseEvidence {
  readonly statusCode: number;
  /** Elapsed time through the bounded response body, measured by the adapter. */
  readonly elapsedMs: number;
  /** Present only for an HTTP/2 response stream. */
  readonly streamId?: number;
  /** Selected peer settings; absent for HTTP/1.1. */
  readonly remoteSettings?: {
    readonly headerTableSize?: number;
    readonly enablePush?: boolean;
    readonly initialWindowSize?: number;
    readonly maxFrameSize?: number;
    readonly maxConcurrentStreams?: number;
    readonly maxHeaderListSize?: number;
  };
}

export interface AdvancedTransportPort {
  probe(input: {
    readonly targetUrl: string;
    /** Protocol selected by the caller. HTTP/3 is rejected by core before this port is called. */
    readonly requested: 'h2' | 'http/1.1';
    /** When h2 is requested, an HTTP/1.1 fallback request may only be sent when this flag is true. */
    readonly allowFallback: boolean;
  }): Promise<{
    /** Protocols usable by the completed probe, or detected during negotiation. */
    readonly offered: readonly ('h2' | 'http/1.1')[];
    /** TLS ALPN result, or an explicit h2c marker for cleartext HTTP/2. */
    readonly alpn: string;
    readonly runtime: string;
    /** Present only when this probe sent a request and received a complete bounded response. */
    readonly response?: TransportProbeResponseEvidence;
  }>;
}

/** Browser-backed DOM source/sink observation. Core still owns permission and target scope. */
export interface DomObservationPort {
  observe(input: {
    readonly targetUrl: string;
    /** Passed through so the browser adapter can enforce scope for every subrequest/frame. */
    readonly scope: {
      readonly allowedOrigins: readonly string[];
      readonly deniedOrigins: readonly string[];
    };
    /** Core-filtered role cookies for this target. Values must stay inside the browser operation. */
    readonly sessionCookies?: readonly LoginSessionCookie[];
  }): Promise<{
    readonly observations: readonly { readonly api: string; readonly marker: string }[];
    readonly nodes: readonly { readonly text: string; readonly looksLikePii: boolean }[];
  }>;
}

/** A deliberately small browser action DSL used by AI-planned, operator-confirmed diagnostics. */
export type InteractiveBrowserStep =
  | { readonly kind: 'navigate' | 'click' | 'wait' | 'assert'; readonly target: string }
  | { readonly kind: 'fill' | 'select' | 'assertValue'; readonly target: string; readonly value: string }
  | { readonly kind: 'upload'; readonly target: string; readonly inputRef: string };

export interface InteractiveBrowserFile {
  readonly inputRef: string;
  readonly name: string;
  readonly mimeType: string;
  readonly dataBase64: string;
}

/**
 * Executes only the allow-listed browser DSL. The adapter must enforce scope for the top-level
 * navigation and every subrequest, and must not retain cookies or uploaded bytes.
 */
export interface InteractiveBrowserPort {
  readonly engineVersion: string;
  execute(input: {
    readonly targetUrl: string;
    readonly scope: {
      readonly allowedOrigins: readonly string[];
      readonly deniedOrigins: readonly string[];
    };
    readonly steps: readonly InteractiveBrowserStep[];
    readonly sessionCookies?: readonly LoginSessionCookie[];
    readonly files?: readonly InteractiveBrowserFile[];
  }): Promise<{
    readonly finalUrl: string;
    readonly status: number | null;
    readonly bodyHash: string;
    /** Transient, bounded response material for allow-listed assertions. Callers must not persist it. */
    readonly bodyText: string;
    readonly headers: readonly (readonly [string, string])[];
    readonly elapsedMs: number;
    readonly assertions: readonly { readonly kind: 'assert' | 'assertValue'; readonly target: string; readonly passed: boolean }[];
  }>;
}

/** Repeater の実 transport (実 HTTP 送信)。未構成の service は fixture 応答を使う。 */
export interface RepeaterTransportPort {
  send(input: {
    readonly targetUrl: string;
    readonly requestBytes: string;
    readonly sessionCookies?: readonly { readonly name: string; readonly value: string; readonly domain: string; readonly path: string }[];
  }): Promise<RepeaterTransportResponse>;
}

/** 実 proxy listener (ZAP daemon 等)。core は判断 (scope 強制) を持ち、ここは運搬。 */
export interface ProxyListenerPort {
  startSession(): Promise<void>;
  stopSession(): Promise<void>;
  observeMessages(cursor: number, count: number): Promise<{ readonly messages: readonly ObservedProxyMessage[]; readonly nextCursor: number }>;
}
