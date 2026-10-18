/**
 * engine alert の取込と重複除外。`docs/detailed-design/f11-active-scan.md` 4章 (ScanResultImporter)、
 * 旧版からの継承知見「取込時の重複除外」。
 * 同一 (pluginId, url, param) の再取込は新規所見を作らず、観測回数だけを増やす (F11-UT-006)。
 * Nuclei match も同じ台帳へ取り込む (f18 §4 NucleiResultImporter。dedupe key は template/target)。
 * engine 由来の所見は常に実影響未確認 (unverified) として扱う。
 */
import type { EngineAlert, Finding, FindingSeverity } from '@scopepilot2/contracts';
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

export class FindingImporter {
  private readonly findingsByDedupeKey = new Map<string, Finding>();

  /** 現在の全所見 (作成順)。 */
  list(): readonly Finding[] {
    return [...this.findingsByDedupeKey.values()];
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
