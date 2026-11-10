/** 外部 engine の能力表。`docs/design/22-execution-control.md` 3章、`docs/detailed-design/01-system-components.md` 5章。 */
import type { EngineKind, GuaranteeLevel } from '../plan/plan.ts';

export const ControlAspects = ['preSendScopeEnforcement', 'stopControl', 'budgetLease', 'rateLimit'] as const;

export type ControlAspect = (typeof ControlAspects)[number];

/**
 * `source` は実測 (`measured`) と固定 fixture (`fixture`) を区別する。
 * fixture は workflow 検証用であり、実 engine の挙動保証ではない。
 * preSendScopeEnforcement が Unsupported な engine は当該機能を公開しない。
 */
export interface EngineCapabilitySnapshot {
  readonly engineKind: EngineKind;
  readonly engineVersion: string;
  readonly source: 'fixture' | 'measured';
  readonly guaranteeLevels: Readonly<Record<ControlAspect, GuaranteeLevel>>;
  /** Delegated 経路の予算予約に使う実測 (または fixture) 値。 */
  readonly maxOvershootRatio: number;
  readonly measuredAt: string;
  readonly fixtureHash?: string;
}

export type RuntimeProfile = 'production' | 'simulation' | 'test';
export type AdapterKind = 'real' | 'fixture' | 'unavailable';
export interface RuntimeAdapterCapability {
  readonly capability: string;
  readonly adapterKind: AdapterKind;
  readonly available: boolean;
  readonly version: string;
  readonly configuredAt: string;
  readonly fixtureHash?: string;
  readonly constraints: readonly string[];
}
