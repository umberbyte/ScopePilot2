/** 外部 engine への port。adapters が実装し、simulation は固定 fixture で実装する。 */
import type { ActiveScanRequest, EngineAlert, EngineProgress, PageObservation } from '@scopepilot2/contracts';

/** 探索 (Playwright 相当)。実 adapter は browser context の request interception で scope を強制する。 */
export interface ExplorationPort {
  readonly engineVersion: string;
  observe(url: string): Promise<PageObservation | null>;
}

/** 能動診断 engine (ZAP 相当、Delegated)。停止は冪等とする (F11-UT-005)。 */
export interface ActiveScanEnginePort {
  readonly engineVersion: string;
  start(request: ActiveScanRequest): Promise<string>;
  progress(engineRunId: string): Promise<EngineProgress>;
  alerts(engineRunId: string, cursor: number): Promise<{ readonly alerts: readonly EngineAlert[]; readonly nextCursor: number }>;
  stop(engineRunId: string): Promise<void>;
}
