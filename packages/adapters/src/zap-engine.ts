import type { ActiveScanEnginePort, ActiveScanExecutionContext, LoginSessionCookie } from '@scopepilot2/core';
import type { ActiveScanRequest, EngineAlert, EngineProgress, RequestInputPoint } from '@scopepilot2/contracts';

export interface ZapAdapterOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly scanPolicy?: string;
  readonly timeoutMs?: number;
  readonly spiderEnabled?: boolean;
  readonly ajaxSpiderEnabled?: boolean;
}

interface ZapAlert {
  readonly id: string;
  readonly pluginId: string;
  readonly name: string;
  readonly risk: string;
  readonly url: string;
  readonly method: string;
  readonly param?: string;
  readonly evidence?: string;
  readonly other?: string;
}

interface ZapRun {
  readonly targets: readonly string[];
  readonly scanIds: readonly string[];
  readonly baselineAlertIds: ReadonlySet<string>;
  readonly emittedAlertIds: Set<string>;
}

interface ZapSendRequestResponse {
  /** Older/alternate ZAP builds expose this name. */
  readonly response?: unknown;
  /** Current ZAP JSON API uses the action name as the response property. */
  readonly sendRequest?: unknown;
}

function rawResponseFromSendRequest(result: ZapSendRequestResponse): string {
  const normalize = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    const messages = Array.isArray(value) ? value : [value];
    const responses = messages.flatMap((message) => {
      if (typeof message !== 'object' || message === null) return [];
      const record = message as Record<string, unknown>;
      const header = typeof record.responseHeader === 'string' ? record.responseHeader : '';
      const body = typeof record.responseBody === 'string' ? record.responseBody : '';
      return header === '' && body === '' ? [] : [`${header}\r\n\r\n${body}`];
    });
    return responses.length === 0 ? undefined : responses.join('\r\n\r\n');
  };
  const current = normalize(result.sendRequest);
  if (current !== undefined) return current;
  const legacy = normalize(result.response);
  if (legacy !== undefined) return legacy;
  throw new Error('ZAP API core/action/sendRequest returned no HTTP response');
}

function riskOf(zapRisk: string): EngineAlert['risk'] {
  switch (zapRisk.toLowerCase()) {
    case 'informational': return 'Informational';
    case 'low': return 'Low';
    case 'medium': return 'Medium';
    case 'high': return 'High';
    default: return 'Informational';
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cookieApplies(cookie: LoginSessionCookie, target: URL): boolean {
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  const host = target.hostname.toLowerCase();
  const domainMatches = host === domain || host.endsWith(`.${domain}`);
  const path = cookie.path === '' ? '/' : cookie.path;
  return domainMatches && target.pathname.startsWith(path);
}

function zapSite(url: URL): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.hostname}:${port}`;
}

function benignValue(point: RequestInputPoint): string {
  if (/email/i.test(point.name)) return 'scopepilot@example.invalid';
  if (/^(?:id|page|count|limit|offset)$/i.test(point.name)) return '1';
  if (/url|redirect|return|next/i.test(point.name)) return '/';
  return 'scopepilot';
}

function seedUrl(seed: ActiveScanExecutionContext['requestSeeds'][number]): URL {
  const url = new URL(seed.url);
  if (seed.method === 'GET') {
    for (const point of seed.inputPoints.filter((candidate) => candidate.location === 'query')) {
      if (!url.searchParams.has(point.name)) url.searchParams.set(point.name, benignValue(point));
    }
  }
  return url;
}

function seedBody(seed: ActiveScanExecutionContext['requestSeeds'][number]): { readonly body: string; readonly contentType?: string } {
  const method = seed.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return { body: '' };
  const points = seed.inputPoints.filter((point) => point.location === 'body' || point.location === 'file');
  const observedType = seed.contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (/application\/(?:[\w.+-]*\+)?json/.test(observedType)) {
    const body = Object.fromEntries(points.map((point) => [point.name === '$body' ? 'value' : point.name, benignValue(point)]));
    return { body: JSON.stringify(body), contentType: observedType };
  }
  if (observedType === 'multipart/form-data' || points.some((point) => point.location === 'file')) {
    const boundary = '----ScopePilot2Boundary';
    const parts = points.map((point) => {
      const safeName = point.name.replace(/[\r\n"]/g, '_');
      return point.location === 'file'
        ? `--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"; filename="scopepilot.txt"\r\nContent-Type: text/plain\r\n\r\nscopepilot\r\n`
        : `--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"\r\n\r\n${benignValue(point)}\r\n`;
    });
    return { body: `${parts.join('')}--${boundary}--\r\n`, contentType: `multipart/form-data; boundary=${boundary}` };
  }
  if (points.length === 1 && points[0]?.name === '$body') {
    return { body: benignValue(points[0]), ...(observedType === '' ? {} : { contentType: observedType }) };
  }
  return {
    body: new URLSearchParams(points.map((point) => [point.name, benignValue(point)])).toString(),
    contentType: observedType || 'application/x-www-form-urlencoded',
  };
}

function rawSeedRequest(
  seed: ActiveScanExecutionContext['requestSeeds'][number],
  cookies: readonly LoginSessionCookie[],
): { readonly target: string; readonly method: string; readonly postData: string; readonly raw: string } {
  const url = seedUrl(seed);
  const method = seed.method.toUpperCase();
  const applicable = cookies.filter((cookie) => cookieApplies(cookie, url));
  const { body, contentType } = seedBody(seed);
  const path = `${url.pathname}${url.search}` || '/';
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${url.host}`,
    'User-Agent: ScopePilot2/ZAP-seed',
    'Accept: */*',
    ...(applicable.length === 0 ? [] : [`Cookie: ${applicable.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')}`]),
    ...(body === '' ? [] : [`Content-Type: ${contentType ?? 'application/octet-stream'}`, `Content-Length: ${Buffer.byteLength(body)}`]),
    'Connection: close',
    '',
    body,
  ];
  return { target: url.toString(), method, postData: body, raw: lines.join('\r\n') };
}

interface SeededRequest {
  readonly target: string;
  readonly method: string;
  readonly postData: string;
  readonly hasInputPoints: boolean;
}

export class ZapEngineAdapter implements ActiveScanEnginePort {
  private mutableEngineVersion = 'zap-api (unresolved)';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly scanPolicy: string;
  private readonly timeoutMs: number;
  private readonly spiderEnabled: boolean;
  private readonly ajaxSpiderEnabled: boolean;
  private readonly runs = new Map<string, ZapRun>();
  private versionPromise: Promise<string> | null = null;

  constructor(options: ZapAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey ?? process.env['SCOPEPILOT_ZAP_API_KEY'] ?? '';
    this.scanPolicy = options.scanPolicy ?? '';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    // Discovery belongs to S03 (Playwright). S06 must operate only on the
    // targets confirmed in S04; recursively spidering here can reach unrelated
    // state-changing forms and invalidate the authenticated account.
    this.spiderEnabled = options.spiderEnabled ?? false;
    this.ajaxSpiderEnabled = options.ajaxSpiderEnabled ?? false;
  }

  private async api<T>(path: string, params: Readonly<Record<string, string>> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/JSON/${path}`);
    if (this.apiKey !== '') url.searchParams.set('apikey', this.apiKey);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`ZAP API ${path} failed: HTTP ${String(response.status)}${detail === '' ? '' : ` ${detail.slice(0, 200)}`}`);
      }
      const body = await response.json() as T & { code?: string; message?: string };
      if (typeof body === 'object' && body !== null && body.code !== undefined) {
        throw new Error(`ZAP API ${path} failed: ${body.code}${body.message === undefined ? '' : ` ${body.message}`}`);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  get engineVersion(): string { return this.mutableEngineVersion; }

  private fetchVersion(): Promise<string> {
    return this.api<{ version: string }>('core/view/version').then((body) => {
      this.mutableEngineVersion = `zap ${body.version}`;
      return this.mutableEngineVersion;
    }).catch((cause: unknown) => {
      this.mutableEngineVersion = 'zap (unavailable)';
      throw cause;
    });
  }

  async resolvedVersion(): Promise<string> {
    this.versionPromise ??= this.fetchVersion();
    return await this.versionPromise;
  }

  private async alertsForTargets(targets: readonly string[]): Promise<readonly ZapAlert[]> {
    const origins = targets.length === 0 ? [''] : [...new Set(targets.map((target) => new URL(target).origin))];
    const alerts: ZapAlert[] = [];
    for (const origin of origins) {
      const body = await this.api<{ alerts: readonly ZapAlert[] }>('core/view/alerts', {
        baseurl: origin,
        start: '0',
        count: '100000',
      });
      alerts.push(...body.alerts);
    }
    return alerts;
  }

  private async configureContext(runId: string, targets: readonly string[]): Promise<{
    readonly contextName: string;
    readonly contextId: string;
    readonly userId: string;
    readonly userName: string;
  }> {
    const contextName = `ScopePilot-${runId.replace(/[^A-Za-z0-9_.-]/g, '-')}-${Date.now().toString(36)}`;
    const created = await this.api<{ contextId: string }>('context/action/newContext', { contextName });
    for (const origin of new Set(targets.map((target) => new URL(target).origin))) {
      await this.api('context/action/includeInContext', {
        contextName,
        regex: `^${escapeRegex(origin)}(?:/.*)?$`,
      });
      await this.api('context/action/excludeFromContext', {
        contextName,
        regex: `^${escapeRegex(origin)}/(?:logout|log-out|logoff|signout|sign-out|setup|install)(?:\\.php)?(?:[/?#].*)?$`,
      });
    }
    await this.api('sessionManagement/action/setSessionManagementMethod', {
      contextId: created.contextId,
      methodName: 'cookieBasedSessionManagement',
      methodConfigParams: '',
    }).catch(() => undefined);
    await this.api('authentication/action/setAuthenticationMethod', {
      contextId: created.contextId,
      authMethodName: 'manualAuthentication',
      authMethodConfigParams: '',
    }).catch(() => undefined);
    const userName = `ScopePilot ${runId}`;
    const user = await this.api<{ userId: string }>('users/action/newUser', { contextId: created.contextId, name: userName });
    await this.api('users/action/setUserEnabled', { contextId: created.contextId, userId: user.userId, enabled: 'true' });

    return { contextName, contextId: created.contextId, userId: user.userId, userName };
  }

  private async activateHttpSessions(
    contextName: string,
    targets: readonly string[],
    cookies: readonly LoginSessionCookie[],
  ): Promise<void> {
    for (const origin of new Set(targets.map((target) => new URL(target).origin))) {
      const session = contextName;
      const site = zapSite(new URL(origin));
      await this.api('httpSessions/action/createEmptySession', { site, session });
      for (const cookie of cookies.filter((candidate) => targets.some((target) => new URL(target).origin === origin && cookieApplies(candidate, new URL(target))))) {
        await this.api('httpSessions/action/addSessionToken', { site, sessionToken: cookie.name }).catch((cause: unknown) => {
          if (cause instanceof Error && cause.message.includes('already_exists')) return;
          throw cause;
        });
        await this.api('httpSessions/action/setSessionTokenValue', {
          site,
          session,
          sessionToken: cookie.name,
          tokenValue: cookie.value,
        });
      }
      await this.api('httpSessions/action/setActiveSession', { site, session });
    }
  }

  private async seedAndVerify(
    seeds: ActiveScanExecutionContext['requestSeeds'],
    cookies: readonly LoginSessionCookie[],
  ): Promise<readonly SeededRequest[]> {
    const requests: SeededRequest[] = [];
    for (const seed of seeds) {
      const request = rawSeedRequest(seed, cookies);
      const result = await this.api<ZapSendRequestResponse>('core/action/sendRequest', {
        request: request.raw,
        followRedirects: 'false',
      });
      const response = rawResponseFromSendRequest(result);
      const expectedLow = cookies.some((cookie) => cookie.name.toLowerCase() === 'security' && cookie.value.toLowerCase() === 'low');
      if ((expectedLow || cookies.length > 0) && /set-cookie:\s*security=impossible/im.test(response)) {
        throw new Error(`Authenticated scan preflight failed for ${request.target}: server replaced security=low with security=impossible`);
      }
      if (cookies.length > 0 && /\nlocation:\s*[^\r\n]*login(?:\.php)?/im.test(response)) {
        throw new Error(`Authenticated scan preflight failed for ${request.target}: request was redirected to login`);
      }
      for (const cookie of cookies.filter((candidate) => cookieApplies(candidate, new URL(request.target)))) {
        const escapedName = escapeRegex(cookie.name);
        const replacement = response.match(new RegExp(`^Set-Cookie:\\s*${escapedName}=([^;\\r\\n]*)`, 'im'))?.[1];
        if (replacement !== undefined && replacement !== cookie.value) {
          throw new Error(`Authenticated scan preflight failed for ${request.target}: server replaced session cookie ${cookie.name}`);
        }
      }
      requests.push({
        target: request.target,
        method: request.method,
        postData: request.postData,
        hasInputPoints: seed.inputPoints.length !== 0,
      });
    }
    return requests;
  }

  private async verifyAuthenticationProbe(
    probe: ActiveScanExecutionContext['authenticationProbe'],
    cookies: readonly LoginSessionCookie[],
  ): Promise<void> {
    if (probe === undefined) return;
    const request = rawSeedRequest({ url: probe.url, method: 'GET', inputPoints: [] }, cookies);
    const result = await this.api<ZapSendRequestResponse>('core/action/sendRequest', { request: request.raw, followRedirects: 'false' });
    const response = rawResponseFromSendRequest(result);
    if (/\nlocation:\s*[^\r\n]*login(?:\.php)?/im.test(response)) {
      throw new Error(`Authenticated scan preflight failed for ${probe.url}: authentication probe redirected to login`);
    }
    for (const marker of probe.markers.filter((candidate) => candidate !== '')) {
      if (!response.includes(marker)) {
        throw new Error(`Authenticated scan preflight failed for ${probe.url}: success marker was not present`);
      }
    }
  }

  private async runTraditionalSpider(url: string, context: { readonly contextName: string }, deadline: number): Promise<void> {
    if (!this.spiderEnabled) return;
    const started = await this.api<{ scan: string }>('spider/action/scan', {
      url,
      contextName: context.contextName,
      maxChildren: '0',
      recurse: 'true',
      subtreeOnly: 'false',
    }).catch(() => null);
    if (started === null) return;
    while (Date.now() < deadline) {
      const status = await this.api<{ status: string }>('spider/view/status', { scanId: started.scan });
      if (Number(status.status) >= 100) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.api('spider/action/stop', { scanId: started.scan }).catch(() => undefined);
  }

  private async runAjaxSpider(url: string, context: { readonly contextName: string }, deadline: number): Promise<void> {
    if (!this.ajaxSpiderEnabled || Date.now() >= deadline) return;
    const started = await this.api('ajaxSpider/action/scan', {
      url,
      contextName: context.contextName,
      subtreeOnly: 'false',
    }).then(() => true).catch(() => false);
    if (!started) return;
    while (Date.now() < deadline) {
      const status = await this.api<{ status: string }>('ajaxSpider/view/status');
      if (status.status.toLowerCase() === 'stopped') return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await this.api('ajaxSpider/action/stop').catch(() => undefined);
  }

  async start(request: ActiveScanRequest, execution: ActiveScanExecutionContext = { requestSeeds: [] }): Promise<string> {
    const cookies = execution.sessionCookies ?? [];
    const seeds = execution.requestSeeds.length > 0
      ? execution.requestSeeds
      : request.targets.map((url) => ({ url, method: 'GET', inputPoints: [] }));
    const baseline = await this.alertsForTargets(request.targets);
    const context = await this.configureContext(request.runId, request.targets);
    const seededRequests = await this.seedAndVerify(seeds, cookies);
    await this.verifyAuthenticationProbe(execution.authenticationProbe, cookies);
    await this.activateHttpSessions(context.contextName, request.targets, cookies);
    const crawlRoot = request.targets[0];
    if (crawlRoot !== undefined) {
      const crawlBudgetMs = Math.min(request.leasedLimits.maxDurationMinutes * 60_000, 60_000);
      const deadline = Date.now() + crawlBudgetMs;
      await this.runTraditionalSpider(crawlRoot, context, deadline);
      await this.runAjaxSpider(crawlRoot, context, deadline);
    }

    const attackRequests = [...new Map(
      seededRequests
        .filter((candidate) => candidate.hasInputPoints)
        .map((candidate) => [`${candidate.method}\u0000${candidate.target}\u0000${candidate.postData}`, candidate]),
    ).values()];
    if (attackRequests.length === 0 && seededRequests[0] !== undefined) attackRequests.push(seededRequests[0]);
    const boundedRequests = attackRequests.slice(0, Math.max(1, Math.min(100, request.leasedLimits.maxPages)));
    const scanIds: string[] = [];
    try {
      for (const candidate of boundedRequests) {
        const body = await this.api<{ scan: string }>('ascan/action/scan', {
          url: candidate.target,
          contextId: context.contextId,
          recurse: 'false',
          inScopeOnly: 'true',
          ...(candidate.method === 'GET' && candidate.postData === ''
            ? {}
            : { method: candidate.method, postData: candidate.postData }),
          ...(this.scanPolicy === '' ? {} : { scanPolicyName: this.scanPolicy }),
        }).catch((cause: unknown) => {
          const detail = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`ZAP active scan could not start for ${candidate.method} ${candidate.target}: ${detail}`, { cause });
        });
        if (body.scan !== '') scanIds.push(body.scan);
      }
    } catch (cause) {
      await Promise.all(scanIds.map(async (scanId) => {
        await this.api('ascan/action/stop', { scanId }).catch(() => undefined);
      }));
      throw cause;
    }
    if (scanIds.length === 0) throw new Error('ZAP ascan did not return a scan id');
    const engineRunId = `scopepilot:${request.runId}`;
    this.runs.set(engineRunId, {
      targets: [...request.targets],
      scanIds,
      baselineAlertIds: new Set(baseline.map((alert) => alert.id)),
      emittedAlertIds: new Set(),
    });
    return engineRunId;
  }

  private resolveRun(engineRunId: string): ZapRun {
    return this.runs.get(engineRunId) ?? {
      targets: [], scanIds: [engineRunId], baselineAlertIds: new Set(), emittedAlertIds: new Set(),
    };
  }

  async progress(engineRunId: string): Promise<EngineProgress> {
    const run = this.resolveRun(engineRunId);
    const scans = await this.api<{ scans: readonly { readonly id: string; readonly state: string; readonly progress?: string }[] }>('ascan/view/scans');
    const selected = run.scanIds
      .map((id) => scans.scans.find((scan) => scan.id === id))
      .filter((scan): scan is NonNullable<typeof scan> => scan !== undefined);
    if (selected.length === 0) {
      return { status: 'failed', progress: 0, lastActivityAt: new Date().toISOString(), messageCount: 0, failureReason: 'ZAP scans disappeared' };
    }
    const failed = selected.find((scan) => /FAILED|STOPPED/i.test(scan.state));
    const complete = selected.every((scan) => /FINISHED|COMPLETE/i.test(scan.state));
    const progressValues = await Promise.all(run.scanIds.map(async (id) => {
      const result = await this.api<{ status: string }>('ascan/view/status', { scanId: id }).catch(() => ({ status: complete ? '100' : '0' }));
      return Number(result.status);
    }));
    const progress = progressValues.length === 0 ? 0 : Math.round(progressValues.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0) / progressValues.length);
    return {
      status: failed !== undefined ? 'failed' : complete ? 'complete' : 'running',
      progress: Math.min(100, Math.max(0, progress)),
      lastActivityAt: new Date().toISOString(),
      messageCount: 0,
      ...(failed === undefined ? {} : { failureReason: `ZAP scan state: ${failed.state}` }),
    };
  }

  async alerts(engineRunId: string, cursor: number): Promise<{ readonly alerts: readonly EngineAlert[]; readonly nextCursor: number }> {
    const run = this.resolveRun(engineRunId);
    const current = await this.alertsForTargets(run.targets);
    const fresh = current.filter((alert) => !run.baselineAlertIds.has(alert.id) && !run.emittedAlertIds.has(alert.id));
    for (const alert of fresh) run.emittedAlertIds.add(alert.id);
    const alerts = fresh.map((alert): EngineAlert => ({
      engineAlertId: `zap-${alert.id}`,
      pluginId: alert.pluginId,
      name: alert.name,
      risk: riskOf(alert.risk),
      url: alert.url,
      method: alert.method,
      ...(alert.param === undefined || alert.param === '' ? {} : { param: alert.param }),
      evidenceSummary: alert.evidence ?? alert.other ?? '',
    }));
    return { alerts, nextCursor: cursor + alerts.length };
  }

  async stop(engineRunId: string): Promise<void> {
    const run = this.resolveRun(engineRunId);
    await Promise.all(run.scanIds.map(async (scanId) => {
      await this.api('ascan/action/stop', { scanId }).catch((cause: unknown) => {
        if (cause instanceof Error && cause.message.includes('does_not_exist')) return;
        throw cause;
      });
    }));
  }

  forgetRun(engineRunId: string): void { this.runs.delete(engineRunId); }
}
