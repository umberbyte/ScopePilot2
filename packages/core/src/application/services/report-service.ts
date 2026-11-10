import { type CaseRecord, type OperatorProfile, type ReportArtifact } from '@scopepilot2/contracts';
import { ScopePolicy } from '../../domain/scope-policy.ts';
import { buildReportModel, renderMarkdown } from '../../domain/report-builder.ts';
import type { BaselineFlowDeps } from '../baseline-contracts.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import type { ExecutionContext } from './execution-context.ts';
import type { CaseSessionContext } from './case-session-context.ts';
import { requirePermission } from './authorization-policy.ts';
import { isSessionControlUrl } from './execution-helpers.ts';
export interface ReportServicePorts {
    currentCase(): CaseRecord;
}
export class ReportService {
    private readonly deps: Pick<BaselineFlowDeps, 'clock' | 'ids'>;
    private readonly ports: ReportServicePorts;
    private readonly events: EventPublisherPort;
    private readonly context: ExecutionContext;
    private readonly caseContext: CaseSessionContext;
    constructor(deps: ReportService['deps'], ports: ReportServicePorts, events: EventPublisherPort, context: ExecutionContext, caseContext: CaseSessionContext) {
        this.deps = deps;
        this.ports = ports;
        this.events = events;
        this.context = context;
        this.caseContext = caseContext;
    }
    generateReport(operator: OperatorProfile, input: {
        readonly guidelines: readonly string[];
        readonly excludeLowAndInfo?: boolean;
    }): ReportArtifact {
        requirePermission(operator, 'report.export');
        const caseRecord = this.ports.currentCase();
        const findings = input.excludeLowAndInfo === true
            ? this.context.importer.list().filter((finding) => finding.severity !== 'low' && finding.severity !== 'info')
            : this.context.importer.list();
        const model = buildReportModel({
            caseId: caseRecord.caseId,
            generatedAt: this.deps.clock.now().toISOString(),
            guidelines: input.guidelines,
            findings,
            coverage: {
                exploredUrlCount: this.context.observationsByUrl.size,
                scannedUrlCount: this.context.scannedUrls.size,
                delegatedSteps: this.context.delegatedSteps,
                exploredUrls: [...this.context.observationsByUrl.values()].map((observation) => ({
                    url: observation.url,
                    statusCode: observation.status,
                    contentType: observation.contentType,
                    depth: observation.depth,
                    discoveredFrom: observation.discoveredFrom,
                    originType: observation.originType,
                })),
                scannedUrls: [...this.context.scannedUrls],
                excludedUrls: [...this.context.observationsByUrl.values()]
                    .filter((observation) => !this.context.scannedUrls.has(ScopePolicy.canonicalUrl(observation.url)))
                    .map((observation) => {
                    const canonical = ScopePolicy.canonicalUrl(observation.url);
                    const hasCandidate = this.context.latestCandidates.some((candidate) => ScopePolicy.canonicalUrl(candidate.url) === canonical);
                    const reason = isSessionControlUrl(canonical)
                        ? 'セッション状態を変更する URL のため自動能動診断から除外'
                        : hasCandidate && !this.context.adoptedCandidateUrls.has(canonical)
                            ? '診断候補として検出されたが、実行対象として選択されなかったため除外'
                            : '探索で観測したが、能動診断可能な入力点が確認できなかったため除外';
                    return { url: observation.url, reason };
                }),
                ...this.context.deniedUrlLog.map((denied) => ({ url: denied.url, reason: `scope判定で拒否: ${denied.reason}` })),
                ...(this.context.assessmentStartedAt === undefined ? {} : { startedAt: this.context.assessmentStartedAt }),
                endedAt: this.context.assessmentEndedAt ?? this.deps.clock.now().toISOString(),
                authenticationRole: this.context.authenticationRole,
                scanPolicies: [
                    ...(this.context.exploredUrlCount > 0 ? ['passive' as const] : []),
                    ...(this.context.scannedUrlCount > 0 ? ['active' as const] : []),
                ],
                diagnosticRoutes: this.context.latestDiagnosticRoutes.map((route) => ({
                    track: route.track,
                    targetUrl: route.targetUrl,
                    status: route.status,
                    detail: route.detail,
                })),
                guidelineRoutes: this.context.latestGuidelineRoutes.map((route) => ({ ...route })),
                limitations: [
                    '外部 engine (Delegated 経路) の個々の送信は送信前に拒否できない。入力 scope・停止・版ごとの実測で管理する。',
                    'engine 由来の所見は実影響未確認であり、人の確認なしに確定扱いにしない。',
                    ...(input.excludeLowAndInfo === true ? ['お客様のご指示によりLow以下は省略されています。'] : []),
                ],
            },
            assessmentScope: {
                caseName: caseRecord.name,
                allowedOrigins: caseRecord.scope.allowedOrigins,
                deniedOrigins: caseRecord.scope.deniedOrigins,
                limits: caseRecord.scope.limits,
                ...(this.caseContext.authorization === null ? {} : {
                    authorization: {
                        allowedOperationClasses: this.caseContext.authorization.allowedOperationClasses,
                        targetRoles: this.caseContext.authorization.targetRoles,
                        validFrom: this.caseContext.authorization.validFrom,
                        validUntil: this.caseContext.authorization.validUntil,
                        evidenceRef: this.caseContext.authorization.evidenceRef.evidenceId,
                    },
                }),
            },
        });
        const reportId = this.deps.ids.next('report');
        const artifact = renderMarkdown(model, reportId);
        this.events.publish({ type: 'ReportGenerated', at: this.deps.clock.now().toISOString(), reportId, modelHash: artifact.modelHash });
        return artifact;
    }
}
