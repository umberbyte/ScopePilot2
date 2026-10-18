/**
 * HTTP 履歴・Site map。`docs/detailed-design/f03-target-logger.md`。
 * fingerprint は engine instance・message ID・方向・raw hash の組 (F03-UT-001)。
 * cursor は engine instance ごとに単調増加し、巻戻りを anomaly として記録する (F03-UT-002)。
 * document hint は観測通信に昇格させず observed=false を保持する (F03-UT-007)。
 */
import { domainError, hashStable } from '@scopepilot2/contracts';
import { ScopePolicy } from './scope-policy.ts';

export interface ExchangeFingerprintInput {
  readonly engineInstance: string;
  readonly engineMessageId: string;
  readonly direction: 'request' | 'response';
  readonly rawHash: string;
}

/** 同一原本の再取込は同一 fingerprint を返す (F03-UT-001)。 */
export function exchangeFingerprint(input: ExchangeFingerprintInput): string {
  return hashStable('scopepilot2.exchange', input);
}

export interface CursorAnomaly {
  readonly kind: 'rollback' | 'gap';
  readonly from: number;
  readonly to: number;
}

export class ImportCursor {
  readonly engineInstance: string;
  private current: number;
  private readonly anomalies: CursorAnomaly[] = [];

  constructor(engineInstance: string, initial = 0) {
    this.engineInstance = engineInstance;
    this.current = initial;
  }

  get offset(): number {
    return this.current;
  }

  anomaliesRecorded(): readonly CursorAnomaly[] {
    return [...this.anomalies];
  }

  /** 巻戻りは自動削除せず anomaly 記録と再走査指示を返す (F03-UT-002)。 */
  advance(next: number): { rescan: boolean } {
    if (next < this.current) {
      this.anomalies.push({ kind: 'rollback', from: this.current, to: next });
      this.current = next;
      return { rescan: true };
    }
    if (next > this.current + 1) {
      this.anomalies.push({ kind: 'gap', from: this.current, to: next });
    }
    this.current = next;
    return { rescan: false };
  }
}

export interface ImportMessage {
  readonly evidenceId: string;
  readonly raw: string;
}

export interface ImportedMessage extends ImportMessage {
  readonly fingerprint: string;
}

export interface QuarantinedMessage {
  readonly evidenceId: string;
  readonly reason: string;
}

/** 壊れた message は batch 全体を失敗させず quarantine する (F03-UT-003)。 */
export function importMessages(messages: readonly (ImportMessage | { readonly evidenceId: string; readonly raw: null })[]): {
  imported: readonly ImportedMessage[];
  quarantined: readonly QuarantinedMessage[];
} {
  const imported: ImportedMessage[] = [];
  const quarantined: QuarantinedMessage[] = [];
  for (const message of messages) {
    if (!('raw' in message) || message.raw === null || message.raw === '') {
      const reason = !('raw' in message) || message.raw === null ? 'raw payload missing' : 'raw payload empty';
      quarantined.push({ evidenceId: message.evidenceId, reason });
      continue;
    }
    imported.push({
      ...message,
      fingerprint: exchangeFingerprint({ engineInstance: 'import', engineMessageId: message.evidenceId, direction: 'request', rawHash: hashStable('scopepilot2.exchange.raw', message.raw) }),
    });
  }
  return { imported, quarantined };
}

export interface ObservedExchangeSummary {
  readonly url: string;
  readonly method: string;
  readonly status: number;
  readonly contentType: string;
}

export interface SiteMapEndpoint {
  readonly key: string;
  readonly origin: string;
  readonly path: string;
  readonly method: string;
  readonly contentType: string;
  readonly status: number;
  readonly observedUrls: number;
}

/** canonical origin/path/method/content-type/status で集約する。query は key に含めない (F03-UT-004)。 */
export class SiteMapProjector {
  private readonly endpoints = new Map<string, SiteMapEndpoint>();

  add(exchange: ObservedExchangeSummary): SiteMapEndpoint {
    const parsed = new URL(exchange.url);
    const origin = ScopePolicy.canonicalOrigin(exchange.url);
    const key = `${origin}|${parsed.pathname}|${exchange.method}|${exchange.contentType}|${exchange.status}`;
    const existing = this.endpoints.get(key);
    if (existing !== undefined) {
      const updated: SiteMapEndpoint = { ...existing, observedUrls: existing.observedUrls + 1 };
      this.endpoints.set(key, updated);
      return updated;
    }
    const endpoint: SiteMapEndpoint = {
      key,
      origin,
      path: parsed.pathname,
      method: exchange.method,
      contentType: exchange.contentType,
      status: exchange.status,
      observedUrls: 1,
    };
    this.endpoints.set(key, endpoint);
    return endpoint;
  }

  list(): readonly SiteMapEndpoint[] {
    return [...this.endpoints.values()];
  }
}

export const TRAFFIC_QUERY_DEFAULT_LIMIT = 100;
export const TRAFFIC_QUERY_MAX_LIMIT = 500;
export const TRAFFIC_SUMMARY_THRESHOLD = 100000;

/** limit 上限と大量表示の集約 mode (F03-UT-005/006)。 */
export function planTrafficQuery(totalCount: number, requestedLimit: number): { mode: 'list' | 'summary'; limit: number } {
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > TRAFFIC_QUERY_MAX_LIMIT) {
    throw domainError('ValidationFailed', `traffic query limit must be an integer between 1 and ${TRAFFIC_QUERY_MAX_LIMIT}`);
  }
  if (totalCount > TRAFFIC_SUMMARY_THRESHOLD) {
    return { mode: 'summary', limit: requestedLimit };
  }
  return { mode: 'list', limit: requestedLimit };
}

export type TrafficOriginType = 'observed' | 'document-hint';

export interface TrafficEntry {
  readonly url: string;
  readonly originType: TrafficOriginType;
}

/** document hint は観測扱いに昇格しない (F03-UT-007)。 */
export function originTypeOf(entry: TrafficEntry): { readonly observed: boolean; readonly originType: TrafficOriginType } {
  return { observed: entry.originType === 'observed', originType: entry.originType };
}
