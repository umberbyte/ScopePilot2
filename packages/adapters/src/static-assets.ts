import type { PageObservation } from '@scopepilot2/contracts';
import { analyzeClientAsset, assetHash, allowedTextAsset, extractAssetReferences, MAX_ASSET_BYTES, ScopePolicy, type ComponentDatabase, type ExplorationControl } from '@scopepilot2/core';

/** Streaming acquisition for explicit static references; no execution and no automatic redirect following. */
export async function readStaticAsset(input: {
  url: string;
  scope: { allowedOrigins: readonly string[]; deniedOrigins: readonly string[] };
  control?: ExplorationControl;
  database?: ComponentDatabase;
  analyseScript?: (body: string, url: string) => Pick<PageObservation, 'routeTemplates' | 'scriptApiCalls'>;
}): Promise<PageObservation | null> {
  let current = input.url;
  const deadline = AbortSignal.timeout(Math.min(input.control?.timeoutMs ?? 15000, 15000));
  const signal = input.control?.signal ? AbortSignal.any([deadline, input.control.signal]) : deadline;
  for (let hop = 0; hop < 5; hop++) {
    if (!ScopePolicy.decide(input.scope, current).allowed || signal.aborted || input.control?.consumeRequest() === false) return null;
    const response = await fetch(current, { redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) return null;
      const next = new URL(location, current).href;
      // Assets stay on their originating site, even when another Origin is allowed in the case.
      if (new URL(next).origin !== new URL(input.url).origin) return null;
      current = next;
      continue;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const declared = Number(response.headers.get('content-length'));
    if (!allowedTextAsset(current, contentType) || declared > MAX_ASSET_BYTES || response.status >= 400) {
      await response.body?.cancel();
      return { url: input.url, finalUrl: current, status: response.status, contentType, depth: 0, discoveredFrom: null, originType: 'crawl', links: [], forms: [] };
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_ASSET_BYTES) { await reader.cancel(); return null; }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const body = Buffer.concat(chunks).toString('utf8');
    const asset = analyzeClientAsset({ url: current, sourceUrl: input.url, contentType, body, headers: { server: response.headers.get('server') ?? '', 'x-powered-by': response.headers.get('x-powered-by') ?? '' }, ...(input.database ? { database: input.database } : {}) });
    return { url: input.url, finalUrl: current, status: response.status, contentType, depth: 0, discoveredFrom: null, originType: 'crawl', links: [], forms: [], ...(input.analyseScript?.(body, current) ?? {}), ...(asset ? { assets: [asset], discoveryLinks: extractAssetReferences(body, current), contentFingerprint: assetHash(body) } : {}) };
  }
  return null;
}
export function isStaticReference(url: string): boolean {
  return /\.(?:js|mjs|map|json|webmanifest|txt|xml|pem|pub|crt|cer)$/i.test(new URL(url).pathname);
}
