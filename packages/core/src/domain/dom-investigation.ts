/**
 * DOM 調査。`docs/detailed-design/f16-dom-investigation.md`、design/14。
 * 同一 marker の source/sink 追跡、same-origin frame と open shadow DOM のみ対象。
 * CSP は回避しない。観測なしでは finding を作らない。
 */

export const SOURCE_SINK_DICTIONARY: readonly { readonly kind: 'source' | 'sink'; readonly api: string }[] = [
  { kind: 'source', api: 'location.search' },
  { kind: 'source', api: 'location.hash' },
  { kind: 'source', api: 'document.referrer' },
  { kind: 'source', api: 'document.cookie' },
  { kind: 'source', api: 'postMessage.data' },
  { kind: 'sink', api: 'innerHTML' },
  { kind: 'sink', api: 'eval' },
  { kind: 'sink', api: 'setTimeout(string)' },
  { kind: 'sink', api: 'document.write' },
];

export interface ValueFlowCandidate {
  readonly sourceApi: string;
  readonly sinkApi: string;
  readonly confidence: number;
  readonly marker: string;
}

/** 同一 marker が source/sink 両方に現れたら候補、部分一致は低 confidence (F16-UT-001/002)。 */
export function traceValueFlows(observations: readonly { readonly api: string; readonly marker: string }[]): readonly ValueFlowCandidate[] {
  const sources = observations.filter((observation) => observation.api.startsWith('source:') || SOURCE_SINK_DICTIONARY.some((entry) => entry.kind === 'source' && entry.api === observation.api));
  const sinks = observations.filter((observation) => observation.api.startsWith('sink:') || SOURCE_SINK_DICTIONARY.some((entry) => entry.kind === 'sink' && entry.api === observation.api));
  const candidates: ValueFlowCandidate[] = [];
  for (const source of sources) {
    for (const sink of sinks) {
      const exact = source.marker === sink.marker;
      const partial = !exact && (source.marker.includes(sink.marker) || sink.marker.includes(source.marker)) && source.marker.length > 0 && sink.marker.length > 0;
      if (exact) {
        candidates.push({ sourceApi: source.api, sinkApi: sink.api, confidence: 0.9, marker: source.marker });
      } else if (partial) {
        candidates.push({ sourceApi: source.api, sinkApi: sink.api, confidence: 0.3, marker: source.marker });
      }
    }
  }
  return candidates;
}

/** cross-origin child frame は観測対象外として記録する (F16-UT-003)。 */
export function frameBoundaryPolicy(frame: { origin: string; parentOrigin: string }): { observable: boolean; reason?: string } {
  if (frame.origin !== frame.parentOrigin) {
    return { observable: false, reason: 'cross-origin child frames are out of observation scope' };
  }
  return { observable: true };
}

/** shadow DOM は open のみ対象とする (F16-UT-004)。 */
export function shadowDomPolicy(root: { mode: 'open' | 'closed' }): { observable: boolean; reason?: string } {
  if (root.mode === 'closed') {
    return { observable: false, reason: 'closed shadow roots are not observable without breaking isolation' };
  }
  return { observable: true };
}

/** 観測 (DOM snapshot) なしには finding を作らない (F16-UT-005)。 */
export function buildDomCandidate(observations: readonly { readonly api: string; readonly marker: string }[]): readonly ValueFlowCandidate[] {
  if (observations.length === 0) {
    return [];
  }
  return traceValueFlows(observations);
}

/** PII を含み得る node は projection で redact する (F16-UT-006)。 */
export function domEvidenceProjection(nodes: readonly { readonly text: string; readonly looksLikePii: boolean }[]): readonly string[] {
  return nodes.map((node) => (node.looksLikePii ? '[redacted: potential PII]' : node.text));
}

/** navigation 後の旧 generation event は stale として隔離する (F16-UT-007)。 */
export function classifyObserverEvent(event: { generation: number }, currentGeneration: number): { stale: boolean } {
  return { stale: event.generation < currentGeneration };
}
