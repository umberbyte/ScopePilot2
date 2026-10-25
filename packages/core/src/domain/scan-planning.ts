/**
 * 能動診断の計画・対象選定・coverage。`docs/detailed-design/f11-active-scan.md` §3〜§5。
 * 既定 spider depth 5・concurrency 2・2 RPS・30 分・URL 5,000・attack strength Low。
 * Delegated step を強制保証として誤表示しない。
 */
import { domainError, type PlanLimits } from '@scopepilot2/contracts';
import { ScopePolicy, type ScopeOrigins } from './scope-policy.ts';

/** 固定した安全既定 (F11-UT-001)。 */
export const ACTIVE_SCAN_DEFAULTS = {
  spiderDepth: 5,
  concurrency: 2,
  requestsPerSecond: 2,
  maxDurationMinutes: 30,
  maxUrls: 5000,
  attackStrength: 'Low',
} as const;

export function scanPlanLimits(overrides: Partial<Record<keyof typeof ACTIVE_SCAN_DEFAULTS, number>> = {}): {
  defaults: typeof ACTIVE_SCAN_DEFAULTS;
  limits: PlanLimits;
} {
  const merged = { ...ACTIVE_SCAN_DEFAULTS, ...overrides };
  const limits: PlanLimits = {
    maxRequests: merged.maxUrls,
    maxPages: merged.maxUrls,
    maxDurationMinutes: merged.maxDurationMinutes,
    maxConcurrency: merged.concurrency,
    requestsPerSecond: merged.requestsPerSecond,
  };
  return { defaults: merged as typeof ACTIVE_SCAN_DEFAULTS, limits };
}

/** 5,001 URL は plan validation を失敗させる (F11-UT-002)。 */
export function validateScanUrlCount(urlCount: number): void {
  if (urlCount > ACTIVE_SCAN_DEFAULTS.maxUrls) {
    throw domainError('ValidationFailed', `scan target count ${urlCount} exceeds the fixed limit ${ACTIVE_SCAN_DEFAULTS.maxUrls}`);
  }
}

/** scope 外候補は target snapshot から除外する (F11-UT-003)。 */
export function selectScanTargets(candidates: readonly string[], scope: ScopeOrigins): { selected: readonly string[]; excluded: readonly { url: string; reason: string }[] } {
  const selected: string[] = [];
  const excluded: { url: string; reason: string }[] = [];
  for (const candidate of candidates) {
    const decision = ScopePolicy.decide(scope, candidate);
    if (decision.allowed) {
      selected.push(ScopePolicy.canonicalUrl(candidate));
    } else {
      excluded.push({ url: candidate, reason: decision.reason });
    }
  }
  return { selected: [...new Set(selected)].sort(), excluded };
}

export type StepGuarantee = 'Enforced' | 'Delegated';

/** delegated step を ScopePilot 強制と誤表示しない (F11-UT-007)。 */
export function describeStepGuarantee(step: { engineKind: string; guarantee: StepGuarantee }): { label: string; preSendGuaranteed: boolean } {
  if (step.guarantee === 'Delegated') {
    return {
      label: `外部 engine (${step.engineKind}) へ委譲: 個々の送信の送信前拒否は保証しない`,
      preSendGuaranteed: false,
    };
  }
  return { label: `ScopePilot が各送信を送信前に判定 (${step.engineKind})`, preSendGuaranteed: true };
}

/**
 * 管理テンプレートの実行。テンプレートが scope 外へ変形されたら送信前拒否する (F11-UT-008)。
 */
export async function runManagedTemplate(
  template: { readonly name: string; readonly requests: readonly { readonly url: string; readonly method: string }[] },
  scope: ScopeOrigins,
  adapter: { send(url: string, method: string): Promise<void> },
): Promise<{ sent: number; rejected?: { url: string; reason: string } }> {
  for (const request of template.requests) {
    const decision = ScopePolicy.decide(scope, request.url);
    if (!decision.allowed) {
      return { sent: 0, rejected: { url: request.url, reason: decision.reason } };
    }
  }
  let sent = 0;
  for (const request of template.requests) {
    await adapter.send(request.url, request.method);
    sent += 1;
  }
  return { sent };
}
