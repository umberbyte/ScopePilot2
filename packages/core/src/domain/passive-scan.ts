/**
 * 受動診断。`docs/detailed-design/f10-passive-scan.md`。
 * Passive analyzer は network port を持たず、観測 exchange に対してだけ働く。
 * 所見は観測 evidence を最低1件参照し、document hint だけから生成しない。
 */
import { domainError, type FindingSeverity } from '@scopepilot2/contracts';

export const PASSIVE_BATCH_DEFAULTS = { maxItems: 1000, maxBytes: 25 * 1024 * 1024 } as const;

export interface QueuedExchange {
  readonly exchangeEvidenceId: string;
  readonly sizeBytes: number;
}

export interface PassiveQueueItem {
  readonly exchangeEvidenceId: string;
  readonly sizeBytes: number;
  status: 'pending' | 'analyzed' | 'retryable-failure';
  failureReason?: string;
}

/** exchange evidence ID を一意登録する (F10-UT-001)。 */
export class PassiveQueue {
  private readonly items = new Map<string, PassiveQueueItem>();

  register(exchange: QueuedExchange): { registered: boolean } {
    if (this.items.has(exchange.exchangeEvidenceId)) {
      return { registered: false };
    }
    this.items.set(exchange.exchangeEvidenceId, { ...exchange, status: 'pending' });
    return { registered: true };
  }

  pending(): readonly PassiveQueueItem[] {
    return [...this.items.values()].filter((item) => item.status === 'pending');
  }

  /** analyzer 失敗は retryable failure とし、queue 全体を成功扱いしない (F10-UT-007)。 */
  markRetryableFailure(exchangeEvidenceId: string, reason: string): void {
    const item = this.items.get(exchangeEvidenceId);
    if (item === undefined) {
      throw domainError('ValidationFailed', `unknown exchange evidence: ${exchangeEvidenceId}`);
    }
    item.status = 'retryable-failure';
    item.failureReason = reason;
  }

  failures(): readonly PassiveQueueItem[] {
    return [...this.items.values()].filter((item) => item.status === 'retryable-failure');
  }
}

/** batch は 1,000 件 / 25 MiB 境界の超過前で分割する (F10-UT-002)。 */
export function planPassiveBatches(
  items: readonly QueuedExchange[],
  limits: { maxItems: number; maxBytes: number } = PASSIVE_BATCH_DEFAULTS,
): readonly QueuedExchange[][] {
  const batches: QueuedExchange[][] = [];
  let current: QueuedExchange[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const wouldItems = current.length + 1;
    const wouldBytes = currentBytes + item.sizeBytes;
    if (current.length > 0 && (wouldItems > limits.maxItems || wouldBytes > limits.maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += item.sizeBytes;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

export interface PassiveAlertInput {
  readonly ruleId: string;
  readonly sourceInstance: string;
  readonly messageReference: string;
  readonly name: string;
  readonly sourceSeverity: string;
  readonly url: string;
  readonly evidenceId: string;
}

export interface PassiveFindingCandidate {
  readonly key: string;
  readonly name: string;
  readonly severity: FindingSeverity;
  readonly sourceSeverity: string;
  readonly url: string;
  readonly evidenceIds: readonly string[];
}

/** alert は (ruleId, instance, message ref) で重複排除する (F10-UT-003)。 */
export class ZapAlertImporter {
  private readonly candidates = new Map<string, PassiveFindingCandidate>();

  importAlert(alert: PassiveAlertInput): { created: boolean; candidate: PassiveFindingCandidate } {
    const key = `${alert.ruleId}|${alert.sourceInstance}|${alert.messageReference}`;
    const existing = this.candidates.get(key);
    if (existing !== undefined) {
      const evidenceIds = [...new Set([...existing.evidenceIds, alert.evidenceId])];
      const updated: PassiveFindingCandidate = { ...existing, evidenceIds };
      this.candidates.set(key, updated);
      return { created: false, candidate: updated };
    }
    if (alert.evidenceId.trim() === '') {
      // 所見は観測 evidence を最低1件参照する (F10-UT-005)。
      throw domainError('ValidationFailed', 'passive finding requires at least one observed evidence reference');
    }
    const candidate: PassiveFindingCandidate = {
      key,
      name: alert.name,
      severity: normalizeSeverity(alert.sourceSeverity),
      sourceSeverity: alert.sourceSeverity,
      url: alert.url,
      evidenceIds: [alert.evidenceId],
    };
    this.candidates.set(key, candidate);
    return { created: true, candidate };
  }

  list(): readonly PassiveFindingCandidate[] {
    return [...this.candidates.values()];
  }
}

const KNOWN_SEVERITIES: readonly FindingSeverity[] = ['info', 'low', 'medium', 'high'];

/** source severity が不明なら Unknown を保持し推測しない (F10-UT-004)。 */
export function normalizeSeverity(sourceSeverity: string): FindingSeverity {
  const lowered = sourceSeverity.trim().toLowerCase();
  const match = KNOWN_SEVERITIES.find((severity) => severity === lowered);
  return match ?? 'unknown';
}

export interface CoverageObservation {
  readonly url: string;
  readonly bodyTruncated: boolean;
  readonly bodyAbsent: boolean;
}

/** body truncate/absent は coverage limitation として表示する (F10-UT-006)。 */
export function coverageLimitations(observations: readonly CoverageObservation[]): readonly string[] {
  const truncated = observations.filter((observation) => observation.bodyTruncated).length;
  const absent = observations.filter((observation) => observation.bodyAbsent).length;
  const limitations: string[] = [];
  if (truncated > 0) {
    limitations.push(`受動診断の対象 body が長さ上限で切り詰められた通信: ${truncated} 件 (検査範囲が本文全体に及ばない)`);
  }
  if (absent > 0) {
    limitations.push(`body が保存されていない通信: ${absent} 件 (本文を対象とする規則は適用されていない)`);
  }
  return limitations;
}
