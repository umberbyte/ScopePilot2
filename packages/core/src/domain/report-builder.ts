/**
 * 報告の正規 model と deterministic な Markdown render。
 * `docs/detailed-design/f19-organizer-reporting.md` 4章・7章。
 * renderer 非依存の正規形を作り (F19-UT-004 の土台)、delegated step の限界開示を省略しない (F19-UT-008 の土台)。
 */
import { hashStable, type Finding, type ReportArtifact, type ReportCoverage, type ReportModel } from '@scopepilot2/contracts';

export interface BuildReportInput {
  readonly caseId: string;
  readonly generatedAt: string;
  readonly guidelines: readonly string[];
  readonly findings: readonly Finding[];
  readonly coverage: ReportCoverage;
}

export function buildReportModel(input: BuildReportInput): ReportModel {
  const findings = [...input.findings].sort((a, b) =>
    a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0,
  );
  return {
    caseId: input.caseId,
    generatedAt: input.generatedAt,
    guidelines: [...input.guidelines],
    findings,
    coverage: input.coverage,
  };
}

export function reportModelHash(model: ReportModel): string {
  return hashStable('scopepilot2.report.model', model);
}

/** 固定 model から deterministic な出力を作る (F19-UT-006 の土台)。 */
export function renderMarkdown(model: ReportModel, reportId: string): ReportArtifact {
  const lines: string[] = [];
  lines.push('# 診断報告書');
  lines.push('');
  lines.push(`- 案件: ${model.caseId}`);
  lines.push(`- 生成日時: ${model.generatedAt}`);
  lines.push(`- 参照ガイドライン: ${model.guidelines.length === 0 ? '(なし)' : model.guidelines.join(', ')}`);
  lines.push('');
  lines.push('## coverage');
  lines.push('');
  lines.push(`- 探索した URL: ${model.coverage.exploredUrlCount}`);
  lines.push(`- 診断した URL: ${model.coverage.scannedUrlCount}`);
  lines.push('');
  if (model.coverage.delegatedSteps.length > 0) {
    lines.push('### 外部 engine への委譲');
    lines.push('');
    for (const step of model.coverage.delegatedSteps) {
      const version = step.engineVersion === undefined ? '' : ` ${step.engineVersion}`;
      lines.push(`- ${step.stepId}: ${step.engineKind}${version} — 個々の送信の送信前拒否は保証しない (Delegated)`);
    }
    lines.push('');
  }
  lines.push('### 限界と注意');
  lines.push('');
  for (const limitation of model.coverage.limitations) {
    lines.push(`- ${limitation}`);
  }
  lines.push('');
  lines.push(`## 所見 (${model.findings.length}件)`);
  lines.push('');
  model.findings.forEach((finding, index) => {
    lines.push(`### [${index + 1}] ${finding.title}`);
    lines.push('');
    lines.push(`- 深刻度: ${finding.severity}`);
    lines.push(`- URL: ${finding.url}`);
    if (finding.param !== undefined) {
      lines.push(`- パラメータ: ${finding.param}`);
    }
    lines.push(`- 状態: ${finding.status} (観測 ${finding.occurrences} 回)`);
    lines.push(`- 実影響: ${finding.source.unverified ? '未確認 (engine 由来の警告)' : '確認済み'}`);
    lines.push(`- 出典: ${finding.source.kind}${finding.source.engineVersion === undefined ? '' : ` (${finding.source.engineVersion})`}`);
    lines.push(`- 証拠: ${finding.evidenceRefs.join(', ')}`);
    lines.push('');
  });
  return {
    reportId,
    format: 'markdown',
    modelHash: reportModelHash(model),
    content: `${lines.join('\n')}\n`,
  };
}
