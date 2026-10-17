/**
 * scope の正規化と判定。`docs/design/02-case-scope-authorization.md`、
 * `docs/detailed-design/f01-case-scope-authorization.md` 4章。
 * deny を allow より優先する (F01-UT-001)。Unicode host・既定 port・末尾 dot を
 * canonicalize 後に比較する (F01-UT-002)。
 */
import type { CaseScope, ScopeDecision } from '@scopepilot2/contracts';

export class ScopePolicy {
  /** URL を canonical origin (`scheme://host[:port]`) へ正規化する。不正 URL は例外。 */
  static canonicalOrigin(url: string): string {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    if (host === '') {
      throw new TypeError(`canonicalOrigin: empty host: ${url}`);
    }
    const defaultPorts: Record<string, string> = { 'http:': '80', 'https:': '443' };
    const port = parsed.port === '' || defaultPorts[parsed.protocol] === parsed.port ? '' : `:${parsed.port}`;
    return `${parsed.protocol.toLowerCase()}//${host}${port}`;
  }

  /** frontier・target snapshot 用の canonical URL。fragment を除き、path は `/` を補う。 */
  static canonicalUrl(url: string): string {
    const parsed = new URL(url);
    const origin = ScopePolicy.canonicalOrigin(url);
    const path = parsed.pathname === '' ? '/' : parsed.pathname;
    return `${origin}${path}${parsed.search}`;
  }

  /** deny を allow より優先して判定する。 */
  static decide(scope: CaseScope, url: string): ScopeDecision {
    const origin = ScopePolicy.canonicalOrigin(url);
    if (scope.deniedOrigins.some((denied) => denied === origin)) {
      return { allowed: false, reason: `origin ${origin} matches a deny rule` };
    }
    if (scope.allowedOrigins.some((allowed) => allowed === origin)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `origin ${origin} is not in allowed origins` };
  }
}
