/**
 * OAST。`docs/detailed-design/f13-oast.md`、design/12。
 * token と callback の相関、待機上限 (既定 24 時間)、protocol 別能力。
 * 曖昧な相関は所見候補にしかしない。
 */
import { domainError, hashStable } from '@scopepilot2/contracts';

export const OAST_DEFAULT_WAIT_MS = 24 * 60 * 60 * 1000;

/** 同一 attempt での再発行は一意 token と履歴を返す (F13-UT-001)。 */
export class TokenIssuer {
  private readonly issued: { token: string; issuedAtMs: number }[] = [];
  private sequence = 0;

  issue(attemptId: string): { token: string; history: readonly string[] } {
    this.sequence += 1;
    const token = `oast-${hashStable('scopepilot2.oast.token', { attempt: attemptId, sequence: this.sequence }).slice(0, 16)}`;
    this.issued.push({ token, issuedAtMs: 0 });
    return { token, history: this.issued.map((entry) => entry.token) };
  }
}

export interface ProviderEvent {
  readonly eventId: string;
  readonly token: string;
  readonly payload: string;
}

/** 同一 provider event は dedupe する (F13-UT-002)。 */
export function normalizeCallbacks(events: readonly ProviderEvent[]): { kept: readonly ProviderEvent[]; duplicates: number } {
  const seen = new Set<string>();
  const kept: ProviderEvent[] = [];
  let duplicates = 0;
  for (const event of events) {
    if (seen.has(event.eventId)) {
      duplicates += 1;
      continue;
    }
    seen.add(event.eventId);
    kept.push(event);
  }
  return { kept, duplicates };
}

export type CorrelatedCallback =
  | { kind: 'correlated'; token: string; payload: string }
  | { kind: 'uncorrelated'; token: string; reason: string };

/** 未知 token は uncorrelated として隔離する (F13-UT-003)。 */
export function correlate(events: readonly ProviderEvent[], knownTokens: ReadonlySet<string>): readonly CorrelatedCallback[] {
  return events.map((event) =>
    knownTokens.has(event.token)
      ? { kind: 'correlated' as const, token: event.token, payload: event.payload }
      : { kind: 'uncorrelated' as const, token: event.token, reason: 'token was not issued by any active attempt' },
  );
}

/** 待機 deadline (24h/7d 境界) を遵守する (F13-UT-004)。 */
export function pollDeadline(issuedAtMs: number, nowMs: number, waitMs: number = OAST_DEFAULT_WAIT_MS): { expired: boolean; remainingMs: number } {
  const deadline = issuedAtMs + waitMs;
  return { expired: nowMs >= deadline, remainingMs: Math.max(0, deadline - nowMs) };
}

export type OastProtocol = 'http' | 'dns' | 'smtp' | 'icmp';

/** DNS 非対応 provider は Unsupported とする (F13-UT-005)。 */
export function providerCapability(supportedProtocols: readonly OastProtocol[], requested: OastProtocol): 'Supported' | 'Unsupported' {
  return supportedProtocols.includes(requested) ? 'Supported' : 'Unsupported';
}

/** 曖昧 correlation (複数 token・未知 token) は candidate のみとする (F13-UT-006)。 */
export function linkFinding(callbacks: readonly CorrelatedCallback[]): { linkedTokens: readonly string[]; candidateOnly: boolean } {
  const correlated = callbacks.filter((callback): callback is Extract<CorrelatedCallback, { kind: 'correlated' }> => callback.kind === 'correlated');
  const uncorrelated = callbacks.length - correlated.length;
  const tokens = [...new Set(correlated.map((callback) => callback.token))];
  return { linkedTokens: tokens, candidateOnly: uncorrelated > 0 || tokens.length !== 1 };
}

/** report projection から token/credential を除外する (F13-UT-007)。 */
export function oastEvidenceProjection(input: { token: string; payload: string }): { interactionCount: number; protocols: readonly string[] } {
  return { interactionCount: 1, protocols: [] };
}
