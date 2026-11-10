import { type Finding, type PageObservation, type ScanCandidate } from '@scopepilot2/contracts';
import { FindingImporter } from '../../domain/finding-importer.ts';
import { SiteMapProjector } from '../../domain/target-logger.ts';
import { type AuthBypassCheckRecord } from '../../domain/auth-bypass.ts';
import { type ParsedOpenApiEndpoint } from '../../domain/api-scanning.ts';
import type { DiagnosticRouteResult, GuidelineRouteResult } from '../baseline-contracts.ts';
/** Workspace-local execution projections; no process-global current case/run. */
export class ExecutionContext {
    readonly importer: FindingImporter;
    constructor(initialFindings: readonly Finding[] = []) { this.importer = new FindingImporter(initialFindings); }
    readonly trafficLog: readonly {
        exchangeId: string;
        url: string;
        method: string;
        status: number;
        contentType: string;
        at: string;
        source: 'explore' | 'repeater' | 'fuzzer' | 'sequencer';
    }[] = [];
    readonly siteMapProjector = new SiteMapProjector();
    readonly apiSpecImports: readonly {
        documentLabel: string;
        servers: readonly string[];
        excludedServers: readonly string[];
        endpoints: readonly (ParsedOpenApiEndpoint & {
            readonly url: string;
        })[];
        importedAt: string;
    }[] = [];
    readonly observationsByUrl = new Map<string, PageObservation>();
    readonly deniedUrlLog: readonly {
        url: string;
        reason: string;
    }[] = [];
    exploredUrlCount = 0;
    scannedUrlCount = 0;
    latestCandidates: readonly ScanCandidate[] = [];
    adoptedCandidateUrls = new Set<string>();
    scannedUrls = new Set<string>();
    assessmentStartedAt: string | undefined;
    assessmentEndedAt: string | undefined;
    authenticationRole: string | null = null;
    latestDiagnosticRoutes: readonly DiagnosticRouteResult[] = [];
    latestGuidelineRoutes: readonly GuidelineRouteResult[] = [];
    delegatedSteps: {
        readonly stepId: string;
        readonly engineKind: 'zap' | 'nuclei' | 'node-http';
        readonly engineVersion: string;
    }[] = [];
    readonly businessChecks: readonly {
        checkId: string;
        roles: readonly string[];
        targetUrl: string;
        status: string;
        comparison: string;
        restore: string;
        executedAt: string;
    }[] = [];
    readonly authBypassChecks: readonly AuthBypassCheckRecord[] = [];
    readonly zapUnsupportedChecks: readonly {
        checkId: string;
        themeNo: string;
        role: string | null;
        status: 'pass' | 'fail' | 'inconclusive';
        totalRequests: number;
        skipped?: readonly string[];
        executedAt: string;
    }[] = [];
}
