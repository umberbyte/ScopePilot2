/**
 * 整理・報告。`docs/detailed-design/f19-organizer-reporting.md` §4〜§6。
 * 観測事実・文書記載・AI提案・推論を区別する。原本→派生の hash chain を切らない。
 */
import { domainError, hashStable, type Finding, type FindingSeverity } from '@scopepilot2/contracts';

/** evidence なしでは Confirmed にできない (F19-UT-001)。 */
export function confirmFinding(finding: Finding, evidence: readonly { evidenceId: string }[]): { status: Finding['status'] } {
  if (evidence.length === 0) {
    throw domainError('ValidationFailed', 'finding cannot be confirmed without at least one evidence reference');
  }
  return { status: 'confirmed' };
}

/** 類似候補は自動 merge せず suggestion だけ出す (F19-UT-002)。 */
export function matchDuplicates(
  finding: { readonly findingId: string; readonly title: string; readonly url: string },
  others: readonly { readonly findingId: string; readonly title: string; readonly url: string }[],
): { suggestions: readonly { findingId: string; reason: string }[] } {
  const suggestions: { findingId: string; reason: string }[] = [];
  for (const other of others) {
    if (other.findingId === finding.findingId) {
      continue;
    }
    const sameUrl = other.url === finding.url;
    const similarTitle = other.title.toLowerCase().slice(0, 24) === finding.title.toLowerCase().slice(0, 24);
    if (sameUrl || similarTitle) {
      suggestions.push({ findingId: other.findingId, reason: sameUrl ? 'same url' : 'similar title prefix' });
    }
  }
  return { suggestions };
}

/** source severity と手動値は両方保持し、変更理由を残す (F19-UT-003)。 */
export function setManualSeverity(
  current: { readonly sourceSeverity: FindingSeverity; readonly manualSeverity?: FindingSeverity },
  next: FindingSeverity,
  reason: string,
): { sourceSeverity: FindingSeverity; manualSeverity: FindingSeverity; changeReason: string } {
  if (reason.trim() === '') {
    throw domainError('ValidationFailed', 'manual severity change requires a reason');
  }
  return { sourceSeverity: current.sourceSeverity, manualSeverity: next, changeReason: reason };
}

export type ReportOriginLabel = 'observation' | 'document-hint' | 'ai-proposal' | 'inference';

/** hint/observation/AI 混在は origin label を分離する (F19-UT-004)。 */
export function labelReportOrigins(items: readonly { source: 'zap-alert' | 'nuclei-match' | 'observation' | 'document-hint' | 'ai-proposal' }[]): readonly { source: string; label: ReportOriginLabel }[] {
  return items.map((item) => {
    switch (item.source) {
      case 'zap-alert':
      case 'nuclei-match':
      case 'observation':
        return { source: item.source, label: 'observation' as const };
      case 'document-hint':
        return { source: item.source, label: 'document-hint' as const };
      case 'ai-proposal':
        return { source: item.source, label: 'ai-proposal' as const };
    }
  });
}

/** secret/PII は report profile に従って除外する (F19-UT-005)。 */
export function redactForProfile(
  entries: readonly { readonly text: string; readonly kind: 'normal' | 'secret' | 'pii' }[],
  profile: 'internal-full' | 'shared-masked',
): readonly string[] {
  return entries.map((entry) => {
    if (profile === 'internal-full') {
      return entry.text;
    }
    if (entry.kind === 'secret') {
      return '[redacted: secret]';
    }
    if (entry.kind === 'pii') {
      return '[redacted: PII]';
    }
    return entry.text;
  });
}

/** 固定 model から決定的な markdown を出す (F19-UT-006)。 */
export function renderDeterministicMarkdown(model: { readonly caseId: string; readonly titles: readonly string[] }): string {
  const lines = [`# case ${model.caseId}`];
  for (const title of [...model.titles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    lines.push(`- ${title}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface ChainLink {
  readonly evidenceId: string;
  readonly sha256: string;
}

/** 派生関係の hash 不一致は broken chain として失敗する (F19-UT-007)。 */
export function verifyEvidenceChain(links: readonly { from: ChainLink; to: ChainLink; expectedFromSha256: string }[]): { valid: boolean; brokenAt: number | null } {
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    if (link === undefined) {
      continue;
    }
    if (link.from.sha256 !== link.expectedFromSha256) {
      return { valid: false, brokenAt: index };
    }
  }
  return { valid: true, brokenAt: null };
}

/** delegated coverage の limitation は必ず含める (F19-UT-008)。 */
export function buildCoverageSection(delegatedSteps: readonly { engineKind: string }[]): { limitations: readonly string[] } {
  const limitations: string[] = [];
  if (delegatedSteps.length > 0) {
    limitations.push(`外部 engine (${[...new Set(delegatedSteps.map((step) => step.engineKind))].join(', ')}) へ委譲した step の個々の送信は送信前に拒否できません (Delegated)。入力 scope・停止・版ごとの実測で管理します。`);
  }
  limitations.push('本 coverage は実施済み対象の記録であり、未実施領域の安全性を証明するものではありません。');
  return { limitations };
}

/** 監査用: 派生成果物の hash。 */
export function derivedArtifactHash(content: string): string {
  return hashStable('scopepilot2.report.derived', content);
}
