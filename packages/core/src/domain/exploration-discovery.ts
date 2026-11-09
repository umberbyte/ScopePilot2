import type { ScanCandidate, DiscoverySource } from '@scopepilot2/contracts';
import { ScopePolicy } from './scope-policy.ts';

export const DISCOVERY_VERSION = 'discovery-1';
/** Small, target-independent list. Only used with confirmed ActiveCrawl permission. */
export const DISCOVERY_WORDLIST = ['/admin/', '/backup/', '/api/', '/.well-known/security.txt'] as const;
export function discoverySeeds(origins: readonly string[], sources: readonly DiscoverySource[]): readonly string[] {
  return [...new Set(origins.flatMap((origin) => [
    ...(sources.length ? [new URL('/.scopepilot-missing-7d4f92c1', origin).href] : []),
    ...(sources.includes('robots') ? [new URL('/robots.txt', origin).href] : []),
    ...(sources.includes('sitemap') ? [new URL('/sitemap.xml', origin).href] : []),
    ...(sources.includes('manifest') ? [new URL('/manifest.json', origin).href] : []),
    ...(sources.includes('wordlist') ? DISCOVERY_WORDLIST.map((path) => new URL(path, origin).href) : []),
  ]))];
}
/** Read only explicit references, never execute code or expand unbounded XML/JSON. */
export function extractAssetReferences(body: string, url: string): readonly { url: string; source: string }[] {
  if (Buffer.byteLength(body) > 1024 * 1024) return [];
  const found: { url: string; source: string }[] = [];
  const add = (raw: string, source: string) => {
    if (found.length >= 128) return;
    try {
      const parsed = new URL(raw.replaceAll('&amp;', '&').trim(), url);
      if (parsed.origin !== new URL(url).origin || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || /[*{}$]/.test(parsed.href)) return;
      found.push({ url: parsed.href, source });
    } catch { /* malformed untrusted reference */ }
  };
  if (new URL(url).pathname.endsWith('/robots.txt')) {
    for (const match of body.matchAll(/^(?:Allow|Disallow|Sitemap):\s*(\S+)/gmi)) add(match[1]!, 'robots');
  }
  for (const match of body.matchAll(/<loc>\s*([^<]{1,2048})\s*<\/loc>/gi)) add(match[1]!, 'sitemap');
  for (const match of body.matchAll(/sourceMappingURL=([^\s*]{1,2048})/g)) add(match[1]!, 'source-map');
  for (const match of body.matchAll(/\b(?:import|export)\s*(?:[^;\n]{0,100}?\bfrom\s*)?["'](\.[^"']{1,256})["']|\bimport\(["']([^"']{1,256})["']\)/g)) add(match[1] ?? match[2]!, 'module');
  try {
    const manifest = JSON.parse(body) as Record<string, unknown>;
    if (typeof manifest.start_url === 'string') add(manifest.start_url, 'manifest');
    if (Array.isArray(manifest.related_applications)) { /* Third-party apps are never crawled. */ }
  } catch { /* not a manifest */ }
  return [...new Map(found.map((item) => [item.url, item])).values()];
}

/** Explainable priority, independent of product or challenge route names. Never grants permission. */
export function rankCandidates(candidates: readonly ScanCandidate[]): ScanCandidate[] {
  return candidates.map((candidate, index) => {
    const signals: string[] = [];
    let score = 0;
    const add = (points: number, reason: string) => { score += points; signals.push(`${points >= 0 ? '+' : ''}${points} ${reason}`); };
    const source = candidate.guidelineBasis.join(' ');
    if (source.includes('observed-http')) add(60, 'observed browser request');
    else if (source.includes('script-api')) add(35, 'script definition; execution unobserved');
    else if (source.includes('api-spec')) add(25, 'specification; execution unobserved');
    else add(40, 'rendered page or form');
    add(Math.min(candidate.inputPoints?.length ?? 0, 5) * 5, 'input points');
    if (candidate.category === 'form') add(10, 'observed form');
    const url = new URL(candidate.url);
    if (/\.(?:js|mjs|css|map|txt|json|pem|crt|png|woff2?)(?:$)/i.test(url.pathname)) add(-40, 'static resource');
    if (/\/(?:socket\.io|sockjs)(?:\/|$)/i.test(url.pathname)) add(-100, 'transport channel');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(candidate.method.toUpperCase())) add(-20, 'state change requires reviewed workflow');
    return { candidate: { ...candidate, score, scoreSignals: signals, provenance: candidate.provenance ?? [{ source: source || 'observation', url: candidate.observationUrl }] }, index };
  }).sort((a, b) => b.candidate.score - a.candidate.score || a.index - b.index).map(({ candidate }) => candidate);
}
