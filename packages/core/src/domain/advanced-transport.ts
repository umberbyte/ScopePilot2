/**
 * HTTP/2・高度通信。`docs/detailed-design/f15-http2-advanced-transport.md`、design/13。
 * pseudo-header 規則、CRLF 注入拒否、暗黙 H1 fallback 禁止、能力表。
 */
import { domainError } from '@scopepilot2/contracts';
import { ScopePolicy } from './scope-policy.ts';

const PSEUDO_HEADERS: readonly string[] = [':method', ':scheme', ':authority', ':path'];

/** pseudo header の重複・順序不正は validation error (F15-UT-001)。 */
export function validatePseudoHeaders(headers: readonly (readonly [string, string])[]): { ordered: readonly string[] } {
  const present = headers.filter(([name]) => name.startsWith(':')).map(([name]) => name);
  const duplicates = present.length !== new Set(present).size;
  const allowedOrder = PSEUDO_HEADERS;
  const firstNonPseudo = headers.findIndex(([name]) => !name.startsWith(':'));
  if (firstNonPseudo >= 0 && headers.slice(firstNonPseudo).some(([name]) => name.startsWith(':'))) {
    throw domainError('ValidationFailed', 'pseudo headers must precede regular headers');
  }
  if (duplicates || present.some((name) => !allowedOrder.includes(name))) {
    throw domainError('ValidationFailed', 'pseudo headers must be unique and known (:method, :scheme, :authority, :path)');
  }
  return { ordered: present };
}

/** :authority が scope 外なら OutOfScope (F15-UT-002)。 */
export function checkAuthorityScope(
  headers: readonly (readonly [string, string])[],
  scheme: string,
  scope: { allowedOrigins: readonly string[]; deniedOrigins: readonly string[] },
): { allowed: true } | { allowed: false; reason: string } {
  const authority = headers.find(([name]) => name === ':authority')?.[1];
  if (authority === undefined) {
    throw domainError('ValidationFailed', ':authority pseudo header is required');
  }
  return ScopePolicy.decide(scope, `${scheme}://${authority}/`);
}

/** CRLF 注入になり得る header 値は拒否する (F15-UT-003)。 */
export function validateHeaderValues(headers: readonly (readonly [string, string])[]): void {
  for (const [name, value] of headers) {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw domainError('ValidationFailed', `header ${name} contains CR/LF (possible header injection)`);
    }
  }
}

/** fallback 未許可なら H1 へ暗黙 fallback しない (F15-UT-004)。 */
export function negotiateTransport(input: { offered: readonly string[]; allowFallback: boolean }): { protocol: 'h2' | 'http/1.1'; downgraded: boolean } {
  if (input.offered.includes('h2')) {
    return { protocol: 'h2', downgraded: false };
  }
  if (!input.allowFallback) {
    throw domainError('CapabilityUnavailable', 'peer did not offer h2 and HTTP/1.1 fallback is not allowed for this plan');
  }
  return { protocol: 'http/1.1', downgraded: true };
}

export type TransportEvent =
  | { kind: 'response'; readonly status: number }
  | { kind: 'goaway'; readonly errorCode: number; readonly lastStreamId: number }
  | { kind: 'connection-closed' };

/** GOAWAY は response 成功と区別する (F15-UT-005)。 */
export function classifyTransportEvent(event: TransportEvent): { isResponse: boolean; terminal: boolean } {
  switch (event.kind) {
    case 'response':
      return { isResponse: true, terminal: false };
    case 'goaway':
      return { isResponse: false, terminal: true };
    case 'connection-closed':
      return { isResponse: false, terminal: true };
  }
}

/** HTTP/3 は能力表で Unsupported (F15-UT-006)。 */
export function transportCapability(requested: 'h2' | 'h3' | 'http/1.1'): 'Supported' | 'Unsupported' {
  return requested === 'h3' ? 'Unsupported' : 'Supported';
}

/** negotiation 結果は runtime/ALPN を保持する (F15-UT-007)。 */
export function transportEvidence(input: { alpn: string; runtime: string }): { alpn: string; runtime: string } {
  return { alpn: input.alpn, runtime: input.runtime };
}
