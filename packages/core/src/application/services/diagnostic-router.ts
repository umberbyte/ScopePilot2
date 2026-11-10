import { ScopePolicy } from '../../domain/scope-policy.ts';
import type { ScanCandidate, RequestInputPoint, DiagnosticTrack } from '@scopepilot2/contracts';
import type { DiagnosticRouteResult } from '../baseline-contracts.ts';
/** Routing is pure and uses candidate snapshots, without access to transport or secrets. */
export class DiagnosticRouter {
    resolve(candidates: readonly ScanCandidate[], domAvailable: boolean): readonly DiagnosticRouteResult[] { return planDiagnosticRoutes(candidates, domAvailable); }
}
export function isTransportChannelUrl(url: string): boolean {
    try {
        return /\/(?:socket\.io|engine\.io|sockjs|signalr|pusher|mqtt)(?:\/|$)/i.test(new URL(url).pathname);
    }
    catch {
        return true;
    }
}
export function diagnosticTracksFor(url: string, method: string, inputPoints: readonly RequestInputPoint[], hasJavascript: boolean, observedContentType?: string): readonly DiagnosticTrack[] {
    const text = `${url} ${method} ${inputPoints.map((point) => `${point.name}:${point.type}`).join(' ')}`.toLowerCase();
    const tracks = new Set<DiagnosticTrack>();
    const interactiveMutation = requiresInteractiveStateChange(inputPoints);
    if (inputPoints.length > 0 && !interactiveMutation)
        tracks.add('zap-active');
    if (interactiveMutation)
        tracks.add('workflow-state');
    if (hasJavascript || /\b(?:javascript|script|html|content)\b/.test(text))
        tracks.add('browser-dom');
    if (/\b(?:csrf|captcha|confirm|approval|state|step)\b/.test(text))
        tracks.add('workflow-state');
    if (/\b(?:session|token|jwt|sid)\b/.test(text))
        tracks.add('session-analysis');
    if (/authori[sz]|\brole\b|\buser[_-]?id\b|\baccount[_-]?id\b/.test(text))
        tracks.add('authorization-differential');
    if (inputPoints.some((point) => point.location === 'file') || /upload/.test(text))
        tracks.add('upload-workflow');
    if (/\/api(?:\/|$)|graphql|openapi|swagger/.test(text))
        tracks.add('api-schema');
    if (/crypt|cipher|encrypt|decrypt/.test(text))
        tracks.add('cryptography-review');
    // 観測済みの JSON 応答は API 表面の強い根拠 (パス命名に依存しない api-schema 適用)。
    if (observedContentType !== undefined && /application\/(?:[\w.+-]*\+)?json/i.test(observedContentType))
        tracks.add('api-schema');
    // エンティティ ID を持つ読み取り経路は認可差分 (role 間比較) の対象になる。
    try {
        if (/\/\d+(?:\/|$)/.test(new URL(url).pathname))
            tracks.add('authorization-differential');
    }
    catch {
        // 相対 URL 等はスキップ (他規則で評価)。
    }
    if (tracks.size === 0)
        tracks.add('zap-active');
    return [...tracks];
}
export function requiresInteractiveStateChange(inputPoints: readonly RequestInputPoint[]): boolean {
    const names = inputPoints.map((point) => point.name.trim().toLowerCase().replace(/[-\s]+/g, '_'));
    const changesCredential = names.some((name) => /^(?:new_?)?(?:pass|passwd|password)(?:_new|_conf|_confirm|_confirmation)?$/.test(name)
        && (name.includes('new') || name.includes('conf')));
    const hasMutationSubmit = names.some((name) => /^(?:change|update|save|reset|delete|remove|disable|enable)$/.test(name));
    return changesCredential && hasMutationSubmit;
}
export function candidateAllowsAutomatedZap(candidate: ScanCandidate): boolean {
    const tracks = candidate.diagnosticTracks ?? ['zap-active'];
    return tracks.includes('zap-active') && !requiresInteractiveStateChange(candidate.inputPoints ?? []);
}
export function diagnosticRouteDetail(track: DiagnosticTrack, domAvailable: boolean): Pick<DiagnosticRouteResult, 'status' | 'detail'> {
    switch (track) {
        case 'zap-active':
            return { status: 'delegated', detail: '認証済みHTTP request seedとしてZAPへ委譲します' };
        case 'browser-dom':
            return domAvailable
                ? { status: 'delegated', detail: 'PlaywrightでDOM source→sinkを自動観測します' }
                : { status: 'unavailable', detail: 'Playwright DOM observerが構成されていません' };
        case 'workflow-state':
            return { status: 'needs-input', detail: '保存型XSS、CSRF、CAPTCHA等の状態遷移・確認手順が必要です' };
        case 'session-analysis':
            return { status: 'needs-input', detail: 'トークン抽出位置と再送手順が必要です' };
        case 'authorization-differential':
            return { status: 'needs-input', detail: '比較する複数roleと期待結果が必要です' };
        case 'upload-workflow':
            return { status: 'needs-input', detail: '許可されたサンプルファイルと成功判定が必要です' };
        case 'api-schema':
            return { status: 'needs-input', detail: 'OpenAPI/GraphQL schemaまたは有効なrequest body例が必要です' };
        case 'cryptography-review':
            return { status: 'needs-input', detail: '対象データ、期待する保護要件、復号・検証手順が必要です' };
    }
}
export function planDiagnosticRoutes(adopted: readonly ScanCandidate[], domAvailable: boolean): readonly DiagnosticRouteResult[] {
    const grouped = new Map<string, {
        track: DiagnosticTrack;
        targetUrl: string;
        candidateCount: number;
    }>();
    for (const candidate of adopted) {
        const targetUrl = ScopePolicy.canonicalUrl(candidate.url);
        for (const track of candidate.diagnosticTracks ?? ['zap-active']) {
            if (track === 'zap-active' && !candidateAllowsAutomatedZap(candidate))
                continue;
            const key = `${track}\0${targetUrl}`;
            const existing = grouped.get(key);
            grouped.set(key, {
                track,
                targetUrl,
                candidateCount: (existing?.candidateCount ?? 0) + 1,
            });
        }
    }
    return [...grouped.values()].map((route) => ({
        ...route,
        ...diagnosticRouteDetail(route.track, domAvailable),
    }));
}
export function updateDiagnosticRoute(routes: readonly DiagnosticRouteResult[], track: DiagnosticTrack, targetUrl: string, update: Pick<DiagnosticRouteResult, 'status' | 'detail'> & {
    readonly findingCount?: number;
}): readonly DiagnosticRouteResult[] {
    return routes.map((route) => route.track === track && route.targetUrl === targetUrl
        ? { ...route, ...update }
        : route);
}
