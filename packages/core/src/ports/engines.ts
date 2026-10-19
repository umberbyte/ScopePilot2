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
