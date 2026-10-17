/** 報告の正規 model と成果物。`docs/detailed-design/f19-organizer-reporting.md`。 */
import type { EngineKind } from '../plan/plan.ts';
import type { Finding } from '../findings/findings.ts';

export interface ReportCoverage {
  readonly exploredUrlCount: number;
  readonly scannedUrlCount: number;
  readonly delegatedSteps: readonly {
    readonly stepId: string;
    readonly engineKind: EngineKind;
    readonly engineVersion?: string;
  }[];
  /** coverage の限界と委譲範囲の開示文。省略しない。 */
  readonly limitations: readonly string[];
}

export interface ReportModel {
  readonly caseId: string;
  readonly generatedAt: string;
  readonly guidelines: readonly string[];
  readonly findings: readonly Finding[];
  readonly coverage: ReportCoverage;
}

export interface ReportArtifact {
  readonly reportId: string;
  readonly format: 'markdown';
  readonly modelHash: string;
  readonly content: string;
}
