/**
 * 固定 engine 能力表。`docs/design/22-execution-control.md` 3章。
 * `source: 'fixture'` は workflow 検証用であり、実 engine の挙動保証ではない。
 * 実測 (measured) への差し替えは版固定 runner で行い、fixture を実測扱いにしない。
 */
import { hashStable, type ControlAspect, type EngineCapabilitySnapshot, type GuaranteeLevel } from '@scopepilot2/contracts';
import { FIXTURE_ZAP_VERSION, zapAlertsFixtureHash } from './zap-alerts.ts';
import { FIXTURE_NUCLEI_VERSION, nucleiJsonlFixtureHash } from './nuclei-jsonl.ts';
import { targetSiteFixtureHash } from './target-site.ts';

export const FIXTURE_RUNTIME_BUNDLE_HASH = hashStable('scopepilot2.simulation.runtime-bundle', {
  runtime: 'node-fixture',
  note: 'fixed runtime bundle hash for the A0 baseline scenario',
});

export const FIXTURE_MEASURED_AT = '2026-10-18T00:00:00.000Z';

const PLAYWRIGHT_VERSION = 'fixture-playwright-1';

function snapshot(
  engineKind: EngineCapabilitySnapshot['engineKind'],
  engineVersion: string,
  levels: Readonly<Record<ControlAspect, GuaranteeLevel>>,
  maxOvershootRatio: number,
  fixtureHash?: string,
): EngineCapabilitySnapshot {
  return {
    engineKind,
    engineVersion,
    source: 'fixture',
    guaranteeLevels: levels,
    maxOvershootRatio,
    measuredAt: FIXTURE_MEASURED_AT,
    ...(fixtureHash === undefined ? {} : { fixtureHash }),
  };
}

const delegated: Readonly<Record<ControlAspect, GuaranteeLevel>> = {
  preSendScopeEnforcement: 'Delegated',
  stopControl: 'Delegated',
  budgetLease: 'Delegated',
  rateLimit: 'Delegated',
};

/** Playwright は request interception で ScopePilot 自身が判定する (Enforced)。 */
const enforced: Readonly<Record<ControlAspect, GuaranteeLevel>> = {
  preSendScopeEnforcement: 'Enforced',
  stopControl: 'Enforced',
  budgetLease: 'Enforced',
  rateLimit: 'Enforced',
};

/**
 * Nuclei は直接 DNS/OAST 経由の template を制御できないため、管理 proxy を
 * 通せる経路の実測が済むまで既定で公開しない (Unsupported)。
 */
const nucleiUnsupported: Readonly<Record<ControlAspect, GuaranteeLevel>> = {
  preSendScopeEnforcement: 'Unsupported',
  stopControl: 'Delegated',
  budgetLease: 'Delegated',
  rateLimit: 'Delegated',
};

export function fixtureCapabilitySnapshots(): readonly EngineCapabilitySnapshot[] {
  return [
    snapshot('playwright', PLAYWRIGHT_VERSION, enforced, 0, targetSiteFixtureHash()),
    snapshot('zap', FIXTURE_ZAP_VERSION, delegated, 0.05, zapAlertsFixtureHash()),
    snapshot('nuclei', FIXTURE_NUCLEI_VERSION, nucleiUnsupported, 0.1, nucleiJsonlFixtureHash()),
  ];
}
