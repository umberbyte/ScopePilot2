/**
 * 報告の正規 model と deterministic な Markdown render。
 * `docs/detailed-design/f19-organizer-reporting.md` 4章・7章。
 * renderer 非依存の正規形を作り (F19-UT-004 の土台)、delegated step の限界開示を省略しない (F19-UT-008 の土台)。
 */
import { hashStable, type Finding, type ReportArtifact, type ReportAssessmentScope, type ReportCoverage, type ReportModel } from '@scopepilot2/contracts';

export interface BuildReportInput {
  readonly caseId: string;
  readonly generatedAt: string;
  readonly guidelines: readonly string[];
  readonly findings: readonly Finding[];
  readonly coverage: ReportCoverage;
  readonly assessmentScope: ReportAssessmentScope;
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
    assessmentScope: input.assessmentScope,
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
  lines.push(`- 案件名: ${model.assessmentScope.caseName}`);
  lines.push(`- 生成日時: ${model.generatedAt}`);
  lines.push(`- 参照ガイドライン: ${model.guidelines.length === 0 ? '(なし)' : model.guidelines.join(', ')}`);
  lines.push('');
  lines.push('## coverage');
  lines.push('');
  lines.push(`- 探索した URL: ${model.coverage.exploredUrlCount}`);
  lines.push(`- 診断した URL: ${model.coverage.scannedUrlCount}`);
  lines.push('');
  if ((model.coverage.exploredUrls?.length ?? 0) > 0) {
    lines.push('### 探索URLと診断対象判定');
    lines.push('');
    for (const entry of model.coverage.exploredUrls ?? []) {
      const excluded = model.coverage.excludedUrls?.find((candidate) => candidate.url === entry.url);
      lines.push(`- ${entry.url} | HTTP ${entry.statusCode === null ? '不明' : String(entry.statusCode)} | ${excluded === undefined ? '診断対象' : `対象外: ${excluded.reason}`}`);
    }
    lines.push('');
  }
  lines.push(`- 認証条件: ${model.coverage.authenticationRole === null || model.coverage.authenticationRole === undefined ? '未認証' : `認証あり (${model.coverage.authenticationRole})`}`);
  lines.push(`- スキャンポリシー: ${(model.coverage.scanPolicies ?? []).map((policy) => policy === 'passive' ? '受動' : '能動').join(' / ') || '未実施'}`);
  lines.push(`- 実施期間: ${model.coverage.startedAt ?? '未記録'} ～ ${model.coverage.endedAt ?? '未記録'}`);
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
  if ((model.coverage.unsupportedAssessments?.length ?? 0) > 0) {
    lines.push('### 検査不能・スキップ（合否未判定）', '');
    for (const entry of model.coverage.unsupportedAssessments ?? []) {
      lines.push(`- ${entry.title}: 検査不能・スキップ / ${entry.assessment} / ${entry.guarantee}`);
      lines.push(`  - 理由: ${entry.detail} (${entry.reasonCode})`);
      lines.push(`  - 再開条件: ${entry.resumeConditions.join(' / ')}`);
      lines.push(`  - 方針版: ${entry.policyVersion} / 経路: ${entry.routeId}`);
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
    lines.push(`- 深刻度: ${finding.severity}${finding.sourceSeverity === undefined ? '' : ` (原表記: ${finding.sourceSeverity})`}`);
    lines.push(`- URL: ${finding.url}`);
    if (finding.param !== undefined) {
      lines.push(`- パラメータ: ${finding.param}`);
    }
    lines.push(`- 状態: ${finding.status} (観測 ${finding.occurrences} 回)`);
    lines.push(`- 実影響: ${finding.source.unverified ? '未確認 (engine 由来の警告)' : '確認済み'}`);
    lines.push(`- 出典: ${finding.source.kind}${finding.source.engineVersion === undefined ? '' : ` (${finding.source.engineVersion})`}`);
    lines.push(`- 証拠: ${finding.evidenceRefs.join(', ')}`);
    if (finding.humanReview !== undefined) {
      const review = finding.humanReview;
      lines.push(`- 人の検証: ${review.result} / ${review.reproduction} (${review.reviewedBy}, ${review.reviewedAt})`);
      lines.push(`- 検証記録: ${review.notes}`);
      lines.push(`- 重要度の根拠: ${review.severityRationale}`);
      if (review.cvss !== undefined) lines.push(`- CVSS ${review.cvss.version}: ${review.cvss.vector} (${review.cvss.score})`);
    }
    if (finding.merge !== undefined) lines.push(`- 統合先: ${finding.merge.intoFindingId} (${finding.merge.reason}; ${finding.merge.mergedBy}, ${finding.merge.mergedAt})`);
    lines.push('');
  });
  return {
    reportId,
    format: 'markdown',
    modelHash: reportModelHash(model),
    content: `${lines.join('\n')}\n`,
    model,
  };
}
