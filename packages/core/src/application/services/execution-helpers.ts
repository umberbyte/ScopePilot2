import { diagnosticTracksFor, isTransportChannelUrl } from './diagnostic-router.ts';
import { domainError, type PageObservation, type ScanCandidate, type RequestInputPoint } from '@scopepilot2/contracts';
import { ScopePolicy } from '../../domain/scope-policy.ts';
import { type ZapUnsupportedThemeNo } from '../../domain/zap-unsupported.ts';
import { type WorkflowScanHttpResponse, type WorkflowScanRequestSpec, type WorkflowScanTransport } from '../../domain/workflow-scan.ts';
import type { IdGenerator } from '../../ports/infra.ts';
export function candidatesFromObservation(observation: PageObservation, ids: IdGenerator): ScanCandidate[] {
    const pageUrl = observation.finalUrl ?? observation.url;
    const parsedUrl = new URL(pageUrl);
    const queryParameterCount = [...parsedUrl.searchParams].length;
    const queryInputPoints: RequestInputPoint[] = [...new Set(parsedUrl.searchParams.keys())]
        .map((name) => ({ name, location: 'query', type: 'string' }));
    const javascriptSignals = observation.javascriptSignals;
    const javascriptSignalCount = javascriptSignals === undefined
        ? 0
        : javascriptSignals.scriptElements + javascriptSignals.inlineEventHandlers + javascriptSignals.javascriptUrls;
    const pageHasDynamicInput = queryParameterCount > 0 || javascriptSignalCount > 0;
    const dynamicReasons = [
        ...(queryParameterCount === 0 ? [] : [`GETパラメータ ${queryParameterCount} 件`]),
        ...(javascriptSignals === undefined || javascriptSignalCount === 0 ? [] : [
            `JavaScript要素 ${javascriptSignals.scriptElements} 件・インラインイベント ${javascriptSignals.inlineEventHandlers} 件・javascript: URL ${javascriptSignals.javascriptUrls} 件`,
        ]),
    ];
    const candidates: ScanCandidate[] = [
        {
            candidateId: ids.next('cand'),
            url: pageUrl,
            method: 'GET',
            category: 'page',
            guidelineBasis: ['provisional:page'],
            confidence: 0.7,
            observationUrl: pageUrl,
            detectionReason: observation.discoveredFrom === null
                ? `探索開始URLとして観測 (HTTP ${observation.status}, ${observation.contentType})${dynamicReasons.length === 0 ? '' : `。${dynamicReasons.join('、')}を検出`}`
                : `${observation.discoveredFrom} からリンクを検出 (HTTP ${observation.status}, ${observation.contentType})${dynamicReasons.length === 0 ? '' : `。${dynamicReasons.join('、')}を検出`}`,
            dynamic: pageHasDynamicInput,
            inputPoints: queryInputPoints,
            diagnosticTracks: diagnosticTracksFor(pageUrl, 'GET', queryInputPoints, javascriptSignalCount > 0),
        },
    ];
    for (const form of observation.forms) {
        const location = form.method.toUpperCase() === 'GET' ? 'query' : 'body';
        const inputPoints: RequestInputPoint[] = form.fields.map((field) => ({
            name: field.name,
            location: field.type.toLowerCase() === 'file' ? 'file' : location,
            type: field.type,
        }));
        candidates.push({
            candidateId: ids.next('cand'),
            url: ScopePolicy.canonicalUrl(form.actionUrl),
            method: form.method,
            category: 'form',
            guidelineBasis: [`provisional:form:${form.classification}`],
            confidence: 0.9,
            observationUrl: pageUrl,
            detectionReason: `${pageUrl} で ${form.classification} フォームを検出 (${form.method.toUpperCase()}, 入力 ${form.fields.length} 項目)`,
            dynamic: true,
            inputPoints,
            ...(location === 'query' ? {} : {
                contentType: inputPoints.some((point) => point.location === 'file')
                    ? 'multipart/form-data'
                    : 'application/x-www-form-urlencoded',
            }),
            diagnosticTracks: diagnosticTracksFor(form.actionUrl, form.method, inputPoints, false),
        });
    }
    const seenRequests = new Set<string>();
    for (const request of observation.requests ?? []) {
        if (request.resourceType !== 'xhr' && request.resourceType !== 'fetch' && request.inputPoints.length === 0 && request.method === 'GET')
            continue;
        if (isTransportChannelUrl(request.url))
            continue;
        const key = `${request.method}|${ScopePolicy.canonicalUrl(request.url)}|${request.inputPoints.map((point) => `${point.location}:${point.name}`).sort().join(',')}`;
        if (seenRequests.has(key))
            continue;
        seenRequests.add(key);
        candidates.push({
            candidateId: ids.next('cand'),
            url: ScopePolicy.canonicalUrl(request.url),
            method: request.method,
            category: request.resourceType === 'xhr' || request.resourceType === 'fetch' ? 'api-endpoint' : 'form',
            guidelineBasis: [`observed-http:${request.resourceType}`],
            confidence: 0.95,
            observationUrl: pageUrl,
            detectionReason: `${pageUrl} のブラウザー通信で ${request.method} リクエストと入力点 ${request.inputPoints.length} 件を観測`,
            dynamic: true,
            requestId: request.requestId,
            ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
            inputPoints: request.inputPoints,
            diagnosticTracks: diagnosticTracksFor(request.url, request.method, request.inputPoints, false, request.contentType),
        });
    }
    // スクリプト内の API 呼び出し定義 (書き込み API は操作でしか発火せず閲覧観測に現れない)。
    // 実行時観測 (requests) と同一視できるものは観測由来を優先する。
    for (const call of observation.scriptApiCalls ?? []) {
        const method = call.method.toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
            continue;
        if (isTransportChannelUrl(call.url))
            continue;
        const canonical = ScopePolicy.canonicalUrl(call.url);
        const key = `${method}|${canonical}|`;
        if (seenRequests.has(key))
            continue;
        seenRequests.add(key);
        candidates.push({
            candidateId: ids.next('cand'),
            url: canonical,
            method,
            category: 'api-endpoint',
            guidelineBasis: ['script-api-call'],
            confidence: 0.75,
            observationUrl: pageUrl,
            detectionReason: `読込済みスクリプト内の ${method} API 呼び出し定義 (${new URL(call.url).pathname})。閲覧観測では発火しない操作系 API を含む`,
            dynamic: method !== 'GET',
            diagnosticTracks: diagnosticTracksFor(call.url, method, [], false),
        });
    }
    return candidates;
}
export function isSessionControlUrl(value: string): boolean {
    try {
        const pathname = new URL(value).pathname.toLowerCase();
        return /\/(?:logout|log-out|logoff|signout|sign-out)(?:\.php)?\/?$/.test(pathname)
            || /\/(?:setup|install)(?:\.php)?\/?$/.test(pathname);
    }
    catch {
        return true;
    }
}
export function loginMergeKeyOf(method: string, url: string, inputPoints: readonly RequestInputPoint[]): string {
    return [
        method.toUpperCase(),
        ScopePolicy.canonicalUrl(url),
        ...inputPoints.map((point) => `${point.location}:${point.name}`).sort(),
    ].join('|');
}
export function automaticGuidelineRequestCount(themeNo: ZapUnsupportedThemeNo, targetCount: number): number {
    switch (themeNo) {
        case '13':
            // Same-origin control, one external Origin, and `null`; GET + OPTIONS for each.
            return targetCount === 0 ? 0 : 6;
        case '24':
            return targetCount * 2;
        case '25':
            // OPTIONS plus the non-state-changing TRACE and TRACK defaults.
            return targetCount === 0 ? 0 : 3;
        case '30':
            return targetCount;
        default:
            return 0;
    }
}
export class SharedBudgetWorkflowTransport implements WorkflowScanTransport {
    private readonly delegate: WorkflowScanTransport;
    private readonly budget: {
        readonly limit: number;
        used: number;
    };
    constructor(delegate: WorkflowScanTransport, budget: {
        readonly limit: number;
        used: number;
    }) {
        this.delegate = delegate;
        this.budget = budget;
    }
    get baseUrl(): string {
        return this.delegate.baseUrl;
    }
    get requestCount(): number {
        return this.budget.used;
    }
    async request(spec: WorkflowScanRequestSpec): Promise<WorkflowScanHttpResponse> {
        if (this.budget.used >= this.budget.limit) {
            throw domainError('OutOfScope', `workflow scan request limit reached (${String(this.budget.limit)})`);
        }
        this.budget.used += 1;
        return this.delegate.request(spec);
    }
    takeRequestLog(): import('../../domain/workflow-scan.ts').WorkflowScanRequestLogEntry[] {
        return this.delegate.takeRequestLog();
    }
}
export function workflowHttpEvidenceRecords(checks: readonly import('../../domain/workflow-scan.ts').WorkflowScanCheckResult[], requestLog: readonly import('../../domain/workflow-scan.ts').WorkflowScanRequestLogEntry[], baseUrl: string): readonly Readonly<Record<string, unknown>>[] {
    const host = new URL(baseUrl).host;
    return checks.map((check) => {
        const checkUrl = new URL(check.url, `${baseUrl}/`);
        const exactTarget = `${checkUrl.pathname}${checkUrl.search}`;
        const pathMatches = requestLog.filter((entry) => {
            try {
                const entryUrl = new URL(entry.url, `${baseUrl}/`);
                return `${entryUrl.pathname}${entryUrl.search}` === exactTarget;
            }
            catch {
                return false;
            }
        });
        const samePath = requestLog.filter((entry) => {
            try {
                return new URL(entry.url, `${baseUrl}/`).pathname === checkUrl.pathname;
            }
            catch {
                return false;
            }
        });
        const exchange = pathMatches.findLast((entry) => entry.method.toUpperCase() === check.method.toUpperCase())
            ?? pathMatches.at(-1)
            ?? samePath.findLast((entry) => entry.method.toUpperCase() === check.method.toUpperCase())
            ?? samePath.at(-1);
        if (exchange === undefined) {
            throw new Error(`workflow HTTP evidence is missing for ${check.checkId} ${checkUrl.pathname}`);
        }
        const requestTarget = exchange.url;
        const requestBody = exchange.requestPreview;
        const responseBody = exchange.responsePreview;
        const location = exchange.location;
        return {
            pluginId: `workflow-scan:${check.checkId}:${check.securityLevel || 'global'}`,
            url: checkUrl.toString(),
            method: check.method,
            param: check.param,
            request: `${check.method.toUpperCase()} ${requestTarget} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ScopePilot2-WorkflowScan/1.0\r\n${requestBody === '' ? '' : `Content-Type: application/x-www-form-urlencoded\r\n\r\n${requestBody}`}`,
            response: `HTTP/1.1 ${String(exchange.status)} Observed\r\n${location === '' ? '' : `Location: ${location}\r\n`}\r\n${responseBody}`,
            attack: check.param,
            evidenceSummary: check.evidence,
            description: check.description,
            remediation: check.remediation,
            cwe: check.cwe,
        };
    });
}
