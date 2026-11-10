import { canonicalJson, domainError, hashStable, type AuthorizationRecord, type CaseRecord, type ExecutionPlan, type OperatorProfile } from '@scopepilot2/contracts';
import { ScopePolicy } from '../../domain/scope-policy.ts';
import { businessTargetInScope, evaluateRestore, parseExpectation, planRoleMatrix, resolveOutcome, type ComparisonOutcome } from '../../domain/business-logic.ts';
import { derivePasswordVariant, judgeLoginVariant, judgePageProbe, planAuthBypassCheck, sessionCookiesForPattern, summarizeAuthBypassOutcomes, type AuthBypassCheckListItem, type AuthBypassCheckRecord, type AuthBypassCheckSummary, type AuthBypassPagePattern, type AuthBypassProbeOutcome, type AuthBypassProbeResult } from '../../domain/auth-bypass.ts';
import { INPUT_ROBUSTNESS_MAX_VALUES, INPUT_ROBUSTNESS_PAYLOADS, PASSWORD_POLICY_CONTROL, RESET_TOKEN_PATTERNS, WEAK_PASSWORD_CANDIDATES, assertRequestBudget, countNucleiMatches, findMixedContent, findSerializationSignature, findSensitiveUrlParamNames, forgeResetToken, judgeCorsPreflight, judgeCorsResponse, judgeInputRobustness, judgeDirectoryListing, judgeIdorAccess, judgeLockout, judgeMassAssignment, judgeNucleiSpot, judgeOtpBoundary, judgeOtpSubmission, judgePasswordEcho, judgePiiExposure, judgePlainHttp, judgeReplay, judgeResponseContentType, judgeSensitiveCache, judgeSamlAssertionReplay, judgeUserEnumeration, judgeVersionDisclosure, mergeJsonFields, normalizeEnumerationResponse, parseDefaultCredentialPairs, parseExtraFieldsJson, planIdorProbes, planLockoutSequence, planOtpExpiryWaitMs, planOtpWrongAttempts, planReplayCount, requireImplementedTheme, summarizeThemeOutcomes, validateSpotTemplateIds, OTP_INBOX_TIMEOUT_MS, type OtpSubmissionOutcome, type ThemeCheckProbeResult, type ThemeCheckSummary } from '../../domain/zap-unsupported.ts';
import { detectAuthState, validateLoginFlow, type LoginFlowStep } from '../../domain/authentication-session.ts';
import { applicableSessionCookies } from '../../domain/repeater.ts';
import type { BrowserSessionState, InteractiveBrowserFile, InteractiveBrowserPort, InteractiveBrowserStep, LoginSessionCookie } from '../../ports/engines.ts';
import type { BaselineFlowDeps, InteractiveDiagnosticRunInput, InteractiveDiagnosticItemResult, SequencerTokenSource, SequencerSessionResult } from '../baseline-contracts.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import type { EvidenceServicePort } from './evidence-service.ts';
import type { ExecutionContext } from './execution-context.ts';
import type { SessionVault } from './session-vault.ts';
import { requirePermission } from './authorization-policy.ts';
export interface GuidelineExecutionServicePorts {
    currentCase(): CaseRecord;
    currentAuthorization(): AuthorizationRecord;
    runSequencerSession(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly samples: number;
        readonly role?: string;
        readonly tokenSource?: SequencerTokenSource;
        readonly tokenCookieName?: string;
        readonly tokenFieldName?: string;
        readonly tokenStartDelimiter?: string;
        readonly tokenEndDelimiter?: string;
        readonly replayRequest?: {
            readonly method?: string;
            readonly headers?: readonly (readonly [
                string,
                string
            ])[];
            readonly body?: string;
        };
        readonly signal?: AbortSignal;
    }): Promise<SequencerSessionResult>;
    /**
     * OpenAPI/Swagger 仕様の取込 (design/f12)。文書内の instruction/script は実行しない。
     * server は許可 Origin 内だけ候補化し (F12-UT-001)、endpoint (method+path+url) を
     * 返す。path template ({id} 等) は警告付きでそのまま返す — 値は利用者が明示する。
     * 生成された要求は呼出側で ExecutionPlan に入れて確認する (A08 の対象へ設定)。
     */
    importApiSpec(operator: OperatorProfile, input: {
        readonly documentLabel: string;
        readonly document: unknown;
    }): {
        documentLabel: string;
        servers: readonly string[];
        excludedServers: readonly string[];
        endpoints: readonly {
            method: string;
            path: string;
            url: string;
        }[];
        warnings: readonly string[];
    };
}
export class GuidelineExecutionService {
    private readonly deps: Pick<BaselineFlowDeps, 'interactiveBrowser' | 'ids' | 'clock' | 'loginExecutor' | 'repeaterTransport' | 'otpInbox' | 'samlFixture' | 'sleep' | 'fuzzTransport' | 'nucleiRunner' | 'webSocketTransport' | 'domObserver'>;
    private readonly ports: GuidelineExecutionServicePorts;
    private readonly events: EventPublisherPort;
    private readonly context: ExecutionContext;
    private readonly vault: SessionVault;
    private readonly evidence: EvidenceServicePort;
    constructor(deps: GuidelineExecutionService['deps'], ports: GuidelineExecutionServicePorts, events: EventPublisherPort, context: ExecutionContext, vault: SessionVault, evidence: EvidenceServicePort) {
        this.deps = deps;
        this.ports = ports;
        this.events = events;
        this.context = context;
        this.vault = vault;
        this.evidence = evidence;
    }
    async runBusinessLogicCheck(operator: OperatorProfile, input: {
        readonly roles: readonly string[];
        readonly targetUrl: string;
        readonly expectation: {
            readonly expression: string;
            readonly args: readonly unknown[];
        };
    }): Promise<{
        checkId: string;
        roles: readonly string[];
        matrix: {
            readonly evidenceSeparated: boolean;
        };
        observations: readonly {
            role: string;
            observation: string | null;
        }[];
        comparison: {
            readonly outcome: ComparisonOutcome;
        };
        restore: {
            readonly outcome: 'restored' | 'restore-failed';
        };
        status: 'pass' | 'fail' | 'not-run';
        reason?: string;
    }> {
        requirePermission(operator, 'run.manage');
        const caseRecord = this.ports.currentCase();
        const authorization = this.ports.currentAuthorization();
        if (!authorization.allowedOperationClasses.includes('CrossRoleTest')) {
            throw domainError('OutOfScope', 'authorization does not allow CrossRoleTest for this case');
        }
        if (input.roles.length < 2 || new Set(input.roles).size !== input.roles.length) {
            throw domainError('ValidationFailed', 'business logic check needs 2 or more distinct roles');
        }
        for (const role of input.roles) {
            if (!this.vault.loginFlows.has(role)) {
                throw domainError('ValidationFailed', `login flow for ${role} is not registered`);
            }
        }
        if (!businessTargetInScope(input.targetUrl, caseRecord.scope)) {
            throw domainError('OutOfScope', `business target is out of scope: ${input.targetUrl}`);
        }
        const expectation = parseExpectation(input.expectation);
        const matrix = planRoleMatrix(input.roles);
        // fixture 観測: session を refresh 済みの role だけが認証付き観測を持つ (未 refresh は null)。
        if (this.deps.interactiveBrowser === undefined)
            throw domainError('CapabilityUnavailable', 'business logic browser is not configured');
        const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
        const measured: {
            role: string;
            response: Awaited<ReturnType<InteractiveBrowserPort['execute']>> | null;
        }[] = [];
        for (const role of input.roles) {
            const session = this.vault.roleSessionCookies.get(role);
            if (session === undefined) {
                measured.push({ role, response: null });
                continue;
            }
            measured.push({
                role,
                response: await this.deps.interactiveBrowser.execute({
                    targetUrl: canonical,
                    scope: caseRecord.scope,
                    steps: [{ kind: 'navigate', target: canonical }],
                    sessionCookies: applicableSessionCookies(session.cookies, canonical),
                }),
            });
        }
        const observations = measured.map(({ role, response }) => ({
            role,
            observation: response === null ? null : `status=${response.status ?? 'unknown'};bodyHash=${response.bodyHash}`,
        }));
        const primary = measured[0]?.response ?? null;
        // どれかの role でも観測が欠けたら inconclusive (成功/失敗を推測しない)。
        let comparison: {
            outcome: ComparisonOutcome;
        };
        if (measured.some((entry) => entry.response === null) || primary === null) {
            comparison = { outcome: 'inconclusive' };
        }
        else {
            const first = input.expectation.args[0];
            const second = input.expectation.args[1];
            let matched: boolean | null = null;
            if (expectation.expression === 'status.equals')
                matched = typeof first === 'number' && primary.status === first;
            else if (expectation.expression === 'status.in')
                matched = input.expectation.args.some((value) => typeof value === 'number' && value === primary.status);
            else if (expectation.expression === 'body.contains')
                matched = typeof first === 'string' && primary.bodyText.includes(first);
            else if (expectation.expression === 'body.notContains')
                matched = typeof first === 'string' && !primary.bodyText.includes(first);
            else if (expectation.expression === 'header.equals')
                matched = typeof first === 'string' && typeof second === 'string'
                    && primary.headers.some(([name, value]) => name.toLocaleLowerCase() === first.toLocaleLowerCase() && value === second);
            else if (expectation.expression === 'elapsedMs.lessThan')
                matched = typeof first === 'number' && primary.elapsedMs < first;
            else if (expectation.expression === 'elapsedMs.greaterThan')
                matched = typeof first === 'number' && primary.elapsedMs > first;
            comparison = matched === null ? { outcome: 'inconclusive' } : { outcome: matched ? 'pass' : 'fail' };
        }
        const restore = evaluateRestore([
            { name: 'verify-state', passed: comparison.outcome !== 'fail' },
            { name: 'restore-navigate', passed: true },
        ]);
        const outcome = resolveOutcome({ setupBlocked: false, assertionPassed: comparison.outcome === 'pass' && restore.outcome === 'restored' });
        const checkId = this.deps.ids.next('bizcheck');
        const record = {
            checkId,
            roles: [...input.roles],
            targetUrl: input.targetUrl,
            status: outcome.status,
            comparison: comparison.outcome,
            restore: restore.outcome,
            executedAt: this.deps.clock.now().toISOString(),
        };
        (this.context.businessChecks as {
            checkId: string;
            roles: readonly string[];
            targetUrl: string;
            status: string;
            comparison: string;
            restore: string;
            executedAt: string;
        }[]).push(record);
        await this.evidence.saveText(`business-logic:${checkId}`, canonicalJson({
            checkId,
            targetUrl: canonical,
            roles: measured.map(({ role, response }) => response === null ? { role, observation: null } : {
                role,
                status: response.status,
                finalUrl: response.finalUrl,
                bodyHash: response.bodyHash,
                elapsedMs: response.elapsedMs,
                headerNames: response.headers.map(([name]) => name),
            }),
            expectation: { expression: input.expectation.expression, argTypes: input.expectation.args.map((value) => typeof value) },
            comparison: comparison.outcome,
        }), { targetUrl: canonical, kind: 'business-logic' });
        this.events.publish({ type: 'BusinessLogicCheckCompleted', at: record.executedAt, checkId, roles: [...input.roles], status: outcome.status });
        return {
            checkId,
            roles: [...input.roles],
            matrix: { evidenceSeparated: matrix.evidenceSeparated },
            observations,
            comparison,
            restore,
            status: outcome.status,
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        };
    }
    listBusinessLogicChecks(): readonly {
        checkId: string;
        roles: readonly string[];
        targetUrl: string;
        status: string;
        comparison: string;
        restore: string;
        executedAt: string;
    }[] {
        return [...this.context.businessChecks];
    }
    async runAuthBypassCheck(operator: OperatorProfile, input: {
        readonly role: string;
        readonly targetUrls?: readonly string[];
        readonly authCookieNames?: readonly string[];
        readonly includeLoginVariants?: boolean;
        readonly secretValues?: Readonly<Record<string, string>>;
        readonly loginBaseUrl?: string;
    }): Promise<AuthBypassCheckSummary> {
        requirePermission(operator, 'run.manage');
        const caseRecord = this.ports.currentCase();
        const authorization = this.ports.currentAuthorization();
        if (!authorization.allowedOperationClasses.includes('ActiveScan')) {
            throw domainError('OutOfScope', 'authorization does not allow ActiveScan for this case');
        }
        const session = this.vault.roleSessionCookies.get(input.role);
        if (session === undefined) {
            throw domainError('ValidationFailed', `no authenticated session for role '${input.role}'; run login first`);
        }
        const targetUrls = input.targetUrls === undefined || input.targetUrls.length === 0
            ? (session.verificationUrl === undefined ? [] : [session.verificationUrl])
            : input.targetUrls;
        for (const target of targetUrls) {
            if (!businessTargetInScope(target, caseRecord.scope)) {
                throw domainError('OutOfScope', `auth bypass target is out of scope: ${target}`);
            }
        }
        const includeLoginVariants = input.includeLoginVariants === true;
        const plan = planAuthBypassCheck({ targetUrls, includeLoginVariants });
        if (plan.totalRequests > caseRecord.scope.limits.maxRequests) {
            throw domainError('ValidationFailed', `auth bypass check needs ${plan.totalRequests} requests which exceeds the case limit ${caseRecord.scope.limits.maxRequests}`);
        }
        if (this.deps.interactiveBrowser === undefined) {
            throw domainError('CapabilityUnavailable', 'interactive browser is not configured for this service');
        }
        // Excel 注意欄どおり、書き換え対象は利用者が事前に特定した認証用 cookie に限る。
        // 全 cookie を暗黙に対象にすると、認証回避ではなくセッション破壊を観測してしまう。
        const requestedCookieNames = (input.authCookieNames ?? []).map((name) => name.trim()).filter((name) => name !== '');
        if (requestedCookieNames.length === 0) {
            throw domainError('NeedsInput', 'theme 1 requires explicitly identified authentication cookie names');
        }
        const sessionCookieNames = new Set(session.cookies.map((cookie) => cookie.name));
        const unknownCookieNames = requestedCookieNames.filter((name) => !sessionCookieNames.has(name));
        if (unknownCookieNames.length > 0) {
            throw domainError('ValidationFailed', `authentication cookie names are not present in the selected session: ${unknownCookieNames.join(', ')}`);
        }
        const authCookieNames = new Set(requestedCookieNames);
        const markers = session.verificationMarkers ?? [];
        const containsMarker = (bodyText: string): boolean => markers.some((marker) => bodyText.includes(marker));
        // 観測 → 判定の 2 段階で使うため、判定結果だけ mutable に持つ。
        const probes: (Omit<AuthBypassProbeResult, 'outcome'> & {
            outcome: AuthBypassProbeOutcome | null;
        })[] = [];
        const runPageProbe = async (targetUrl: string, pattern: AuthBypassPagePattern): Promise<void> => {
            const canonical = ScopePolicy.canonicalUrl(targetUrl);
            const cookies = sessionCookiesForPattern(applicableSessionCookies([...session.cookies], canonical), pattern, authCookieNames);
            const response = await this.deps.interactiveBrowser!.execute({
                targetUrl: canonical,
                scope: caseRecord.scope,
                steps: [{ kind: 'navigate', target: canonical }],
                ...(cookies === undefined ? {} : { sessionCookies: cookies }),
            });
            probes.push({
                kind: 'page',
                pattern,
                targetUrl: canonical,
                status: response.status,
                finalUrl: response.finalUrl,
                bodyHash: response.bodyHash,
                outcome: null,
                markersFound: markers.length === 0 ? null : containsMarker(response.bodyText),
            });
        };
        for (const targetUrl of plan.targetUrls) {
            await runPageProbe(targetUrl, 'session-baseline');
        }
        // baseline で認証後コンテンツを確認できた target だけ変種を送る (未確認 target は無駄打ちしない)。
        const baselineByTarget = new Map(plan.targetUrls.map((targetUrl) => {
            const canonical = ScopePolicy.canonicalUrl(targetUrl);
            return [canonical, probes.find((probe) => probe.pattern === 'session-baseline' && probe.targetUrl === canonical)];
        }));
        for (const targetUrl of plan.targetUrls) {
            const canonical = ScopePolicy.canonicalUrl(targetUrl);
            const baseline = baselineByTarget.get(canonical);
            if (baseline === undefined || baseline.markersFound === false) {
                continue;
            }
            for (const pattern of ['auth-cookie-emptied', 'auth-cookie-removed', 'no-session'] as const) {
                await runPageProbe(targetUrl, pattern);
            }
        }
        // 判定は観測の後で一括して行う (baseline と変種の hash・marker を比較するため)。
        for (const probe of probes) {
            if (probe.pattern === 'session-baseline') {
                // baseline は判定対象ではなく参照観測。認証後コンテンツ未確認の場合だけ記録する。
                probe.outcome = probe.markersFound === false ? 'inconclusive' : null;
                continue;
            }
            const baseline = baselineByTarget.get(probe.targetUrl);
            if (baseline === undefined) {
                probe.outcome = 'inconclusive';
                continue;
            }
            probe.outcome = judgePageProbe({
                markers,
                baseline: { status: baseline.status, bodyHash: baseline.bodyHash, markersFound: baseline.markersFound === true },
                variant: { status: probe.status, finalUrl: probe.finalUrl, targetUrl: probe.targetUrl, bodyHash: probe.bodyHash, markersFound: probe.markersFound === true },
            });
        }
        // IPA手順 ③: ログイン要求の password 書き換え。秘密値はこの実行の間だけ使う。
        const loginVariantsNotRun: string[] = [];
        if (includeLoginVariants) {
            const flow = this.vault.loginFlows.get(input.role);
            const executor = this.deps.loginExecutor;
            if (flow === undefined || executor === undefined || input.secretValues === undefined) {
                loginVariantsNotRun.push(...plan.loginPatterns);
            }
            else {
                const passwordReference = input.secretValues.password !== undefined && flow.secretReferences.includes('password')
                    ? 'password'
                    : flow.secretReferences.find((reference) => flow.steps.some((step) => step.kind === 'fill' && step.secretReference === reference));
                if (passwordReference === undefined || input.secretValues[passwordReference] === undefined) {
                    throw domainError('NeedsInput', `secret value for reference '${String(passwordReference)}' was not provided for login variants`);
                }
                const loginBaseUrl = input.loginBaseUrl ?? session.expectedUrlPrefix ?? new URL(plan.targetUrls[0]!).origin;
                for (const pattern of plan.loginPatterns) {
                    const variantSecrets: Record<string, string> = { ...input.secretValues };
                    let steps = flow.steps;
                    if (pattern === 'password-omitted') {
                        steps = steps.filter((step) => !(step.kind === 'fill' && step.secretReference === passwordReference));
                    }
                    else {
                        variantSecrets[passwordReference] = derivePasswordVariant(pattern, input.secretValues[passwordReference]!);
                    }
                    const result = await executor.execute({
                        baseUrl: loginBaseUrl,
                        steps,
                        secretValues: variantSecrets,
                        expectedUrlPrefix: session.expectedUrlPrefix ?? loginBaseUrl,
                    });
                    probes.push({
                        kind: 'login',
                        pattern,
                        targetUrl: loginBaseUrl,
                        status: null,
                        finalUrl: result.finalUrl,
                        bodyHash: '',
                        outcome: judgeLoginVariant(result.authenticated),
                        markersFound: null,
                    });
                }
            }
        }
        const judged = probes.filter((probe) => probe.outcome !== null);
        const summary = summarizeAuthBypassOutcomes(judged.map((probe) => probe.outcome!));
        const checkId = this.deps.ids.next('authbypass');
        const record: AuthBypassCheckRecord = {
            checkId,
            themeNo: '1',
            role: input.role,
            status: summary.status,
            totalRequests: probes.length,
            loginVariantsNotRun,
            executedAt: this.deps.clock.now().toISOString(),
        };
        (this.context.authBypassChecks as AuthBypassCheckRecord[]).push(record);
        // 監査記録: cookie 名・marker 名・応答の status/hash のみ。値も本文も含めない。
        await this.evidence.saveText(`auth-bypass:${checkId}`, canonicalJson({
            checkId,
            themeNo: record.themeNo,
            role: input.role,
            authCookieNames: [...authCookieNames],
            markers,
            results: probes.map((probe) => ({
                kind: probe.kind,
                pattern: probe.pattern,
                targetUrl: probe.targetUrl,
                status: probe.status,
                finalUrl: probe.finalUrl,
                bodyHash: probe.bodyHash,
                outcome: probe.outcome,
            })),
            status: summary.status,
        }), { targetUrl: plan.targetUrls[0] ?? '', kind: 'auth-bypass' });
        this.events.publish({ type: 'AuthBypassCheckCompleted', at: record.executedAt, checkId, role: input.role, status: summary.status });
        return { ...record, results: probes };
    }
    listAuthBypassChecks(): readonly AuthBypassCheckListItem[] {
        return [...this.context.authBypassChecks];
    }
    async runZapUnsupportedCheck(operator: OperatorProfile, input: {
        readonly themeNo: string;
        readonly role?: string;
        readonly targetUrls?: readonly string[];
        readonly params?: Readonly<Record<string, string>>;
        readonly secretValues?: Readonly<Record<string, string>>;
    }): Promise<ThemeCheckSummary> {
        requirePermission(operator, 'run.manage');
        const themeNo = requireImplementedTheme(input.themeNo);
        if (themeNo === '1') {
            // テーマ1は専用 route (POST /api/auth-bypass/checks) を使う。
            throw domainError('ValidationFailed', 'theme 1 uses POST /api/auth-bypass/checks');
        }
        const caseRecord = this.ports.currentCase();
        const authorization = this.ports.currentAuthorization();
        if (!authorization.allowedOperationClasses.includes('ActiveScan')) {
            throw domainError('OutOfScope', 'authorization does not allow ActiveScan for this case');
        }
        const targets = (input.targetUrls ?? []).map((url) => url.trim()).filter((url) => url !== '');
        for (const target of targets) {
            if (!businessTargetInScope(target, caseRecord.scope)) {
                throw domainError('OutOfScope', `theme ${themeNo} target is out of scope: ${target}`);
            }
        }
        const params = input.params ?? {};
        const secrets = input.secretValues ?? {};
        const requireSession = (): {
            role: string;
            cookies: readonly LoginSessionCookie[];
            browserState: BrowserSessionState;
            markers: readonly string[];
        } => {
            const role = input.role ?? '';
            const session = this.vault.roleSessionCookies.get(role);
            if (session === undefined) {
                throw domainError('ValidationFailed', `no authenticated session for role '${role}'; run login first`);
            }
            return { role, cookies: session.cookies, browserState: session.browserState, markers: session.verificationMarkers ?? [] };
        };
        const requireFlow = (role: string | undefined): {
            steps: readonly LoginFlowStep[];
            markers: readonly string[];
        } => {
            const flow = this.vault.loginFlows.get(role ?? '');
            if (flow === undefined) {
                throw domainError('ValidationFailed', `login flow for '${role ?? ''}' is not registered`);
            }
            return { steps: flow.steps, markers: flow.steps.flatMap((step) => step.kind === 'assert' && step.target !== undefined ? [step.target] : []) };
        };
        const browser = () => {
            if (this.deps.interactiveBrowser === undefined)
                throw domainError('CapabilityUnavailable', 'interactive browser is not configured for this service');
            return this.deps.interactiveBrowser;
        };
        const repeater = () => {
            if (this.deps.repeaterTransport === undefined)
                throw domainError('CapabilityUnavailable', 'repeater transport is not configured for this service');
            return this.deps.repeaterTransport;
        };
        const probes: (Omit<ThemeCheckProbeResult, 'outcome'> & {
            outcome: AuthBypassProbeOutcome | null;
        })[] = [];
        let skipped: string[] = [];
        const requestBudget = (planned: number): void => assertRequestBudget(planned, caseRecord.scope.limits.maxRequests, themeNo);
        /** f09 の flow DSL を browser DSL へ解決する (fill の値はこの呼出の間だけ使う)。 */
        const translateFlow = (steps: readonly LoginFlowStep[], secretValues: Readonly<Record<string, string>>, baseUrl: string): InteractiveBrowserStep[] => {
            const resolveTarget = (target: string): string => target.startsWith('http://') || target.startsWith('https://') ? target : `${new URL(baseUrl).origin}/${target.replace(/^\/+/, '')}`;
            return steps.map((step): InteractiveBrowserStep => {
                if (step.kind === 'navigate')
                    return { kind: 'navigate', target: resolveTarget(step.target ?? baseUrl) };
                if (step.kind === 'fill') {
                    const value = secretValues[step.secretReference ?? ''];
                    if (value === undefined) {
                        throw domainError('NeedsInput', `secret value for reference '${step.secretReference ?? ''}' was not provided`);
                    }
                    return { kind: 'fill', target: step.target ?? '', value };
                }
                if (step.kind === 'select' || step.kind === 'assertValue')
                    return { kind: step.kind, target: step.target ?? '', value: step.value ?? '' };
                if (step.kind === 'extract') {
                    throw domainError('ValidationFailed', 'extract step is not supported by the interactive browser DSL');
                }
                return { kind: step.kind, target: step.target ?? '' };
            });
        };
        const runFlow = async (pattern: string, targetUrl: string, steps: readonly LoginFlowStep[], secretValues: Readonly<Record<string, string>>): Promise<{
            status: number | null;
            finalUrl: string;
            bodyHash: string;
            comparisonHash: string;
            elapsedMs: number;
            assertionsPassed: boolean;
            echoedSecretReferences: readonly string[];
        }> => {
            const response = await browser().execute({ targetUrl: ScopePolicy.canonicalUrl(targetUrl), scope: caseRecord.scope, steps: translateFlow(steps, secretValues, targetUrl) });
            const assertionsPassed = response.assertions.every((assertion) => assertion.passed);
            // 応答への値の露出は「この実行で渡した値」だけで判定する。'password' は画面に
            // 出る語であり誤検知になるため除外する (Excel: パスワードが応答に含まれる)。
            const echoedSecretReferences = Object.entries(secretValues)
                .filter(([, value]) => value !== '' && value !== 'password' && response.bodyText.includes(value))
                .map(([reference]) => reference);
            const comparisonHash = hashStable('scopepilot2.theme.response-comparison', { body: normalizeEnumerationResponse(response.bodyText) });
            return { status: response.status, finalUrl: response.finalUrl, bodyHash: response.bodyHash, comparisonHash, elapsedMs: response.elapsedMs, assertionsPassed, echoedSecretReferences };
        };
        const rawRequest = (method: string, targetUrl: string, headers: readonly (readonly [
            string,
            string
        ])[], body: string): string => {
            const parsed = new URL(targetUrl);
            return `${method.toUpperCase()} ${parsed.pathname}${parsed.search} HTTP/1.1\nHost: ${parsed.host}\n${headers.map(([name, value]) => `${name}: ${value}`).join('\n')}\n\n${body}`;
        };
        const headerValue = (headers: readonly (readonly [
            string,
            string
        ])[], name: string): string | null => {
            const found = headers.find(([headerName]) => headerName.toLocaleLowerCase() === name.toLocaleLowerCase());
            return found === undefined ? null : found[1];
        };
        switch (themeNo) {
            case '2': {
                // 既定アカウント・既定資格: 文書由来の少数組を login 形式で試行 (辞書攻撃ではない)。
                const role = input.role ?? '';
                const flow = requireFlow(role);
                const session = this.vault.roleSessionCookies.get(role);
                const expectedUrlPrefix = params.expectedUrlPrefix ?? session?.expectedUrlPrefix ?? new URL(targets[0] ?? 'http://fixture.invalid/').origin;
                const pairs = parseDefaultCredentialPairs((params.defaultPairs ?? '').split('\n'));
                requestBudget(pairs.length);
                const usernameRef = params.usernameReference ?? 'username';
                const passwordRef = params.passwordReference ?? 'password';
                for (const pair of pairs) {
                    const run = await runFlow(`default-credential:${pair.username}`, expectedUrlPrefix, flow.steps, { [usernameRef]: pair.username, [passwordRef]: pair.password });
                    const authenticated = detectAuthState({ expectedUrlPrefix, finalUrl: run.finalUrl, assertResult: run.assertionsPassed });
                    probes.push({ kind: 'flow', pattern: `default-credential:${pair.username}`, targetUrl: expectedUrlPrefix, status: run.status, finalUrl: run.finalUrl, bodyHash: run.bodyHash, outcome: authenticated === 'authenticated' ? 'exposed' : 'denied' });
                }
                break;
            }
            case '3': {
                // パスワードポリシー: IPA検出パターンの弱い値の受理と、応答への露出 (表示)。
                const steps = JSON.parse(params.steps ?? '[]') as LoginFlowStep[];
                validateLoginFlow(steps);
                const fieldReference = params.fieldReference ?? '';
                if (fieldReference.trim() === '') {
                    throw domainError('ValidationFailed', 'theme 3 requires fieldReference (the secret reference of the new password field)');
                }
                const baseUrl = targets[0];
                if (baseUrl === undefined)
                    throw domainError('ValidationFailed', 'theme 3 requires a target URL (flow base)');
                const usernameReference = params.usernameReference ?? 'username';
                const usernameCandidate = secrets[usernameReference];
                const candidates: readonly {
                    label: string;
                    value: string;
                    expected: 'reject' | 'accept-control';
                }[] = [
                    ...WEAK_PASSWORD_CANDIDATES.map((value) => ({ label: value === '' ? '(empty)' : value, value, expected: 'reject' as const })),
                    ...(usernameCandidate === undefined ? [] : [{ label: '(same-as-username)', value: usernameCandidate, expected: 'reject' as const }]),
                    { label: '(IPA-acceptance-control)', value: PASSWORD_POLICY_CONTROL, expected: 'accept-control' as const },
                ];
                requestBudget(candidates.length);
                let echoOutcome: AuthBypassProbeOutcome | null = null;
                for (const candidate of candidates) {
                    const run = await runFlow(`password-policy:${candidate.label}`, baseUrl, steps, { ...secrets, [fieldReference]: candidate.value });
                    const outcome: AuthBypassProbeOutcome | null = candidate.expected === 'reject'
                        ? (run.assertionsPassed ? 'exposed' : 'denied')
                        : (run.assertionsPassed ? null : 'inconclusive');
                    probes.push({ kind: 'flow', pattern: `password-policy:${candidate.label}`, targetUrl: ScopePolicy.canonicalUrl(baseUrl), status: run.status, finalUrl: run.finalUrl, bodyHash: run.bodyHash, outcome });
                    if (run.echoedSecretReferences.includes(fieldReference)) {
                        echoOutcome = judgePasswordEcho(true);
                    }
                }
                if (echoOutcome !== null) {
                    probes.push({ kind: 'browser', pattern: 'password-echo-in-response', targetUrl: ScopePolicy.canonicalUrl(baseUrl), status: null, finalUrl: '', bodyHash: '', outcome: echoOutcome });
                }
                skipped = ['reversible-storage verification (requires storage/configuration review)', 'password-change side-effect restoration must be confirmed for the diagnostic account'];
                break;
            }
            case '4': {
                // パスワードリセット: 無効 token (空・forge・省略) で再設定が成立しないこと。
                const steps = JSON.parse(params.steps ?? '[]') as LoginFlowStep[];
                validateLoginFlow(steps);
                const fieldReference = params.fieldReference ?? '';
                if (fieldReference.trim() === '') {
                    throw domainError('ValidationFailed', 'theme 4 requires fieldReference (the secret reference of the reset token field)');
                }
                const baseUrl = targets[0];
                if (baseUrl === undefined)
                    throw domainError('ValidationFailed', 'theme 4 requires a target URL (flow base)');
                requestBudget(RESET_TOKEN_PATTERNS.length);
                for (const pattern of RESET_TOKEN_PATTERNS) {
                    const variantSteps = pattern === 'token-omitted'
                        ? steps.filter((step) => !(step.kind === 'fill' && step.secretReference === fieldReference))
                        : steps;
                    const variantSecrets = pattern === 'token-emptied' ? { ...secrets, [fieldReference]: '' } : pattern === 'token-forged' ? { ...secrets, [fieldReference]: forgeResetToken() } : secrets;
                    const run = await runFlow(pattern, baseUrl, variantSteps, variantSecrets);
                    probes.push({ kind: 'flow', pattern, targetUrl: ScopePolicy.canonicalUrl(baseUrl), status: run.status, finalUrl: run.finalUrl, bodyHash: run.bodyHash, outcome: run.assertionsPassed ? 'exposed' : 'denied' });
                }
                skipped = ['email receipt verification (requires mailbox integration)', 'token randomness analysis (use A10 Sequencer)'];
                break;
            }
            case '5': {
                // ロックアウト: 合意した少数の連続失敗後、正当資格で認証できるかの観察のみ。
                const role = input.role ?? '';
                const flow = requireFlow(role);
                const executor = this.deps.loginExecutor;
                if (executor === undefined)
                    throw domainError('CapabilityUnavailable', 'login executor is not configured for this service');
                for (const reference of flow.steps.flatMap((step) => step.kind === 'fill' && step.secretReference !== undefined ? [step.secretReference] : [])) {
                    if (secrets[reference] === undefined) {
                        throw domainError('NeedsInput', `secret value for reference '${reference}' was not provided`);
                    }
                }
                const session = this.vault.roleSessionCookies.get(role);
                const baseUrl = params.baseUrl ?? session?.expectedUrlPrefix ?? new URL(targets[0] ?? 'http://fixture.invalid/').origin;
                const failureCount = Number.parseInt(params.failureCount ?? '5', 10);
                const sequence = planLockoutSequence(failureCount);
                requestBudget(sequence.length + 1);
                const fillRefs = flow.steps.flatMap((step) => step.kind === 'fill' && step.secretReference !== undefined ? [step.secretReference] : []);
                const passwordRef = fillRefs.includes('password') ? 'password' : fillRefs.at(-1) ?? 'password';
                const wrongSecrets = { ...secrets, [passwordRef]: `${secrets[passwordRef] ?? ''}A` };
                for (const pattern of sequence) {
                    await executor.execute({ baseUrl, steps: flow.steps, secretValues: wrongSecrets, expectedUrlPrefix: baseUrl });
                    probes.push({ kind: 'login', pattern, targetUrl: baseUrl, status: null, finalUrl: '', bodyHash: '', outcome: null });
                }
                let afterFailures: 'authenticated' | 'rejected' | 'errored';
                try {
                    const final = await executor.execute({ baseUrl, steps: flow.steps, secretValues: secrets, expectedUrlPrefix: baseUrl });
                    afterFailures = final.authenticated ? 'authenticated' : 'rejected';
                }
                catch {
                    afterFailures = 'errored';
                }
                probes.push({ kind: 'login', pattern: 'correct-after-failures', targetUrl: baseUrl, status: null, finalUrl: '', bodyHash: '', outcome: judgeLockout(afterFailures) });
                skipped = ['high-volume / high-rate testing (JMeter scope, needs prior agreement)', 'precise rate-limit measurement'];
                break;
            }
            case '6': {
                // MFAの段階スキップを、一次認証直後のsessionで保護APIへ到達できるかに限定して確認する。
                // OTP値の取得・再利用やSAML assertion replayは、対象固有fixtureを別途レビューして行う。
                const signInTarget = targets[0];
                const protectedTarget = targets[1];
                if (signInTarget === undefined || protectedTarget === undefined) {
                    throw domainError('ValidationFailed', 'theme 6 requires sign-in and protected target URLs');
                }
                const usernameReference = params.usernameReference ?? 'username';
                const passwordReference = params.passwordReference ?? 'password';
                const username = secrets[usernameReference];
                const password = secrets[passwordReference];
                if (username === undefined || password === undefined) {
                    throw domainError('NeedsInput', `theme 6 requires secret values for '${usernameReference}' and '${passwordReference}'`);
                }
                // OTP sub-check (handoff 2026-10-31 P1): 必要入力と許可済み fixture inbox が
                // 揃った sub-check だけ実行し、残りは理由を付けて skip する (全体を pass にしない)。
                const otpInbox = this.deps.otpInbox;
                const otpIssueUrl = (params.otpIssueUrl ?? '').trim();
                const otpVerifyUrl = (params.otpVerifyUrl ?? '').trim();
                const otpVerifyField = (params.otpVerifyField ?? '').trim() || 'code';
                const otpSuccessMarker = params.otpSuccessMarker ?? '';
                const otpMailboxRef = (params.otpMailboxRef ?? '').trim();
                const otpBaseReady = otpIssueUrl !== '' && otpVerifyUrl !== '' && otpSuccessMarker !== '' && otpMailboxRef !== '' && otpInbox !== undefined;
                const otpWrongAttempts = (params.otpWrongAttempts ?? '').trim() === '' ? null : planOtpWrongAttempts(Number.parseInt(params.otpWrongAttempts ?? '0', 10));
                const otpExpiryWaitMs = (params.otpExpirySeconds ?? '').trim() === '' ? null : planOtpExpiryWaitMs(Number.parseInt(params.otpExpirySeconds ?? '0', 10));
                const otpDestinationChangeUrl = (params.otpDestinationChangeUrl ?? '').trim();
                const otpDestinationChangeMarker = params.otpDestinationChangeMarker ?? '';
                const otpDestinationReady = otpDestinationChangeUrl !== '' && otpDestinationChangeMarker !== '' && input.role !== undefined && this.vault.roleSessionCookies.has(input.role);
                // SAML assertion replay は隔離された試験 IdP/SP fixture adapter が全体を駆動する
                // (Core は直接送信しない。IdP/SP が審査済み fixture であることは adapter 側で保証)。
                const samlFixture = this.deps.samlFixture;
                const samlIdpStartUrl = (params.samlIdpStartUrl ?? '').trim();
                const samlAcsUrl = (params.samlAcsUrl ?? '').trim();
                const samlReady = samlFixture !== undefined && samlIdpStartUrl !== '' && samlAcsUrl !== '';
                for (const otpEndpoint of [otpIssueUrl, otpVerifyUrl, otpDestinationChangeUrl]) {
                    if (otpEndpoint !== '' && !businessTargetInScope(otpEndpoint, caseRecord.scope)) {
                        throw domainError('OutOfScope', `theme 6 OTP endpoint is out of scope: ${otpEndpoint}`);
                    }
                }
                requestBudget(2
                    + (otpBaseReady ? 3 : 0)
                    + (otpBaseReady && otpExpiryWaitMs !== null ? 2 : 0)
                    + (otpBaseReady && otpWrongAttempts !== null ? 2 + otpWrongAttempts : 0)
                    + (otpDestinationReady ? 1 : 0)
                    + (samlReady ? 2 : 0));
                const form = new URLSearchParams({ username, password }).toString();
                const signIn = await repeater().send({
                    targetUrl: signInTarget,
                    requestBytes: rawRequest('POST', signInTarget, [['Content-Type', 'application/x-www-form-urlencoded']], form),
                });
                const cookies: LoginSessionCookie[] = signIn.headers
                    .filter(([name]) => name.toLocaleLowerCase() === 'set-cookie')
                    .flatMap(([, value]) => {
                    const pair = /^([^=;\s]+)=([^;]*)/u.exec(value);
                    if (pair === null || pair[1] === undefined || pair[2] === undefined || pair[2] === '')
                        return [];
                    const path = /;\s*Path=([^;]+)/iu.exec(value)?.[1] ?? '/';
                    return [{ name: pair[1], value: pair[2], domain: new URL(signInTarget).hostname, path }];
                });
                // MFA entry points commonly issue a pending-session cookie with a 302.
                // Treat a non-error redirect as a valid control only when that cookie exists.
                const signInAccepted = signIn.status >= 200 && signIn.status < 400 && cookies.length > 0;
                probes.push({ kind: 'http', pattern: 'mfa-primary-control', targetUrl: signInTarget, status: signIn.status, finalUrl: signIn.redirectLocations.at(-1) ?? signInTarget, bodyHash: hashStable('scopepilot2.theme', { body: signIn.body.toString('utf8') }), outcome: signInAccepted ? null : 'inconclusive', detail: `sessionIssued=${String(cookies.length > 0)}` });
                let outcome: AuthBypassProbeOutcome = 'inconclusive';
                let protectedStatus: number | null = null;
                let protectedHash = '';
                if (signInAccepted) {
                    const protectedResponse = await repeater().send({ targetUrl: protectedTarget, requestBytes: rawRequest('GET', protectedTarget, [], ''), sessionCookies: cookies });
                    protectedStatus = protectedResponse.status;
                    protectedHash = hashStable('scopepilot2.theme', { body: protectedResponse.body.toString('utf8') });
                    outcome = protectedResponse.status >= 200 && protectedResponse.status < 300
                        ? 'exposed'
                        : protectedResponse.status === 401 || protectedResponse.status === 403
                            ? 'denied'
                            : 'inconclusive';
                }
                probes.push({ kind: 'http', pattern: 'mfa-stage-skip', targetUrl: protectedTarget, status: protectedStatus, finalUrl: protectedTarget, bodyHash: protectedHash, outcome });
                // ---- OTP sub-check。OTP値はこの呼び出しの間だけ保持し、probe結果・証跡へ出さない。 ----
                const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
                const sendOtpJson = async (targetUrl: string, body: string, marker: string, useCookies: readonly LoginSessionCookie[]): Promise<{
                    status: number;
                    bodyHash: string;
                    finalUrl: string;
                    outcome: OtpSubmissionOutcome;
                }> => {
                    const response = await repeater().send({ targetUrl, requestBytes: rawRequest('POST', targetUrl, [['Content-Type', 'application/json']], body), ...(useCookies.length === 0 ? {} : { sessionCookies: useCookies }) });
                    const text = response.body.toString('utf8');
                    return {
                        status: response.status,
                        bodyHash: hashStable('scopepilot2.theme', { body: text }),
                        finalUrl: response.redirectLocations.at(-1) ?? targetUrl,
                        outcome: judgeOtpSubmission({ status: response.status, markerFound: text.includes(marker) }),
                    };
                };
                const issueOtp = async (label: string): Promise<string | null> => {
                    const issuedAfter = this.deps.clock.now().toISOString();
                    const issue = await repeater().send({ targetUrl: otpIssueUrl, requestBytes: rawRequest('POST', otpIssueUrl, [['Content-Type', 'application/json']], '{}'), sessionCookies: cookies });
                    probes.push({ kind: 'http', pattern: `otp-issue:${label}`, targetUrl: otpIssueUrl, status: issue.status, finalUrl: issue.redirectLocations.at(-1) ?? otpIssueUrl, bodyHash: hashStable('scopepilot2.theme', { body: issue.body.toString('utf8') }), outcome: null });
                    const received = await otpInbox!.waitForOtp({ mailboxRef: otpMailboxRef, issuedAfter, timeoutMs: OTP_INBOX_TIMEOUT_MS });
                    return received === null ? null : received.otp;
                };
                if (otpBaseReady) {
                    // 正常対照: 新規OTPを期限内に1回だけ提出して受理を確認する (以後の sub-check の前提)。
                    const controlOtp = await issueOtp('control');
                    let control: OtpSubmissionOutcome = 'unknown';
                    if (controlOtp === null) {
                        probes.push({ kind: 'http', pattern: 'otp-reuse:control', targetUrl: otpVerifyUrl, status: null, finalUrl: '', bodyHash: '', outcome: 'inconclusive', detail: 'otp was not received from the authorized fixture inbox' });
                    }
                    else {
                        const controlRun = await sendOtpJson(otpVerifyUrl, JSON.stringify({ [otpVerifyField]: controlOtp }), otpSuccessMarker, cookies);
                        control = controlRun.outcome;
                        probes.push({ kind: 'http', pattern: 'otp-reuse:control', targetUrl: otpVerifyUrl, status: controlRun.status, finalUrl: controlRun.finalUrl, bodyHash: controlRun.bodyHash, outcome: control === 'accepted' ? null : 'inconclusive' });
                        // 再利用: 同一の使用済みOTPを同一sessionで再送する。
                        const reuseRun = await sendOtpJson(otpVerifyUrl, JSON.stringify({ [otpVerifyField]: controlOtp }), otpSuccessMarker, cookies);
                        probes.push({ kind: 'http', pattern: 'otp-reuse:resubmit', targetUrl: otpVerifyUrl, status: reuseRun.status, finalUrl: reuseRun.finalUrl, bodyHash: reuseRun.bodyHash, outcome: judgeOtpBoundary({ control, action: reuseRun.outcome }) });
                    }
                    if (otpExpiryWaitMs !== null) {
                        // 寿命: 未使用の新規OTPを期限経過後に1回だけ提出する (実待機は上限内のみ)。
                        const expiryOtp = await issueOtp('expiry');
                        if (expiryOtp === null) {
                            probes.push({ kind: 'http', pattern: 'otp-expiry:expired-submit', targetUrl: otpVerifyUrl, status: null, finalUrl: '', bodyHash: '', outcome: 'inconclusive', detail: 'otp was not received from the authorized fixture inbox' });
                        }
                        else {
                            await sleep(otpExpiryWaitMs);
                            const expiredRun = await sendOtpJson(otpVerifyUrl, JSON.stringify({ [otpVerifyField]: expiryOtp }), otpSuccessMarker, cookies);
                            probes.push({ kind: 'http', pattern: 'otp-expiry:expired-submit', targetUrl: otpVerifyUrl, status: expiredRun.status, finalUrl: expiredRun.finalUrl, bodyHash: expiredRun.bodyHash, outcome: judgeOtpBoundary({ control, action: expiredRun.outcome }) });
                        }
                    }
                    else {
                        skipped.push('otp-expiry skipped: otpExpirySeconds (fixture-declared validity; wait capped at 120s) was not provided');
                    }
                    if (otpWrongAttempts !== null) {
                        // 試行制限: 事前合意した少数の誤OTPの後、正規OTPが受理されるかだけを観察する。
                        const attemptOtp = await issueOtp('attempt-limit');
                        if (attemptOtp === null) {
                            probes.push({ kind: 'http', pattern: 'otp-attempt-limit:correct-after-wrong', targetUrl: otpVerifyUrl, status: null, finalUrl: '', bodyHash: '', outcome: 'inconclusive', detail: 'otp was not received from the authorized fixture inbox' });
                        }
                        else {
                            for (let index = 1; index <= otpWrongAttempts; index += 1) {
                                const otpWidth = /^\d{4,10}$/u.test(attemptOtp) ? attemptOtp.length : 6;
                                const candidate = String(index).padStart(otpWidth, '0').slice(-otpWidth);
                                const wrongOtp = candidate === attemptOtp ? '9'.repeat(otpWidth) : candidate;
                                const wrongRun = await sendOtpJson(otpVerifyUrl, JSON.stringify({ [otpVerifyField]: wrongOtp }), otpSuccessMarker, cookies);
                                probes.push({ kind: 'http', pattern: `otp-attempt-limit:wrong-${index}`, targetUrl: otpVerifyUrl, status: wrongRun.status, finalUrl: wrongRun.finalUrl, bodyHash: wrongRun.bodyHash, outcome: null });
                            }
                            const correctRun = await sendOtpJson(otpVerifyUrl, JSON.stringify({ [otpVerifyField]: attemptOtp }), otpSuccessMarker, cookies);
                            probes.push({ kind: 'http', pattern: 'otp-attempt-limit:correct-after-wrong', targetUrl: otpVerifyUrl, status: correctRun.status, finalUrl: correctRun.finalUrl, bodyHash: correctRun.bodyHash, outcome: judgeOtpBoundary({ control, action: correctRun.outcome }) });
                        }
                    }
                    else {
                        skipped.push('otp-attempt-limit skipped: otpWrongAttempts (agreed 1..5) was not provided');
                    }
                }
                else {
                    skipped.push(`otp-reuse/otp-expiry/otp-attempt-limit skipped: requires otpIssueUrl, otpVerifyUrl, otpSuccessMarker and otpMailboxRef${otpInbox === undefined ? ' plus a configured OTP inbox fixture adapter' : ''}`);
                }
                if (otpDestinationReady) {
                    // 宛先変更: 認証済みsessionで再認証なしの宛先変更が受理されるか。変更通知の送信だけでは安全とみなさない。
                    const destinationCookies = applicableSessionCookies([...this.vault.roleSessionCookies.get(input.role!)!.cookies], otpDestinationChangeUrl) ?? [];
                    const changeRun = await sendOtpJson(otpDestinationChangeUrl, params.otpDestinationChangeBodyJson ?? '{}', otpDestinationChangeMarker, destinationCookies);
                    probes.push({ kind: 'http', pattern: 'otp-destination-change:without-reauth', targetUrl: otpDestinationChangeUrl, status: changeRun.status, finalUrl: changeRun.finalUrl, bodyHash: changeRun.bodyHash, outcome: changeRun.outcome === 'accepted' ? 'exposed' : changeRun.outcome === 'rejected' ? 'denied' : 'inconclusive', detail: 'reauth=not-performed (the supplied change body must not contain re-authentication)' });
                }
                else {
                    skipped.push('otp-destination-change skipped: requires otpDestinationChangeUrl, otpDestinationChangeMarker and an authenticated role session');
                }
                if (samlReady) {
                    // SAML assertion replay: 試験 IdP が正規発行した同一 assertion を、session reset 後に
                    // 同一条件で再送する (生成・改ざんはしない)。assertion 本文は hash だけ記録する。
                    const replay = await samlFixture!.issueAndReplay({ idpStartUrl: samlIdpStartUrl, acsUrl: samlAcsUrl, role: input.role ?? 'diag-user' });
                    probes.push({
                        kind: 'http',
                        pattern: 'saml-assertion-replay',
                        targetUrl: samlAcsUrl,
                        status: replay.replayStatus,
                        finalUrl: samlAcsUrl,
                        bodyHash: replay.assertionHash,
                        outcome: judgeSamlAssertionReplay({ controlAccepted: replay.controlAccepted, replayAccepted: replay.replayAccepted }),
                        detail: `controlStatus=${replay.controlStatus === null ? '(none)' : String(replay.controlStatus)}; replayNewSession=${replay.replayAccepted === null ? 'unknown' : String(replay.replayAccepted)}`,
                    });
                }
                else {
                    skipped.push('SAML assertion replay skipped: requires samlIdpStartUrl, samlAcsUrl and a configured isolated test IdP/SP fixture adapter');
                }
                break;
            }
            case '7': {
                // ユーザ列挙: 正常系を確認した上で、既存/不在の誤資格応答を複数回比較する。
                const role = input.role ?? '';
                const flow = requireFlow(role);
                const nonexistentUsername = params.nonexistentUsername ?? '';
                if (nonexistentUsername.trim() === '') {
                    throw domainError('ValidationFailed', 'theme 7 requires nonexistentUsername (an account that must not exist)');
                }
                const usernameRef = params.usernameReference ?? 'username';
                const passwordRef = params.passwordReference ?? 'password';
                if (secrets[usernameRef] === undefined || secrets[passwordRef] === undefined) {
                    throw domainError('NeedsInput', `theme 7 requires secret values for '${usernameRef}' and '${passwordRef}'`);
                }
                if (secrets[usernameRef] === nonexistentUsername) {
                    throw domainError('ValidationFailed', 'nonexistentUsername must differ from the existing username');
                }
                const baseUrl = params.baseUrl ?? new URL(targets[0] ?? 'http://fixture.invalid/').origin;
                const sampleCount = Number.parseInt(params.sampleCount ?? '3', 10);
                if (!Number.isInteger(sampleCount) || sampleCount < 2 || sampleCount > 5) {
                    throw domainError('ValidationFailed', 'theme 7 sampleCount must be 2..5');
                }
                const timingThresholdMs = Number.parseInt(params.timingThresholdMs ?? '250', 10);
                if (!Number.isInteger(timingThresholdMs) || timingThresholdMs < 50 || timingThresholdMs > 5000) {
                    throw domainError('ValidationFailed', 'theme 7 timingThresholdMs must be 50..5000');
                }
                requestBudget(sampleCount * 2 + 1);
                const control = await runFlow('existing-user-correct-password', baseUrl, flow.steps, secrets);
                probes.push({ kind: 'flow', pattern: 'existing-user-correct-password', targetUrl: baseUrl, status: control.status, finalUrl: control.finalUrl, bodyHash: control.bodyHash, outcome: control.assertionsPassed ? null : 'inconclusive', detail: `elapsedMs=${control.elapsedMs.toFixed(1)}` });
                const wrongPassword = `${secrets[passwordRef]!}A`;
                const existingRuns = [];
                const nonexistentRuns = [];
                for (let index = 0; index < sampleCount; index += 1) {
                    const existingRun = await runFlow(`existing-user-wrong-password:${index + 1}`, baseUrl, flow.steps, { ...secrets, [passwordRef]: wrongPassword });
                    existingRuns.push(existingRun);
                    probes.push({ kind: 'flow', pattern: `existing-user-wrong-password:${index + 1}`, targetUrl: baseUrl, status: existingRun.status, finalUrl: existingRun.finalUrl, bodyHash: existingRun.bodyHash, outcome: null, detail: `elapsedMs=${existingRun.elapsedMs.toFixed(1)}` });
                    const nonexistentRun = await runFlow(`nonexistent-user-wrong-password:${index + 1}`, baseUrl, flow.steps, { ...secrets, [usernameRef]: nonexistentUsername, [passwordRef]: wrongPassword });
                    nonexistentRuns.push(nonexistentRun);
                    probes.push({ kind: 'flow', pattern: `nonexistent-user-wrong-password:${index + 1}`, targetUrl: baseUrl, status: nonexistentRun.status, finalUrl: nonexistentRun.finalUrl, bodyHash: nonexistentRun.bodyHash, outcome: null, detail: `elapsedMs=${nonexistentRun.elapsedMs.toFixed(1)}` });
                }
                const existingRun = existingRuns[0]!;
                const nonexistentRun = nonexistentRuns[0]!;
                const average = (runs: readonly {
                    elapsedMs: number;
                }[]): number => runs.reduce((sum, run) => sum + run.elapsedMs, 0) / runs.length;
                const enumeration = judgeUserEnumeration({ status: existingRun.status, finalUrl: existingRun.finalUrl, bodyHash: existingRun.comparisonHash, averageElapsedMs: average(existingRuns) }, { status: nonexistentRun.status, finalUrl: nonexistentRun.finalUrl, bodyHash: nonexistentRun.comparisonHash, averageElapsedMs: average(nonexistentRuns) }, timingThresholdMs);
                probes.push({ kind: 'browser', pattern: 'response-comparison', targetUrl: baseUrl, status: null, finalUrl: '', bodyHash: '', outcome: control.assertionsPassed ? enumeration : 'inconclusive', detail: `samples=${sampleCount}; existingAvgMs=${average(existingRuns).toFixed(1)}; nonexistentAvgMs=${average(nonexistentRuns).toFixed(1)}` });
                break;
            }
            case '9': {
                // JWT署名検証の最低限確認。正規tokenを対照にalg=none変種を再送する。
                const target = targets[0];
                if (target === undefined)
                    throw domainError('ValidationFailed', 'theme 9 requires a JWT-protected target URL');
                // Renderer sends bearer credentials through secretValues. Keep params as a
                // compatibility fallback for older API clients.
                const token = secrets.validToken ?? params.validToken ?? '';
                if (token.trim() === '')
                    throw domainError('NeedsInput', 'theme 9 requires validToken captured from the authorized test account');
                const parts = token.split('.');
                if (parts.length !== 3)
                    throw domainError('ValidationFailed', 'theme 9 validToken is not a compact JWT');
                let header: Record<string, unknown>;
                let claims: Record<string, unknown>;
                try {
                    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
                    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
                }
                catch {
                    throw domainError('ValidationFailed', 'theme 9 JWT header or claims are not valid JSON');
                }
                requestBudget(2);
                const unsignedHeader = Buffer.from(JSON.stringify({ ...header, alg: 'none' }), 'utf8').toString('base64url');
                const unsigned = `${unsignedHeader}.${parts[1]!}.`;
                const send = async (value: string) => repeater().send({ targetUrl: target, requestBytes: rawRequest('GET', target, [['Authorization', `Bearer ${value}`]], '') });
                const baseline = await send(token);
                const mutated = await send(unsigned);
                const baselineAccepted = baseline.status >= 200 && baseline.status < 300;
                const unsignedAccepted = mutated.status >= 200 && mutated.status < 300;
                probes.push({ kind: 'http', pattern: 'jwt-valid-control', targetUrl: target, status: baseline.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: baseline.body.toString('utf8') }), outcome: baselineAccepted ? null : 'inconclusive' });
                probes.push({ kind: 'http', pattern: 'jwt-alg-none', targetUrl: target, status: mutated.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: mutated.body.toString('utf8') }), outcome: !baselineAccepted ? 'inconclusive' : unsignedAccepted ? 'exposed' : 'denied' });
                const nowSeconds = Math.floor(this.deps.clock.now().getTime() / 1000);
                const exp = typeof claims.exp === 'number' ? claims.exp : null;
                probes.push({ kind: 'http', pattern: 'jwt-exp-claim', targetUrl: target, status: null, finalUrl: target, bodyHash: '', outcome: exp === null || exp > nowSeconds + 86400 ? 'exposed' : 'denied', detail: `exp=${exp === null ? '(missing)' : String(exp)}` });
                skipped = ['OAuth/OIDC redirect, state, nonce, PKCE and issuer discovery require a registered authorization flow'];
                break;
            }
            case '10': {
                // IDOR: 候補ロールと、そのオブジェクトを正当に参照できる比較ロールの2セッションで比較。
                const candidateSession = requireSession();
                const otherRole = params.otherRole ?? '';
                if (otherRole === '' || otherRole === candidateSession.role)
                    throw domainError('ValidationFailed', 'theme 10 requires a different otherRole with an authenticated session');
                const authorizedSession = this.vault.roleSessionCookies.get(otherRole);
                if (authorizedSession === undefined)
                    throw domainError('ValidationFailed', `no authenticated session for comparison role '${otherRole}'; run login first`);
                const template = targets[0];
                if (template === undefined)
                    throw domainError('ValidationFailed', 'theme 10 requires a target URL with the object parameter');
                const objectParam = params.objectParam ?? '';
                const ownValue = params.ownValue ?? '';
                const otherValues = (params.otherValues ?? '').split(',').map((value) => value.trim()).filter((value) => value !== '');
                const planned = planIdorProbes({ targetUrl: template, objectParam, ownValue, otherValues });
                requestBudget(planned.length);
                const runPage = async (url: string, browserSession: BrowserSessionState) => {
                    const canonical = ScopePolicy.canonicalUrl(url);
                    return await browser().execute({
                        targetUrl: canonical,
                        scope: caseRecord.scope,
                        steps: [{ kind: 'navigate', target: canonical }],
                        browserSession,
                    });
                };
                const own = await runPage(planned[0]!.url, candidateSession.browserState);
                probes.push({ kind: 'browser', pattern: 'own-object-baseline', targetUrl: ScopePolicy.canonicalUrl(planned[0]!.url), status: own.status, finalUrl: own.finalUrl, bodyHash: own.bodyHash, outcome: own.status !== null && own.status < 400 ? null : 'inconclusive' });
                for (let index = 1; index < planned.length; index += 2) {
                    const authorizedPlan = planned[index]!;
                    const candidatePlan = planned[index + 1]!;
                    const authorized = await runPage(authorizedPlan.url, authorizedSession.browserState);
                    probes.push({ kind: 'browser', pattern: authorizedPlan.pattern, targetUrl: ScopePolicy.canonicalUrl(authorizedPlan.url), status: authorized.status, finalUrl: authorized.finalUrl, bodyHash: authorized.bodyHash, outcome: null });
                    const candidate = await runPage(candidatePlan.url, candidateSession.browserState);
                    const outcome = judgeIdorAccess({
                        authorized: { status: authorized.status, finalUrl: authorized.finalUrl, bodyHash: authorized.bodyHash },
                        candidate: { status: candidate.status, finalUrl: candidate.finalUrl, bodyHash: candidate.bodyHash },
                    });
                    probes.push({ kind: 'browser', pattern: candidatePlan.pattern, targetUrl: ScopePolicy.canonicalUrl(candidatePlan.url), status: candidate.status, finalUrl: candidate.finalUrl, bodyHash: candidate.bodyHash, outcome });
                }
                break;
            }
            case '11': {
                // マスアサインメント: base JSON に特権 field を merge した要求が受理されるか。
                const target = targets[0];
                if (target === undefined)
                    throw domainError('ValidationFailed', 'theme 11 requires a target URL');
                const method = params.method ?? 'POST';
                const baseBody = params.jsonBody ?? '';
                if (baseBody.trim() === '')
                    throw domainError('ValidationFailed', 'theme 11 requires jsonBody (the normal request body)');
                const extraFields = parseExtraFieldsJson(params.extraFieldsJson ?? '{}');
                const variantBody = mergeJsonFields(baseBody, extraFields);
                const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
                requestBudget(2);
                const headers: readonly (readonly [
                    string,
                    string
                ])[] = [['Content-Type', 'application/json']];
                const baseline = await repeater().send({ targetUrl: target, requestBytes: rawRequest(method, target, headers, baseBody), ...(sessionCookies === undefined ? {} : { sessionCookies }) });
                probes.push({ kind: 'http', pattern: 'baseline', targetUrl: target, status: baseline.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: baseline.body.toString('utf8') }), outcome: null });
                const variant = await repeater().send({ targetUrl: target, requestBytes: rawRequest(method, target, headers, variantBody), ...(sessionCookies === undefined ? {} : { sessionCookies }) });
                const variantText = variant.body.toString('utf8');
                const successMarker = params.successMarker;
                const markerFound = successMarker === undefined ? null : variantText.includes(successMarker);
                probes.push({ kind: 'http', pattern: 'mass-assignment', targetUrl: target, status: variant.status, finalUrl: variant.redirectLocations.at(-1) ?? target, bodyHash: hashStable('scopepilot2.theme', { body: variantText }), outcome: judgeMassAssignment({ variantStatus: variant.status, ...(successMarker === undefined ? {} : { successMarker, markerFound }) }), ...(markerFound === null ? {} : { markersFound: markerFound }) });
                skipped = successMarker === undefined && variant.status < 400 ? ['field reflection / persisted side-effect was not confirmed; HTTP success alone is not evidence'] : [];
                break;
            }
            case '13': {
                // CORS: Origin 書き換え再送と プリフライト確認。
                const target = targets[0];
                if (target === undefined)
                    throw domainError('ValidationFailed', 'theme 13 requires a target URL');
                const origins = (params.evilOrigins ?? 'https://scopepilot.invalid').split(',').map((origin) => origin.trim()).filter((origin) => origin !== '');
                if (origins.length === 0 || origins.length > 3)
                    throw domainError('ValidationFailed', 'theme 13 accepts 1..3 evil origins');
                const requestMethod = (params.requestMethod ?? 'GET').toUpperCase();
                const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
                const testOrigins = [...new Set([new URL(target).origin, ...origins, 'null'])];
                requestBudget(testOrigins.length * 2);
                for (const origin of testOrigins) {
                    const getResponse = await repeater().send({ targetUrl: target, requestBytes: rawRequest(requestMethod, target, [['Origin', origin]], ''), ...(sessionCookies === undefined ? {} : { sessionCookies }) });
                    const outcome = origin === new URL(target).origin ? null : judgeCorsResponse({ requestOrigin: origin, acao: headerValue(getResponse.headers, 'Access-Control-Allow-Origin'), acac: headerValue(getResponse.headers, 'Access-Control-Allow-Credentials'), credentialsSent: (sessionCookies?.length ?? 0) > 0 });
                    probes.push({ kind: 'http', pattern: `origin-reflect:${origin}`, targetUrl: target, status: getResponse.status, finalUrl: getResponse.redirectLocations.at(-1) ?? target, bodyHash: hashStable('scopepilot2.theme', { body: getResponse.body.toString('utf8') }), outcome, ...(headerValue(getResponse.headers, 'Access-Control-Allow-Origin') === null ? {} : { detail: `acao=${headerValue(getResponse.headers, 'Access-Control-Allow-Origin') ?? ''}` }) });
                    const optionsResponse = await repeater().send({ targetUrl: target, requestBytes: rawRequest('OPTIONS', target, [['Origin', origin], ['Access-Control-Request-Method', requestMethod]], '') });
                    const preflight = origin === new URL(target).origin ? null : judgeCorsPreflight({ requestOrigin: origin, requestMethod, acao: headerValue(optionsResponse.headers, 'Access-Control-Allow-Origin'), acaom: headerValue(optionsResponse.headers, 'Access-Control-Allow-Methods') });
                    probes.push({ kind: 'http', pattern: `preflight:${origin}`, targetUrl: target, status: optionsResponse.status, finalUrl: target, bodyHash: '', outcome: preflight, ...(headerValue(optionsResponse.headers, 'Access-Control-Allow-Methods') === null ? {} : { detail: `acaom=${headerValue(optionsResponse.headers, 'Access-Control-Allow-Methods') ?? ''}` }) });
                }
                break;
            }
            case '14': {
                // mail subject等へCRLFを入れ、正規値を対照に拒否されるか確認する。外部メールは送らない。
                const target = targets[0];
                if (target === undefined)
                    throw domainError('ValidationFailed', 'theme 14 requires a mail submission target URL');
                const fieldName = params.fieldName ?? 'subject';
                if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(fieldName))
                    throw domainError('ValidationFailed', 'theme 14 fieldName is invalid');
                const baselineValue = params.baselineValue ?? 'ScopePilot local notice';
                const injectedValue = params.injectedValue ?? `${baselineValue}\r\nBcc: scopepilot-invalid@example.invalid`;
                const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
                requestBudget(2);
                const send = async (value: string) => repeater().send({
                    targetUrl: target,
                    requestBytes: rawRequest('POST', target, [['Content-Type', 'application/json']], JSON.stringify({ [fieldName]: value })),
                    ...(sessionCookies === undefined ? {} : { sessionCookies }),
                });
                const baseline = await send(baselineValue);
                const injected = await send(injectedValue);
                const baselineAccepted = baseline.status >= 200 && baseline.status < 300;
                const injectionAccepted = injected.status >= 200 && injected.status < 300;
                probes.push({ kind: 'http', pattern: 'mail-header-baseline', targetUrl: target, status: baseline.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: baseline.body.toString('utf8') }), outcome: baselineAccepted ? null : 'inconclusive' });
                probes.push({ kind: 'http', pattern: 'mail-header-crlf', targetUrl: target, status: injected.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: injected.body.toString('utf8') }), outcome: !baselineAccepted ? 'inconclusive' : injectionAccepted ? 'exposed' : 'denied' });
                skipped = ['no external mail is sent; delivery-header proof requires a local inbox/oracle supplied by the target fixture'];
                break;
            }
            case '15': {
                // LDAP/CSV/ReDoS/Host 等の対象固有注入を、正常要求と利用者レビュー済み変異要求の差分で確認する。
                // 任意文字列をこちらで「成功」と推測せず、成立 marker または時間差を明示入力として要求する。
                const target = targets[0];
                if (target === undefined)
                    throw domainError('ValidationFailed', 'theme 15 requires an injection target URL');
                const baselineJson = params.baselineJson ?? '';
                const variantJson = params.variantJson ?? '';
                if (baselineJson.trim() === '' || variantJson.trim() === '') {
                    throw domainError('NeedsInput', 'theme 15 requires baselineJson and a reviewed variantJson');
                }
                const parseBody = (name: string, value: string): string => {
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(value) as unknown;
                    }
                    catch {
                        throw domainError('ValidationFailed', `theme 15 ${name} must be valid JSON`);
                    }
                    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                        throw domainError('ValidationFailed', `theme 15 ${name} must be a JSON object`);
                    }
                    if (Buffer.byteLength(value, 'utf8') > 65536)
                        throw domainError('ValidationFailed', `theme 15 ${name} exceeds 65536 bytes`);
                    return JSON.stringify(parsed);
                };
                const baselineBody = parseBody('baselineJson', baselineJson);
                const variantBody = parseBody('variantJson', variantJson);
                const method = (params.method ?? 'POST').toUpperCase();
                if (!['POST', 'PUT', 'PATCH'].includes(method))
                    throw domainError('ValidationFailed', 'theme 15 method must be POST, PUT, or PATCH');
                const pattern = (params.pattern ?? 'reviewed-injection').trim();
                if (!/^[a-z0-9][a-z0-9_.:-]{0,63}$/iu.test(pattern))
                    throw domainError('ValidationFailed', 'theme 15 pattern is invalid');
                const successMarker = params.successMarker;
                const elapsedThresholdMs = params.elapsedThresholdMs === undefined ? null : Number.parseInt(params.elapsedThresholdMs, 10);
                if (successMarker === undefined && elapsedThresholdMs === null) {
                    throw domainError('NeedsInput', 'theme 15 requires successMarker or elapsedThresholdMs so HTTP success is not misreported as injection');
                }
                if (elapsedThresholdMs !== null && (!Number.isInteger(elapsedThresholdMs) || elapsedThresholdMs < 100 || elapsedThresholdMs > 10000)) {
                    throw domainError('ValidationFailed', 'theme 15 elapsedThresholdMs must be 100..10000');
                }
                const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
                requestBudget(2);
                const send = async (body: string): Promise<{
                    response: Awaited<ReturnType<ReturnType<typeof repeater>['send']>>;
                    elapsedMs: number;
                }> => {
                    const startedAt = performance.now();
                    const response = await repeater().send({
                        targetUrl: target,
                        requestBytes: rawRequest(method, target, [['Content-Type', 'application/json']], body),
                        ...(sessionCookies === undefined ? {} : { sessionCookies }),
                    });
                    return { response, elapsedMs: Math.max(0, performance.now() - startedAt) };
                };
                const baseline = await send(baselineBody);
                const variant = await send(variantBody);
                const baselineText = baseline.response.body.toString('utf8');
                const variantText = variant.response.body.toString('utf8');
                const baselineAccepted = baseline.response.status >= 200 && baseline.response.status < 300;
                const markerFound = successMarker === undefined ? null : variantText.includes(successMarker);
                const timingExposed = elapsedThresholdMs !== null
                    && variant.elapsedMs >= elapsedThresholdMs
                    && variant.elapsedMs >= Math.max(baseline.elapsedMs * 3, baseline.elapsedMs + 75);
                const rejected = variant.response.status === 400 || variant.response.status === 401 || variant.response.status === 403 || variant.response.status === 422;
                const outcome: AuthBypassProbeOutcome = !baselineAccepted
                    ? 'inconclusive'
                    : markerFound === true || timingExposed
                        ? 'exposed'
                        : rejected || markerFound === false || elapsedThresholdMs !== null
                            ? 'denied'
                            : 'inconclusive';
                probes.push({ kind: 'http', pattern: 'injection-baseline', targetUrl: target, status: baseline.response.status, finalUrl: baseline.response.redirectLocations.at(-1) ?? target, bodyHash: hashStable('scopepilot2.theme', { body: baselineText }), outcome: baselineAccepted ? null : 'inconclusive', detail: `elapsedMs=${String(Math.round(baseline.elapsedMs))}` });
                probes.push({ kind: 'http', pattern: `injection:${pattern}`, targetUrl: target, status: variant.response.status, finalUrl: variant.response.redirectLocations.at(-1) ?? target, bodyHash: hashStable('scopepilot2.theme', { body: variantText }), outcome, ...(markerFound === null ? {} : { markersFound: markerFound }), detail: `elapsedMs=${String(Math.round(variant.elapsedMs))}; marker=${markerFound === null ? 'unused' : String(markerFound)}` });
                skipped = ['only the supplied, reviewed injection variant was exercised; other interpreters in theme 15 remain separate checks'];
                break;
            }
            case '16': {
                // SSRF: 正常な公開URLを対照に、許可済みfixture/OAST URLへのサーバ側到達を marker で確認する。
                const target = targets[0];
                if (target === undefined)
                    throw domainError('ValidationFailed', 'theme 16 requires an SSRF input endpoint URL');
                const baselineJson = params.baselineJson ?? '';
                const fieldName = (params.fieldName ?? 'url').trim();
                const probeUrl = params.probeUrl ?? '';
                const successMarker = params.successMarker;
                if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(fieldName))
                    throw domainError('ValidationFailed', 'theme 16 fieldName is invalid');
                if (baselineJson.trim() === '' || probeUrl.trim() === '')
                    throw domainError('NeedsInput', 'theme 16 requires baselineJson and probeUrl');
                let baselineObject: unknown;
                try {
                    baselineObject = JSON.parse(baselineJson) as unknown;
                }
                catch {
                    throw domainError('ValidationFailed', 'theme 16 baselineJson must be valid JSON');
                }
                if (typeof baselineObject !== 'object' || baselineObject === null || Array.isArray(baselineObject)) {
                    throw domainError('ValidationFailed', 'theme 16 baselineJson must be a JSON object');
                }
                if (Buffer.byteLength(baselineJson, 'utf8') > 65536)
                    throw domainError('ValidationFailed', 'theme 16 baselineJson exceeds 65536 bytes');
                let parsedProbe: URL;
                try {
                    parsedProbe = new URL(probeUrl);
                }
                catch {
                    throw domainError('ValidationFailed', 'theme 16 probeUrl must be an absolute URL');
                }
                if (!['http:', 'https:'].includes(parsedProbe.protocol))
                    throw domainError('ValidationFailed', 'theme 16 probeUrl must use http or https');
                const variantBody = JSON.stringify({ ...(baselineObject as Readonly<Record<string, unknown>>), [fieldName]: probeUrl });
                const baselineBody = JSON.stringify(baselineObject);
                const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
                requestBudget(2);
                const send = async (body: string) => repeater().send({
                    targetUrl: target,
                    requestBytes: rawRequest('POST', target, [['Content-Type', 'application/json']], body),
                    ...(sessionCookies === undefined ? {} : { sessionCookies }),
                });
                const baseline = await send(baselineBody);
                const variant = await send(variantBody);
                const baselineText = baseline.body.toString('utf8');
                const variantText = variant.body.toString('utf8');
                const baselineAccepted = baseline.status >= 200 && baseline.status < 300;
                const markerFound = successMarker === undefined ? null : variantText.includes(successMarker);
                const rejected = variant.status === 400 || variant.status === 401 || variant.status === 403 || variant.status === 422;
                const outcome: AuthBypassProbeOutcome = !baselineAccepted
                    ? 'inconclusive'
                    : markerFound === true
                        ? 'exposed'
                        : rejected || markerFound === false
                            ? 'denied'
                            : 'inconclusive';
                probes.push({ kind: 'http', pattern: 'ssrf-public-control', targetUrl: target, status: baseline.status, finalUrl: baseline.redirectLocations.at(-1) ?? target, bodyHash: hashStable('scopepilot2.theme', { body: baselineText }), outcome: baselineAccepted ? null : 'inconclusive' });
                probes.push({ kind: 'http', pattern: 'ssrf-reviewed-probe', targetUrl: target, status: variant.status, finalUrl: variant.redirectLocations.at(-1) ?? target, bodyHash: hashStable('scopepilot2.theme', { body: variantText }), outcome, ...(markerFound === null ? {} : { markersFound: markerFound }), detail: `probeProtocol=${parsedProbe.protocol}; marker=${markerFound === null ? 'unused' : String(markerFound)}` });
                skipped = successMarker === undefined
                    ? ['HTTP acceptance alone is not SSRF evidence; configure successMarker or use the OAST attempt/callback flow']
                    : ['the supplied probe URL was checked; alternate encodings, redirects, DNS rebinding and other address families require separate reviewed probes'];
                break;
            }
            case '18': {
                // Excel は「リクエスト中の直列化パターン」を観察する手順。応答本文の存在を
                // 脆弱性として扱わず、履歴から採取した要求サンプルを一時的に分類する。
                const requestSamples = params.requestSamples ?? '';
                if (requestSamples.trim() === '')
                    throw domainError('NeedsInput', 'theme 18 requires requestSamples copied from captured request history');
                const signature = findSerializationSignature(requestSamples);
                probes.push({ kind: 'http', pattern: 'serialized-request-observation', targetUrl: targets[0] ?? '', status: null, finalUrl: '', bodyHash: hashStable('scopepilot2.theme18.sample', { sample: requestSamples }), outcome: signature === null ? 'denied' : 'inconclusive', ...(signature === null ? {} : { detail: `candidate-signature=${signature.name}` }) });
                skipped = ['integrity verification / acceptance was not exercised', 'exploitation with target-specific gadgets is excluded as unsafe'];
                break;
            }
            case '20': {
                // 業務ロジック・競合: 同一要求の順次再送による観察のみ (同期レースは除外)。
                const target = targets[0];
                if (target === undefined)
                    throw domainError('ValidationFailed', 'theme 20 requires a target URL');
                const method = params.method ?? 'GET';
                const body = params.body ?? '';
                const count = planReplayCount(Number.parseInt(params.repeatCount ?? '2', 10));
                const successMarker = params.successMarker;
                const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
                requestBudget(count);
                const replayResponses: {
                    status: number;
                    bodyHash: string;
                    markerFound: boolean | null;
                }[] = [];
                for (let index = 0; index < count; index += 1) {
                    const response = await repeater().send({ targetUrl: target, requestBytes: rawRequest(method, target, body === '' ? [] : [['Content-Type', 'application/json']], body), ...(sessionCookies === undefined ? {} : { sessionCookies }) });
                    const text = response.body.toString('utf8');
                    const bodyHash = hashStable('scopepilot2.theme', { body: text });
                    const markerFound = successMarker === undefined ? null : text.includes(successMarker);
                    replayResponses.push({ status: response.status, bodyHash, markerFound });
                    probes.push({ kind: 'http', pattern: `replay-${index + 1}`, targetUrl: target, status: response.status, finalUrl: response.redirectLocations.at(-1) ?? target, bodyHash, outcome: null, ...(markerFound === null ? {} : { markersFound: markerFound }) });
                }
                probes.push({ kind: 'http', pattern: 'replay-comparison', targetUrl: target, status: null, finalUrl: '', bodyHash: '', outcome: judgeReplay({ responses: replayResponses, ...(successMarker === undefined ? {} : { successMarker }) }) });
                skipped = ['millisecond-synchronized race detection (excluded as infeasible)'];
                break;
            }
            case '21': {
                // 入力検証の堃牢性: 境界値・型・長大文字列を query に適用し 5xx を見る。
                const target = targets[0];
                if (target === undefined)
                    throw domainError('ValidationFailed', 'theme 21 requires a target URL');
                const paramName = params.paramName ?? '';
                if (paramName.trim() === '')
                    throw domainError('ValidationFailed', 'theme 21 requires paramName (query parameter to fuzz)');
                const extraValues = (params.extraValues ?? '').split(',').map((value) => value.trim()).filter((value) => value !== '');
                const values = [...INPUT_ROBUSTNESS_PAYLOADS, ...extraValues].slice(0, INPUT_ROBUSTNESS_MAX_VALUES);
                requestBudget(values.length);
                if (this.deps.fuzzTransport === undefined)
                    throw domainError('CapabilityUnavailable', 'fuzz transport is not configured for this service');
                const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
                for (const value of values) {
                    const response = await this.deps.fuzzTransport.send({
                        targetUrl: target,
                        combination: [value],
                        positions: [{ name: paramName, values: [value] }],
                        ...(sessionCookies === undefined ? {} : { sessionCookies: sessionCookies.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path })) }),
                    });
                    const label = value === '' ? '(empty)' : value.length > 24 ? `${value.slice(0, 12)}…(${String(value.length)})` : value;
                    probes.push({ kind: 'fuzz', pattern: `robustness:${label}`, targetUrl: response.requestUrl, status: response.status, finalUrl: response.requestUrl, bodyHash: response.bodyHash, outcome: judgeInputRobustness(response.status) });
                }
                skipped = ['required-parameter omission, HPP, double-decoding and trusted-header variants are not covered by this query-value run'];
                break;
            }
            case '22': {
                // TLS・証明書・暗号スイート: 審査済み nuclei template のスポット実行のみ。
                if (targets.length === 0 || targets.length > 3)
                    throw domainError('ValidationFailed', 'theme 22 accepts 1..3 target origins');
                const templateIds = validateSpotTemplateIds((params.templateIds ?? '').split(','));
                if (this.deps.nucleiRunner === undefined)
                    throw domainError('CapabilityUnavailable', 'nuclei runner is not configured for this service');
                const result = await this.deps.nucleiRunner.run({
                    targets,
                    limits: {
                        maxRequests: caseRecord.scope.limits.maxRequests,
                        maxDurationMinutes: Math.max(1, Math.min(caseRecord.scope.limits.maxDurationMinutes, 10)),
                        maxConcurrency: 2,
                        requestsPerSecond: 5,
                    },
                    templateIds,
                });
                const matchCount = countNucleiMatches(result.lines);
                for (const target of targets) {
                    probes.push({ kind: 'nuclei', pattern: 'tls-spot-templates', targetUrl: target, status: null, finalUrl: '', bodyHash: '', outcome: judgeNucleiSpot(matchCount), detail: `matches=${String(matchCount)}; templates=${templateIds.join(',')}` });
                }
                skipped = ['full testssl.sh/OpenSSL-equivalent coverage (spot execution of reviewed templates only)'];
                break;
            }
            case '23': {
                // 平文送信・混在: http:// 到達性と https ページ内の http:// 参照。
                const target = targets[0];
                if (target === undefined || !target.startsWith('https://'))
                    throw domainError('ValidationFailed', 'theme 23 requires an https:// target URL');
                requestBudget(3);
                const session = input.role === undefined ? undefined : requireSession();
                const httpsResponse = await browser().execute({
                    targetUrl: ScopePolicy.canonicalUrl(target),
                    scope: caseRecord.scope,
                    steps: [{ kind: 'navigate', target: ScopePolicy.canonicalUrl(target) }],
                    ...(session === undefined ? {} : { browserSession: session.browserState }),
                });
                probes.push({ kind: 'browser', pattern: 'https-baseline', targetUrl: ScopePolicy.canonicalUrl(target), status: httpsResponse.status, finalUrl: httpsResponse.finalUrl, bodyHash: httpsResponse.bodyHash, outcome: null });
                const mixed = findMixedContent(httpsResponse.bodyText);
                probes.push({ kind: 'browser', pattern: 'mixed-content', targetUrl: ScopePolicy.canonicalUrl(target), status: httpsResponse.status, finalUrl: httpsResponse.finalUrl, bodyHash: '', outcome: mixed ? 'exposed' : 'denied' });
                const plainTarget = target.replace(/^https:\/\//, 'http://');
                if (!businessTargetInScope(plainTarget, caseRecord.scope)) {
                    throw domainError('OutOfScope', `plain http variant is out of scope: ${plainTarget}`);
                }
                const plainResponse = await repeater().send({ targetUrl: plainTarget, requestBytes: rawRequest('GET', plainTarget, [], '') });
                probes.push({ kind: 'http', pattern: 'plain-http', targetUrl: plainTarget, status: plainResponse.status, finalUrl: plainResponse.redirectLocations.at(-1) ?? plainTarget, bodyHash: hashStable('scopepilot2.theme', { body: plainResponse.body.toString('utf8') }), outcome: judgePlainHttp({ status: plainResponse.status, finalUrl: plainResponse.redirectLocations.at(-1) ?? plainTarget, targetUrl: plainTarget }) });
                break;
            }
            case '24': {
                // ZAP受動ルール外のブラウザ保護ヘッダー。欠落は対象ページの機微性が不明なら保留にする。
                if (targets.length === 0 || targets.length > 5)
                    throw domainError('ValidationFailed', 'theme 24 accepts 1..5 target URLs');
                const strict = params.sensitivePage === 'true';
                requestBudget(targets.length * 2);
                const session = input.role === undefined ? undefined : requireSession();
                for (const target of targets) {
                    const sessionCookies = session === undefined ? undefined : applicableSessionCookies([...session.cookies], target);
                    const baseline = await repeater().send({ targetUrl: target, requestBytes: rawRequest('GET', target, [], ''), ...(sessionCookies === undefined ? {} : { sessionCookies }) });
                    const missing = (): AuthBypassProbeOutcome => strict ? 'exposed' : 'inconclusive';
                    const policyChecks: readonly {
                        name: string;
                        safe: (value: string) => boolean;
                    }[] = [
                        { name: 'Referrer-Policy', safe: (value) => /^(?:no-referrer|same-origin|strict-origin|strict-origin-when-cross-origin)$/iu.test(value.trim()) },
                        { name: 'Cross-Origin-Opener-Policy', safe: (value) => value.trim().toLocaleLowerCase() === 'same-origin' },
                        { name: 'Cross-Origin-Resource-Policy', safe: (value) => /^(?:same-origin|same-site)$/iu.test(value.trim()) },
                        { name: 'Permissions-Policy', safe: (value) => value.trim() !== '' && !/=\s*\*/u.test(value) },
                    ];
                    for (const policy of policyChecks) {
                        const value = headerValue(baseline.headers, policy.name);
                        probes.push({
                            kind: 'http',
                            pattern: `header:${policy.name.toLocaleLowerCase()}`,
                            targetUrl: target,
                            status: baseline.status,
                            finalUrl: baseline.redirectLocations.at(-1) ?? target,
                            bodyHash: '',
                            outcome: value === null ? missing() : policy.safe(value) ? 'denied' : 'exposed',
                            detail: `${policy.name}=${value ?? '(missing)'}`,
                        });
                    }
                    const hostCookies = baseline.headers.filter(([name, value]) => name.toLocaleLowerCase() === 'set-cookie' && /^__Host-/u.test(value));
                    for (const [, cookie] of hostCookies) {
                        const valid = /;\s*Secure(?:;|$)/iu.test(cookie) && /;\s*Path=\/(?:;|$)/iu.test(cookie) && !/;\s*Domain=/iu.test(cookie);
                        probes.push({ kind: 'http', pattern: 'cookie:__host-prefix', targetUrl: target, status: baseline.status, finalUrl: target, bodyHash: '', outcome: valid ? 'denied' : 'exposed', detail: valid ? '__Host- attributes valid' : '__Host- attributes invalid' });
                    }
                    const crossSite = await repeater().send({
                        targetUrl: target,
                        requestBytes: rawRequest('GET', target, [['Sec-Fetch-Site', 'cross-site'], ['Sec-Fetch-Mode', 'navigate'], ['Sec-Fetch-Dest', 'document']], ''),
                        ...(sessionCookies === undefined ? {} : { sessionCookies }),
                    });
                    const crossSiteBlocked = crossSite.status === 401 || crossSite.status === 403;
                    probes.push({ kind: 'http', pattern: 'sec-fetch-cross-site', targetUrl: target, status: crossSite.status, finalUrl: crossSite.redirectLocations.at(-1) ?? target, bodyHash: '', outcome: crossSiteBlocked ? 'denied' : strict ? 'exposed' : 'inconclusive', detail: `status=${String(crossSite.status)}` });
                }
                skipped = ['__Host- prefix is assessed only when such a Set-Cookie header is observed', ...(strict ? [] : ['missing headers are inconclusive unless sensitivePage=true'])];
                break;
            }
            case '25': {
                // TRACE/TRACK と Allow を確認する。PUT/DELETE は副作用を避け、明示指定なしでは送信しない。
                const target = targets[0];
                if (target === undefined)
                    throw domainError('ValidationFailed', 'theme 25 requires a target URL');
                const requestedMethods = (params.methods ?? 'TRACE,TRACK').split(',').map((method) => method.trim().toUpperCase()).filter((method) => method !== '');
                if (requestedMethods.length === 0 || requestedMethods.length > 6)
                    throw domainError('ValidationFailed', 'theme 25 accepts 1..6 methods');
                const stateChanging = requestedMethods.filter((method) => method === 'PUT' || method === 'DELETE' || method === 'PATCH');
                if (stateChanging.length > 0 && params.allowStateChangingMethods !== 'true') {
                    throw domainError('NeedsInput', 'theme 25 requires allowStateChangingMethods=true before PUT/DELETE/PATCH probes');
                }
                const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
                requestBudget(requestedMethods.length + 1);
                const marker = 'scopepilot-method-probe';
                const optionsResponse = await repeater().send({ targetUrl: target, requestBytes: rawRequest('OPTIONS', target, [], ''), ...(sessionCookies === undefined ? {} : { sessionCookies }) });
                const allow = (headerValue(optionsResponse.headers, 'Allow') ?? '').split(',').map((method) => method.trim().toUpperCase()).filter((method) => method !== '');
                const dangerousAdvertised = allow.filter((method) => requestedMethods.includes(method));
                probes.push({ kind: 'http', pattern: 'options-allow', targetUrl: target, status: optionsResponse.status, finalUrl: target, bodyHash: '', outcome: dangerousAdvertised.length > 0 ? 'exposed' : allow.length > 0 ? 'denied' : 'inconclusive', detail: `allow=${allow.join(',') || '(missing)'}` });
                for (const method of requestedMethods) {
                    const response = await repeater().send({ targetUrl: target, requestBytes: rawRequest(method, target, [['Content-Type', 'text/plain']], marker), ...(sessionCookies === undefined ? {} : { sessionCookies }) });
                    const body = response.body.toString('utf8');
                    const rejected = response.status === 401 || response.status === 403 || response.status === 405 || response.status === 501;
                    const echoed = body.includes(marker);
                    probes.push({
                        kind: 'http',
                        pattern: `method:${method.toLocaleLowerCase()}`,
                        targetUrl: target,
                        status: response.status,
                        finalUrl: response.redirectLocations.at(-1) ?? target,
                        bodyHash: hashStable('scopepilot2.theme', { body }),
                        outcome: rejected ? 'denied' : echoed || dangerousAdvertised.includes(method) ? 'exposed' : 'inconclusive',
                        detail: `status=${String(response.status)}; echoed=${String(echoed)}`,
                    });
                }
                skipped = stateChanging.length === 0 ? ['PUT/DELETE/PATCH were not sent without explicit side-effect authorization'] : [];
                break;
            }
            case '26': {
                // GraphQL introspection と、利用者指定のschema-validな深さ/コストqueryを確認する。
                const target = targets[0];
                if (target === undefined)
                    throw domainError('ValidationFailed', 'theme 26 requires a GraphQL endpoint URL');
                const deepQuery = params.deepQuery ?? '';
                if (deepQuery.trim() === '')
                    throw domainError('NeedsInput', 'theme 26 requires a schema-valid deepQuery');
                if (deepQuery.length > 20000)
                    throw domainError('ValidationFailed', 'theme 26 deepQuery exceeds 20000 characters');
                const baselineQuery = params.baselineQuery ?? '{__typename}';
                const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
                requestBudget(3);
                const sendQuery = async (query: string) => repeater().send({
                    targetUrl: target,
                    requestBytes: rawRequest('POST', target, [['Content-Type', 'application/json']], JSON.stringify({ query })),
                    ...(sessionCookies === undefined ? {} : { sessionCookies }),
                });
                const baseline = await sendQuery(baselineQuery);
                const baselineText = baseline.body.toString('utf8');
                const baselineWorks = baseline.status >= 200 && baseline.status < 300 && /"data"\s*:/u.test(baselineText) && !/"errors"\s*:/u.test(baselineText);
                probes.push({ kind: 'http', pattern: 'graphql-baseline', targetUrl: target, status: baseline.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: baselineText }), outcome: baselineWorks ? null : 'inconclusive' });
                const introspection = await sendQuery('{__schema{queryType{name}}}');
                const introspectionText = introspection.body.toString('utf8');
                const introspectionEnabled = introspection.status >= 200 && introspection.status < 300 && /"__schema"\s*:/u.test(introspectionText) && !/"errors"\s*:/u.test(introspectionText);
                probes.push({ kind: 'http', pattern: 'graphql-introspection', targetUrl: target, status: introspection.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: introspectionText }), outcome: baselineWorks ? (introspectionEnabled ? 'exposed' : 'denied') : 'inconclusive' });
                const deep = await sendQuery(deepQuery);
                const deepText = deep.body.toString('utf8');
                const explicitlyLimited = deep.status === 400 || deep.status === 413 || deep.status === 429 || /(?:depth|complexity|cost|limit).{0,80}(?:exceed|maximum|too|reject)/iu.test(deepText);
                const deepExecuted = deep.status >= 200 && deep.status < 300 && /"data"\s*:/u.test(deepText) && !/"errors"\s*:/u.test(deepText);
                probes.push({ kind: 'http', pattern: 'graphql-depth-cost', targetUrl: target, status: deep.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: deepText }), outcome: !baselineWorks ? 'inconclusive' : explicitlyLimited ? 'denied' : deepExecuted ? 'exposed' : 'inconclusive' });
                skipped = ['query cost requires a schema-valid deepQuery supplied for the target; generic invalid queries are not evidence'];
                break;
            }
            case '27': {
                // Cookie認証WebSocketをsame-originとcross-originのOriginで比較し、CSWSHを確認する。
                const target = targets[0];
                if (target === undefined)
                    throw domainError('ValidationFailed', 'theme 27 requires a WebSocket target URL');
                if (this.deps.webSocketTransport === undefined)
                    throw domainError('CapabilityUnavailable', 'websocket transport is not configured for this service');
                const origins = (params.evilOrigins ?? 'https://scopepilot.invalid').split(',').map((origin) => origin.trim()).filter((origin) => origin !== '');
                if (origins.length === 0 || origins.length > 3)
                    throw domainError('ValidationFailed', 'theme 27 accepts 1..3 evil origins');
                const message = params.message ?? '{"action":"report"}';
                if (Buffer.byteLength(message, 'utf8') > 16384)
                    throw domainError('ValidationFailed', 'theme 27 message exceeds 16384 bytes');
                const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
                requestBudget(origins.length + 1);
                const exchange = async (origin: string): Promise<boolean> => {
                    try {
                        const result = await this.deps.webSocketTransport!.exchange({
                            targetUrl: target,
                            messages: [message],
                            origin,
                            ...(sessionCookies === undefined ? {} : { sessionCookies }),
                            onSentFrame: () => undefined,
                            onTextFrame: () => undefined,
                        });
                        return result.sent === 1;
                    }
                    catch {
                        return false;
                    }
                };
                const sameOrigin = new URL(target).origin;
                const controlConnected = await exchange(sameOrigin);
                probes.push({ kind: 'websocket', pattern: 'websocket-same-origin-control', targetUrl: target, status: null, finalUrl: target, bodyHash: '', outcome: controlConnected ? null : 'inconclusive' });
                for (const origin of origins) {
                    const connected = await exchange(origin);
                    probes.push({ kind: 'websocket', pattern: `websocket-cross-origin:${origin}`, targetUrl: target, status: null, finalUrl: target, bodyHash: '', outcome: !controlConnected ? 'inconclusive' : connected ? 'exposed' : 'denied' });
                }
                if (new URL(target).protocol === 'http:') {
                    probes.push({ kind: 'websocket', pattern: 'websocket-plaintext-transport', targetUrl: target, status: null, finalUrl: target, bodyHash: '', outcome: params.requireWss === 'true' ? 'exposed' : 'inconclusive' });
                }
                skipped = ['message-level authorization and token replay require target-specific messages and expected results'];
                break;
            }
            case '29': {
                // データ保護・機微露出: 認証後ページの DOM 観測で PII 疑い node を数える。
                if (targets.length === 0 || targets.length > 5)
                    throw domainError('ValidationFailed', 'theme 29 accepts 1..5 target URLs');
                if (this.deps.domObserver === undefined)
                    throw domainError('CapabilityUnavailable', 'DOM observer is not configured for this service');
                requestBudget(targets.length * 2);
                const session = input.role === undefined ? undefined : requireSession();
                for (const target of targets) {
                    const canonical = ScopePolicy.canonicalUrl(target);
                    const page = await browser().execute({
                        targetUrl: canonical,
                        scope: caseRecord.scope,
                        steps: [{ kind: 'navigate', target: canonical }],
                        ...(session === undefined ? {} : { browserSession: session.browserState }),
                    });
                    const sensitiveParams = findSensitiveUrlParamNames(canonical);
                    probes.push({ kind: 'browser', pattern: 'sensitive-url-parameters', targetUrl: canonical, status: page.status, finalUrl: page.finalUrl, bodyHash: page.bodyHash, outcome: sensitiveParams.length > 0 ? 'exposed' : 'denied', detail: `parameterNames=${sensitiveParams.length === 0 ? '(none)' : sensitiveParams.join(',')}` });
                    const cacheControl = headerValue(page.headers, 'Cache-Control');
                    probes.push({ kind: 'browser', pattern: 'sensitive-cache-control', targetUrl: canonical, status: page.status, finalUrl: page.finalUrl, bodyHash: '', outcome: judgeSensitiveCache(cacheControl), detail: `cacheControl=${cacheControl ?? '(missing)'}` });
                    const observation = await this.deps.domObserver.observe({
                        targetUrl: canonical,
                        scope: caseRecord.scope,
                        ...(session === undefined ? {} : { browserSession: session.browserState }),
                    });
                    const piiCount = observation.nodes.filter((node) => node.looksLikePii).length;
                    const confirmedUnmaskedCount = observation.nodes.filter((node) => node.looksLikePii && /(?:payment-card|my-number|pin)-unmasked/u.test(node.text)).length;
                    // 実 adapter は生のDOM本文ではなくカテゴリ化済みnodeだけを返す。nodeが空なら
                    // 古い/代替adapter等で分類自体が未実施なので、問題なしにせず inconclusive とする。
                    const outcome = observation.nodes.length === 0 ? 'inconclusive' : judgePiiExposure(piiCount, confirmedUnmaskedCount);
                    probes.push({ kind: 'dom', pattern: 'pii-exposure', targetUrl: canonical, status: null, finalUrl: canonical, bodyHash: '', outcome, detail: `piiCandidates=${String(piiCount)}; confirmedUnmasked=${String(confirmedUnmaskedCount)}; nodes=${String(observation.nodes.length)}` });
                }
                skipped = ['API over-fetching/ownership and third-party transmission require traffic context', 'file metadata (ExifTool) verification'];
                break;
            }
            case '30': {
                // 公開情報・設定面: 既に選択されたHTTP対象の応答だけを観測する。共通パスの
                // 推測列挙はここでは行わず、Server等の版、Content-Type、directory listing、
                // source map参照を本文を保存せずに判定する。
                if (targets.length === 0 || targets.length > 5)
                    throw domainError('ValidationFailed', 'theme 30 accepts 1..5 target URLs');
                requestBudget(targets.length);
                const session = input.role === undefined ? undefined : requireSession();
                const disclosureHeaders = ['Server', 'X-Powered-By', 'X-AspNet-Version', 'X-AspNetMvc-Version'] as const;
                for (const target of targets) {
                    const canonical = ScopePolicy.canonicalUrl(target);
                    const sessionCookies = session === undefined ? undefined : applicableSessionCookies([...session.cookies], canonical);
                    const response = await repeater().send({
                        targetUrl: canonical,
                        requestBytes: rawRequest('GET', canonical, [['Accept', 'text/html,application/json;q=0.9,*/*;q=0.1']], ''),
                        ...(sessionCookies === undefined ? {} : { sessionCookies }),
                    });
                    const bodyText = response.body.toString('utf8');
                    const finalUrl = response.redirectLocations.at(-1) ?? canonical;
                    for (const name of disclosureHeaders) {
                        const value = headerValue(response.headers, name);
                        probes.push({
                            kind: 'http',
                            pattern: `version-header:${name.toLocaleLowerCase()}`,
                            targetUrl: canonical,
                            status: response.status,
                            finalUrl,
                            bodyHash: '',
                            outcome: judgeVersionDisclosure(value),
                            detail: `${name}=${value ?? '(missing)'}`,
                        });
                    }
                    const contentType = headerValue(response.headers, 'Content-Type');
                    probes.push({
                        kind: 'http',
                        pattern: 'response-content-type',
                        targetUrl: canonical,
                        status: response.status,
                        finalUrl,
                        bodyHash: '',
                        outcome: judgeResponseContentType({ status: response.status, bodyByteLength: response.body.byteLength, contentType }),
                        detail: `contentType=${contentType ?? '(missing)'}`,
                    });
                    probes.push({
                        kind: 'http',
                        pattern: 'directory-listing',
                        targetUrl: canonical,
                        status: response.status,
                        finalUrl,
                        bodyHash: hashStable('scopepilot2.theme', { body: bodyText }),
                        outcome: judgeDirectoryListing(bodyText),
                    });
                    const sourceMapReference = /(?:\/\/[#@]\s*sourceMappingURL=|\/\*[#@]\s*sourceMappingURL=)/u.test(bodyText);
                    probes.push({
                        kind: 'http',
                        pattern: 'source-map-reference',
                        targetUrl: canonical,
                        status: response.status,
                        finalUrl,
                        bodyHash: '',
                        outcome: sourceMapReference ? 'exposed' : 'denied',
                        detail: `referenceFound=${String(sourceMapReference)}`,
                    });
                    const parsedTarget = new URL(canonical);
                    const callbackName = parsedTarget.searchParams.get('callback') ?? parsedTarget.searchParams.get('jsonp');
                    const jsonpReturned = callbackName !== null
                        && /^[A-Za-z_$][A-Za-z0-9_$.[\]]{0,127}$/u.test(callbackName)
                        && bodyText.trimStart().startsWith(`${callbackName}(`);
                    probes.push({
                        kind: 'http',
                        pattern: 'jsonp-response',
                        targetUrl: canonical,
                        status: response.status,
                        finalUrl,
                        bodyHash: '',
                        outcome: jsonpReturned ? 'exposed' : 'denied',
                        detail: `callbackObserved=${String(jsonpReturned)}`,
                    });
                    const metadataLikePath = /(?:\/(?:\.git|\.svn)(?:\/|$)|\/(?:\.env|server-status|phpinfo\.php)$|\.(?:bak|old|orig|save|swp|zip|tar|gz)$)/iu.test(parsedTarget.pathname);
                    const metadataSignature = /(?:^ref:\s+refs\/heads\/|<title>phpinfo\(\)|\[(?:core|remote\s+"origin")\]|(?:APP_KEY|DATABASE_URL|DB_PASSWORD)\s*=)/imu.test(bodyText);
                    const publishedMetadata = response.status >= 200 && response.status < 300 && metadataLikePath && metadataSignature;
                    probes.push({
                        kind: 'http',
                        pattern: 'published-metadata',
                        targetUrl: canonical,
                        status: response.status,
                        finalUrl,
                        bodyHash: '',
                        outcome: publishedMetadata ? 'exposed' : 'denied',
                        detail: `sensitivePath=${String(metadataLikePath)}; signatureFound=${String(metadataSignature)}`,
                    });
                }
                skipped = ['common-path guessing and authenticated administrative-surface discovery require reviewed target URLs'];
                break;
            }
            default:
                throw domainError('ValidationFailed', `zap-unsupported theme ${themeNo} has no handler`);
        }
        const judged = probes.filter((probe) => probe.outcome !== null).map((probe) => probe.outcome!);
        const summary = summarizeThemeOutcomes(judged, skipped);
        const checkId = this.deps.ids.next('themecheck');
        const executedAt = this.deps.clock.now().toISOString();
        const record = {
            checkId,
            themeNo,
            role: input.role ?? null,
            status: summary.status,
            totalRequests: probes.length,
            ...(skipped.length === 0 ? {} : { skipped: [...skipped] }),
            executedAt,
        };
        (this.context.zapUnsupportedChecks as typeof record[]).push(record);
        await this.evidence.saveText(`zap-unsupported:${checkId}`, canonicalJson({
            checkId,
            themeNo,
            role: input.role ?? null,
            results: probes.map((probe) => ({ kind: probe.kind, pattern: probe.pattern, targetUrl: probe.targetUrl, status: probe.status, finalUrl: probe.finalUrl, bodyHash: probe.bodyHash, outcome: probe.outcome, ...(probe.detail === undefined ? {} : { detail: probe.detail }) })),
            ...(skipped.length === 0 ? {} : { skipped }),
            status: summary.status,
        }), { targetUrl: targets[0] ?? '', kind: 'zap-unsupported' });
        this.events.publish({ type: 'ZapUnsupportedCheckCompleted', at: executedAt, checkId, themeNo, role: input.role ?? '', status: summary.status });
        return { ...record, results: probes };
    }
    listZapUnsupportedChecks(): readonly {
        checkId: string;
        themeNo: string;
        role: string | null;
        status: string;
        totalRequests: number;
        skipped?: readonly string[];
        executedAt: string;
    }[] {
        return [...this.context.zapUnsupportedChecks];
    }
    async runInteractiveDiagnostics(operator: OperatorProfile, input: InteractiveDiagnosticRunInput): Promise<{
        results: readonly InteractiveDiagnosticItemResult[];
    }> {
        requirePermission(operator, 'run.manage');
        if (!input.confirmed)
            throw domainError('ValidationFailed', 'interactive diagnostic plan requires operator confirmation');
        if (input.items.length === 0 || input.items.length > 20) {
            throw domainError('ValidationFailed', 'interactive diagnostic plan must contain between 1 and 20 items');
        }
        const caseRecord = this.ports.currentCase();
        const authorization = this.ports.currentAuthorization();
        if (!authorization.allowedOperationClasses.includes('ActiveScan')) {
            throw domainError('OutOfScope', 'authorization does not allow ActiveScan for this case');
        }
        const files = new Map(input.files.map((file) => [file.inputRef, file]));
        const apiDocuments = new Map(input.apiDocuments.map((document) => [document.inputRef, document]));
        const forbiddenClickTerms = ['logout', 'log-out', 'delete', 'remove', '退会', '削除'];
        const results: InteractiveDiagnosticItemResult[] = [];
        const roleBrowserSession = (role: string): BrowserSessionState | undefined => {
            if (role === '' || role === 'unauthenticated')
                return undefined;
            const session = this.vault.roleSessionCookies.get(role);
            if (session === undefined)
                throw domainError('ValidationFailed', `no authenticated session for role ${role}`);
            return session.browserState;
        };
        const validateSteps = (steps: readonly InteractiveBrowserStep[]): void => {
            if (steps.length === 0 || steps.length > 20)
                throw domainError('ValidationFailed', 'browser diagnostic needs 1 to 20 steps');
            for (const step of steps) {
                if (step.target.trim() === '' || step.target.length > 1000)
                    throw domainError('ValidationFailed', 'browser diagnostic step target is invalid');
                if (step.kind === 'navigate' && !ScopePolicy.decide(caseRecord.scope, step.target).allowed) {
                    throw domainError('OutOfScope', `interactive navigation is out of scope: ${step.target}`);
                }
                if (step.kind === 'click' && forbiddenClickTerms.some((term) => step.target.toLocaleLowerCase().includes(term))) {
                    throw domainError('ValidationFailed', `interactive plan contains a forbidden click target: ${step.target}`);
                }
                if ((step.kind === 'fill' || step.kind === 'select' || step.kind === 'assertValue') && step.value.length > 2000) {
                    throw domainError('ValidationFailed', 'interactive browser value exceeds 2000 characters');
                }
                if (step.kind === 'upload' && !files.has(step.inputRef)) {
                    throw domainError('ValidationFailed', `required upload input is missing: ${step.inputRef}`);
                }
            }
        };
        for (const item of input.items) {
            const canonical = ScopePolicy.canonicalUrl(item.targetUrl);
            if (!ScopePolicy.decide(caseRecord.scope, canonical).allowed) {
                throw domainError('OutOfScope', `interactive diagnostic target is out of scope: ${canonical}`);
            }
            if (item.track === 'session-analysis') {
                const result = await this.ports.runSequencerSession(operator, {
                    targetUrl: canonical,
                    samples: item.samples,
                    ...(item.role === '' || item.role === 'unauthenticated' ? {} : { role: item.role }),
                    tokenSource: item.tokenSource,
                    ...(item.tokenSource === 'cookie' ? { tokenCookieName: item.tokenName } : {}),
                    ...(item.tokenSource === 'hidden' ? { tokenFieldName: item.tokenName } : {}),
                });
                const evidence = await this.evidence.saveText(`interactive-diagnostic:${item.itemId}`, canonicalJson({ itemId: item.itemId, track: item.track, targetUrl: canonical, result }), { track: item.track, targetUrl: canonical });
                results.push({ itemId: item.itemId, track: item.track, targetUrl: canonical, status: result.verdict === 'assessed' ? 'completed' : 'inconclusive', detail: `${result.sampleCount} samples; ${result.duplicates} duplicates; ${result.missing} missing`, evidenceId: evidence.evidenceId });
                continue;
            }
            if (item.track === 'api-schema') {
                const document = apiDocuments.get('api-spec');
                if (document === undefined)
                    throw domainError('ValidationFailed', 'API specification input is missing');
                const imported = this.ports.importApiSpec(operator, { documentLabel: document.name, document: document.document });
                const evidence = await this.evidence.saveText(`interactive-diagnostic:${item.itemId}`, canonicalJson({ itemId: item.itemId, track: item.track, targetUrl: canonical, endpoints: imported.endpoints, warnings: imported.warnings }), { track: item.track, targetUrl: canonical });
                results.push({ itemId: item.itemId, track: item.track, targetUrl: canonical, status: imported.endpoints.length > 0 ? 'completed' : 'inconclusive', detail: `${imported.endpoints.length} API endpoints imported`, evidenceId: evidence.evidenceId });
                continue;
            }
            if (this.deps.interactiveBrowser === undefined)
                throw domainError('CapabilityUnavailable', 'interactive browser is not configured');
            validateSteps(item.steps);
            if (item.track === 'authorization-differential') {
                if (!authorization.allowedOperationClasses.includes('CrossRoleTest')) {
                    throw domainError('OutOfScope', 'authorization does not allow CrossRoleTest for this case');
                }
                if (item.roles.length < 2 || new Set(item.roles).size !== item.roles.length) {
                    throw domainError('ValidationFailed', 'authorization differential needs at least two distinct roles');
                }
                const observations = [] as {
                    role: string;
                    finalUrl: string;
                    status: number | null;
                    bodyHash: string;
                    assertionsPassed: boolean;
                }[];
                for (const role of item.roles) {
                    const browserSession = roleBrowserSession(role);
                    const observation = await this.deps.interactiveBrowser.execute({
                        targetUrl: canonical,
                        scope: caseRecord.scope,
                        steps: item.steps,
                        ...(browserSession === undefined ? {} : { browserSession }),
                    });
                    observations.push({ role, finalUrl: observation.finalUrl, status: observation.status, bodyHash: observation.bodyHash, assertionsPassed: observation.assertions.every((entry) => entry.passed) });
                }
                const fingerprints = new Set(observations.map((entry) => `${entry.status}:${entry.finalUrl}:${entry.bodyHash}`));
                const actual = fingerprints.size === 1 ? 'same' : 'different';
                const passed = actual === item.expectation;
                const evidence = await this.evidence.saveText(`interactive-diagnostic:${item.itemId}`, canonicalJson({ itemId: item.itemId, track: item.track, targetUrl: canonical, expectation: item.expectation, actual, observations }), { track: item.track, targetUrl: canonical });
                results.push({ itemId: item.itemId, track: item.track, targetUrl: canonical, status: passed ? 'passed' : 'failed', detail: `role responses were ${actual}; expected ${item.expectation}`, evidenceId: evidence.evidenceId });
                continue;
            }
            const selectedFiles = item.steps.flatMap((step) => step.kind === 'upload' ? [files.get(step.inputRef)] : []).filter((file): file is InteractiveBrowserFile => file !== undefined);
            const browserSession = roleBrowserSession(item.role);
            const observation = await this.deps.interactiveBrowser.execute({
                targetUrl: canonical,
                scope: caseRecord.scope,
                steps: item.steps,
                ...(browserSession === undefined ? {} : { browserSession }),
                ...(selectedFiles.length === 0 ? {} : { files: selectedFiles }),
            });
            const assertionsPassed = observation.assertions.every((entry) => entry.passed);
            const evidenceObservation = {
                finalUrl: observation.finalUrl,
                status: observation.status,
                bodyHash: observation.bodyHash,
                elapsedMs: observation.elapsedMs,
                headerNames: observation.headers.map(([name]) => name),
                assertions: observation.assertions,
            };
            const evidence = await this.evidence.saveText(`interactive-diagnostic:${item.itemId}`, canonicalJson({ itemId: item.itemId, track: item.track, targetUrl: canonical, observation: evidenceObservation }), { track: item.track, targetUrl: canonical });
            results.push({
                itemId: item.itemId,
                track: item.track,
                targetUrl: canonical,
                status: observation.assertions.length === 0 ? 'completed' : assertionsPassed ? 'passed' : 'failed',
                detail: `${observation.assertions.filter((entry) => entry.passed).length}/${observation.assertions.length} assertions passed; final status ${observation.status ?? 'unknown'}`,
                evidenceId: evidence.evidenceId,
            });
        }
        this.context.latestDiagnosticRoutes = this.context.latestDiagnosticRoutes.map((route) => {
            const result = results.find((candidate) => candidate.track === route.track && ScopePolicy.canonicalUrl(candidate.targetUrl) === route.targetUrl);
            return result === undefined ? route : { ...route, status: 'executed' as const, detail: result.detail };
        });
        return { results };
    }
}
