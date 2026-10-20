/** 外部 engine への port。adapters が実装し、simulation は固定 fixture で実装する。 */
import type { ActiveScanRequest, EngineAlert, EngineProgress, PageObservation } from '@scopepilot2/contracts';
import type { LoginFlowStep } from '../domain/authentication-session.ts';

/** 探索 (Playwright 相当)。実 adapter は browser context の request interception で scope を強制する。 */
export interface ExplorationPort {
  readonly engineVersion: string;
  observe(url: string): Promise<PageObservation | null>;
}

/** 認証済み session の cookie (探索・診断へ一時的に渡す。永続層へ置かない)。 */
export interface LoginSessionCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
}

/** 能動診断 engine (ZAP 相当、Delegated)。停止は冪等とする (F11-UT-005)。 */
export interface ActiveScanEnginePort {
  readonly engineVersion: string;
  start(request: ActiveScanRequest): Promise<string>;
  progress(engineRunId: string): Promise<EngineProgress>;
  alerts(engineRunId: string, cursor: number): Promise<{ readonly alerts: readonly EngineAlert[]; readonly nextCursor: number }>;
  stop(engineRunId: string): Promise<void>;
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
}

/** login 実行 (browser 駆動・f09 相当)。実 adapter は Playwright、UT は fake で差し替える。 */
export interface LoginExecutorPort {
  readonly engineVersion: string;
  execute(input: LoginExecutionInput): Promise<LoginExecutionResult>;
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
}

/** Sequencer の実収集 transport。adapter 内で rate を守り、応答を逐次 core へ渡す。 */
export interface SequencerTransportPort {
  collect(input: {
    readonly targetUrl: string;
    readonly samples: number;
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
    readonly onSentFrame: (payload: string) => void;
    readonly onTextFrame: (payload: string) => void;
  }): Promise<{ readonly sent: number }>;
}

/** HTTP/2 capability probe. Scope is enforced by core before this port is called. */
export interface AdvancedTransportPort {
  probe(input: {
    readonly targetUrl: string;
    /** An HTTP/1.1 request may only be sent when this flag is true. */
    readonly allowFallback: boolean;
  }): Promise<{
    /** Protocols usable by the completed probe, or detected during negotiation. */
    readonly offered: readonly ('h2' | 'http/1.1')[];
    /** TLS ALPN result, or an explicit h2c marker for cleartext HTTP/2. */
    readonly alpn: string;
    readonly runtime: string;
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
