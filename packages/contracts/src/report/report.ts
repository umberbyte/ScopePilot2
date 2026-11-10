import type { GuidelineAutomationDisclosure } from '../plan/guideline-automation.ts';
/** 報告の正規 model と成果物。`docs/detailed-design/f19-organizer-reporting.md`。 */
import type { EngineKind } from '../plan/plan.ts';
import type { OperationClass, ScopeLimits } from '../case/case.ts';
import type { Finding } from '../findings/findings.ts';

export interface ReportAssessmentScope {
  readonly caseName: string;
  readonly allowedOrigins: readonly string[];
  readonly deniedOrigins: readonly string[];
  readonly limits: ScopeLimits;
  readonly authorization?: {
    readonly allowedOperationClasses: readonly OperationClass[];
    readonly targetRoles: readonly string[];
    readonly validFrom: string;
    readonly validUntil: string;
    readonly evidenceRef: string;
  };
}

export interface ReportCoverage {
  readonly exploredUrlCount: number;
  readonly scannedUrlCount: number;
  /** 実際に観測したURL。件数だけでなく範囲を追跡できるようにする。 */
  readonly exploredUrls?: readonly {
    readonly url: string;
    readonly statusCode: number;
    readonly contentType: string;
    readonly depth: number;
    readonly discoveredFrom: string | null;
    readonly originType: 'crawl' | 'document-hint';
  }[];
  /** 能動診断へ渡した正規URL。 */
  readonly scannedUrls?: readonly string[];
  /** 探索したが能動診断へ渡さなかったURLと、その決定理由。 */
  readonly excludedUrls?: readonly { readonly url: string; readonly reason: string }[];
  /** 探索・診断の実測期間。 */
  readonly startedAt?: string;
  readonly endedAt?: string;
  /** 認証セッションを適用した場合のロール。未認証は null。 */
  readonly authenticationRole?: string | null;
  /** 実際に実施した検査ポリシー。 */
  readonly scanPolicies?: readonly ('passive' | 'active')[];
  readonly diagnosticRoutes?: readonly {
    readonly track: string;
    readonly targetUrl: string;
    readonly status: 'delegated' | 'executed' | 'needs-input' | 'unavailable';
    readonly detail: string;
  }[];
  readonly guidelineRoutes?: readonly (GuidelineAutomationDisclosure & {
    readonly routeId: string;
    readonly themeNo: string;
    readonly guidelineIds: readonly string[];
    readonly status: 'delegated' | 'executed' | 'needs-input' | 'unavailable';
    readonly detail: string;
    readonly checkId?: string;
    readonly checkStatus?: 'pass' | 'fail' | 'inconclusive';
  })[];
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
  readonly assessmentScope: ReportAssessmentScope;
}

export interface ReportArtifact {
  readonly reportId: string;
  readonly format: 'markdown';
  readonly modelHash: string;
  readonly content: string;
  /** DOCX/JSON と Markdown が同一の事実集合から生成されるための正規モデル。 */
  readonly model: ReportModel;
}
