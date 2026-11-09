/**
 * engine alert の取込と重複除外。`docs/detailed-design/f11-active-scan.md` 4章 (ScanResultImporter)、
 * 旧版からの継承知見「取込時の重複除外」。
 * 同一 (pluginId, url, param) の再取込は新規所見を作らず、観測回数だけを増やす (F11-UT-006)。
 * Nuclei match も同じ台帳へ取り込む (f18 §4 NucleiResultImporter。dedupe key は template/target)。
 * engine 由来の所見は常に実影響未確認 (unverified) として扱う。
 */
import { domainError, type EngineAlert, type Finding, type FindingHumanReview, type FindingSeverity } from '@scopepilot2/contracts';
import { confirmFinding } from './reporting.ts';
import type { NucleiMatch } from './known-vulnerabilities.ts';
import { normalizeNucleiSeverity } from './known-vulnerabilities.ts';

export function dedupeKeyOf(alert: EngineAlert): string {
  return `${alert.pluginId}|${alert.url}|${alert.param ?? ''}`;
}

function nucleiDedupeKeyOf(match: NucleiMatch): string {
  return `nuclei|${match.templateId}|${match.matchedAt}`;
}

function severityOf(risk: EngineAlert['risk']): FindingSeverity {
  switch (risk) {
    case 'Informational':
      return 'info';
    case 'Low':
      return 'low';
    case 'Medium':
      return 'medium';
    case 'High':
      return 'high';
  }
}

export interface ImportAlertsContext {
  readonly now: string;
  readonly engineVersion: string;
  readonly makeFindingId: () => string;
  readonly evidenceRef: string;
}

export interface ImportAlertsResult {
  /** 新規に作成した所見。 */
  readonly created: readonly Finding[];
  /** 再観測として計上した既存所見。 */
  readonly reobserved: readonly Finding[];
  readonly duplicateCount: number;
}

export interface ObservationFindingCandidate {
  readonly key: string;
  readonly title: string;
  readonly url: string;
  readonly method?: string;
  readonly param?: string;
  readonly severity: FindingSeverity;
}

export class FindingImporter {
  private readonly findingsByDedupeKey = new Map<string, Finding>();

  constructor(initialFindings: readonly Finding[] = []) {
    for (const finding of initialFindings) {
      const key = finding.source.kind === 'nuclei-match'
        ? `nuclei|${finding.enginePluginId ?? ''}|${finding.url}`
        : `${finding.enginePluginId ?? ''}|${finding.url}|${finding.param ?? ''}`;
      this.findingsByDedupeKey.set(key, finding);
    }
  }

  /** 現在の全所見 (作成順)。 */
  list(): readonly Finding[] {
    return [...this.findingsByDedupeKey.values()];
  }

  /** Explicit duplicate resolution preserves both original records and their human reviews. */
  merge(findingId: string, intoFindingId: string, reason: string, mergedBy: string, mergedAt: string): readonly Finding[] {
    const entries = [...this.findingsByDedupeKey.entries()];
    const from = entries.find(([, f]) => f.findingId === findingId);
    const into = entries.find(([, f]) => f.findingId === intoFindingId);
    if (!from || !into || findingId === intoFindingId || reason.trim() === '' || from[1].status === 'merged' || into[1].status === 'merged') {
      throw domainError('ValidationFailed', 'merge requires two distinct unmerged findings and a reason');
    }
    // A record already referenced by merged children must remain a stable destination.
    if (entries.some(([, f]) => f.merge?.intoFindingId === findingId)) throw domainError('ValidationFailed', 'merge destination cannot itself be merged');
    const source: Finding = { ...from[1], status: 'merged', merge: { intoFindingId, reason: reason.trim(), mergedBy, mergedAt } };
    // Never promote the destination or transfer a human verification to another finding.
    const target: Finding = { ...into[1], evidenceRefs: [...new Set([...into[1].evidenceRefs, ...source.evidenceRefs])] };
    this.findingsByDedupeKey.set(from[0], source);
    this.findingsByDedupeKey.set(into[0], target);
    return [source, target];
  }

  /**
   * 確認状態の変更 (6.3・F19)。candidate からの確定/棄却と、確定↔棄却のやり直しのみ許す。
   * 確定は証拠参照が 1 つ以上あること (F19-UT-001 と同じ規則)。人間が未着手の candidate
   * へは戻せない (確認者が触った事実を消さない)。
   */
  updateStatus(findingId: string, next: 'confirmed' | 'rejected', context: {
    readonly now: string;
    readonly changedBy: string;
    readonly review?: Omit<FindingHumanReview, 'result' | 'reviewedBy' | 'reviewedAt'>;
  }): Finding {
    let existing: Finding | undefined;
    let key: string | undefined;
    for (const [candidateKey, candidate] of this.findingsByDedupeKey) {
      if (candidate.findingId === findingId) {
        existing = candidate;
        key = candidateKey;
        break;
      }
    }
    if (existing === undefined || key === undefined) {
      throw domainError('ValidationFailed', `finding ${findingId} does not exist`);
    }
    if (existing.status === next) {
      throw domainError('ValidationFailed', `finding ${findingId} is already ${next}`);
    }
    if (existing.status === 'merged') {
      throw domainError('ValidationFailed', `transition ${existing.status} -> ${next} is not allowed for finding ${findingId}`);
    }
    if (next === 'confirmed') {
      // 証拠参照なしの確定は拒否 (reporting.confirmFinding が throw する)。
      confirmFinding(existing, existing.evidenceRefs.map((evidenceId) => ({ evidenceId })));
    }
    const humanReview: FindingHumanReview | undefined = context.review === undefined ? undefined : {
      ...context.review,
      result: next === 'confirmed' ? 'confirmed' : 'false-positive',
      reviewedBy: context.changedBy,
      reviewedAt: context.now,
    };
    const updated: Finding = {
      ...existing,
      status: next,
      lastSeenAt: context.now,
      ...(humanReview === undefined ? {} : { humanReview }),
    };
    this.findingsByDedupeKey.set(key, updated);
    return updated;
  }

  importAlerts(alerts: readonly EngineAlert[], context: ImportAlertsContext): ImportAlertsResult {
    const created: Finding[] = [];
    const reobserved: Finding[] = [];
    let duplicateCount = 0;

    for (const alert of alerts) {
      const key = dedupeKeyOf(alert);
      const existing = this.findingsByDedupeKey.get(key);
      if (existing === undefined) {
        const finding: Finding = {
          findingId: context.makeFindingId(),
          title: alert.name,
          source: { kind: 'zap-alert', engineVersion: context.engineVersion, unverified: true },
          url: alert.url,
          method: alert.method,
          ...(alert.param === undefined ? {} : { param: alert.param }),
          severity: severityOf(alert.risk),
          status: 'candidate',
          evidenceRefs: [context.evidenceRef],
          firstSeenAt: context.now,
          lastSeenAt: context.now,
          occurrences: 1,
          enginePluginId: alert.pluginId,
        };
        this.findingsByDedupeKey.set(key, finding);
        created.push(finding);
      } else {
        duplicateCount += 1;
        const updated: Finding = { ...existing, occurrences: existing.occurrences + 1, lastSeenAt: context.now };
        this.findingsByDedupeKey.set(key, updated);
        reobserved.push(updated);
      }
    }
    return { created, reobserved, duplicateCount };
  }

  /** Import a bounded first-party observation without pretending it came from ZAP. */
  importObservationCandidates(
    candidates: readonly ObservationFindingCandidate[],
    context: ImportAlertsContext,
  ): ImportAlertsResult {
    const created: Finding[] = [];
    const reobserved: Finding[] = [];
    let duplicateCount = 0;

    for (const candidate of candidates) {
      const key = `${candidate.key}|${candidate.url}|${candidate.param ?? ''}`;
      const existing = this.findingsByDedupeKey.get(key);
      if (existing === undefined) {
        const finding: Finding = {
          findingId: context.makeFindingId(),
          title: candidate.title,
          source: { kind: 'observation', engineVersion: context.engineVersion, unverified: true },
          url: candidate.url,
          ...(candidate.method === undefined ? {} : { method: candidate.method }),
          ...(candidate.param === undefined ? {} : { param: candidate.param }),
          severity: candidate.severity,
          status: 'candidate',
          evidenceRefs: [context.evidenceRef],
          firstSeenAt: context.now,
          lastSeenAt: context.now,
          occurrences: 1,
          enginePluginId: candidate.key,
        };
        this.findingsByDedupeKey.set(key, finding);
        created.push(finding);
      } else {
        duplicateCount += 1;
        const updated: Finding = { ...existing, occurrences: existing.occurrences + 1, lastSeenAt: context.now };
        this.findingsByDedupeKey.set(key, updated);
        reobserved.push(updated);
      }
    }
    return { created, reobserved, duplicateCount };
  }

  /** Nuclei match の取込。severity は正規化値と原値を併記し、原値は変えない (f18 §5)。 */
  importNucleiMatches(matches: readonly NucleiMatch[], context: ImportAlertsContext): ImportAlertsResult {
    const created: Finding[] = [];
    const reobserved: Finding[] = [];
    let duplicateCount = 0;

    for (const match of matches) {
      const key = nucleiDedupeKeyOf(match);
      const existing = this.findingsByDedupeKey.get(key);
      if (existing === undefined) {
        const { severity, sourceSeverity } = normalizeNucleiSeverity(match.severity);
        const finding: Finding = {
          findingId: context.makeFindingId(),
          title: match.name === '' ? match.templateId : match.name,
          source: { kind: 'nuclei-match', engineVersion: context.engineVersion, unverified: true },
          url: match.matchedAt,
          severity,
          ...(severity === sourceSeverity.toLowerCase() ? {} : { sourceSeverity }),
          status: 'candidate',
          evidenceRefs: [context.evidenceRef],
          firstSeenAt: context.now,
          lastSeenAt: context.now,
          occurrences: 1,
          enginePluginId: match.templateId,
        };
        this.findingsByDedupeKey.set(key, finding);
        created.push(finding);
      } else {
        duplicateCount += 1;
        const updated: Finding = { ...existing, occurrences: existing.occurrences + 1, lastSeenAt: context.now };
        this.findingsByDedupeKey.set(key, updated);
        reobserved.push(updated);
      }
    }
    return { created, reobserved, duplicateCount };
  }
}
