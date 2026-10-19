/**
 * ZAP (Zed Attack Proxy) HTTP API adapter。`docs/detailed-design/f11-active-scan.md`・design/22。
 * 外部 engine は Delegated 扱い: こちらが握るのは入力 (対象・上限) と起動停止のみで、
 * engine が何をしたかは API の観測可能な出力から推測して記録する (送信前拒否は保証しない)。
 *
 * 実 ZAP は別途起動しておく (既定 http://127.0.0.1:8080)。API key は argv ではなく
 * 環境変数 (既定 SCOPEPILOT_ZAP_API_KEY) から読む — F21-UT-007 の秘密値方針。
 *
 * 旧版からの運用知見を反映:
 * - 「URL Does not Exist」回避: scan 開始前に ZAP 自身に対象 URL を accessUrl で
 *   取得させ、site tree に載せてから ascan を開始する。
 * - 停止は冪等 (F11-UT-005): ZAP の stop は完了済み run にも呼べるものとして扱う。
 */
import type { ActiveScanEnginePort } from '@scopepilot2/core';
import type { ActiveScanRequest, EngineAlert, EngineProgress } from '@scopepilot2/contracts';

export interface ZapAdapterOptions {
  /** ZAP の API base (例: http://127.0.0.1:8080)。 */
  readonly baseUrl: string;
  /** API key。省略時は環境変数 SCOPEPILOT_ZAP_API_KEY を使う (argv に置かない)。 */
  readonly apiKey?: string;
  /** 既定の scan policy。 */
  readonly scanPolicy?: string;
  /** API 呼出の timeout (ms)。 */
  readonly timeoutMs?: number;
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

function riskOf(zapRisk: string): EngineAlert['risk'] {
  switch (zapRisk.toLowerCase()) {
    case 'informational':
      return 'Informational';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    default:
      return 'Informational';
  }
}

export class ZapEngineAdapter implements ActiveScanEnginePort {
  /** ActiveScanEnginePort.engineVersion (readonly) は resolvedVersion() の結果で固定する。 */
  private mutableEngineVersion: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly scanPolicy: string;
  private readonly timeoutMs: number;
  private versionPromise: Promise<string> | null = null;

  constructor(options: ZapAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey ?? process.env['SCOPEPILOT_ZAP_API_KEY'] ?? '';
    this.scanPolicy = options.scanPolicy ?? '';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.mutableEngineVersion = 'zap-api (未確認)';
    this.versionPromise = this.fetchVersion();
  }

  private async api<T>(path: string, params: Readonly<Record<string, string>> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/JSON/${path}`);
    if (this.apiKey !== '') {
      url.searchParams.set('apikey', this.apiKey);
    }
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`ZAP API ${path} failed: HTTP ${String(response.status)}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  get engineVersion(): string {
    return this.mutableEngineVersion;
  }

  private fetchVersion(): Promise<string> {
    return this.api<{ version: string }>('core/view/version')
      .then((body) => {
        this.mutableEngineVersion = `zap ${body.version}`;
        return this.mutableEngineVersion;
      })
      .catch(() => 'zap (version unknown)');
  }

  /** engine 版の確認 (能力表の source=measured 化は版取得が前提)。 */
  async resolvedVersion(): Promise<string> {
    if (this.versionPromise === null) {
      this.versionPromise = this.fetchVersion();
    }
    return await this.versionPromise;
  }

  async start(request: ActiveScanRequest): Promise<string> {
    // URL Does not Exist 回避: 各対象を ZAP 自身に取得させて site tree へ載せる。
    for (const target of request.targets) {
      await this.api('core/action/accessUrl', { url: target });
    }
    const first = request.targets[0] ?? '';
    const body = await this.api<{ scan?: string }>('ascan/action/scan', {
      url: first,
      recurse: 'true',
      inScopeOnly: 'false',
      ...(this.scanPolicy === '' ? {} : { scanPolicyName: this.scanPolicy }),
    });
    const scanId = body.scan;
    if (scanId === undefined || scanId === '') {
      throw new Error('ZAP ascan did not return a scan id');
    }
    return scanId;
  }

  async progress(engineRunId: string): Promise<EngineProgress> {
    const [statusBody, scansBody] = await Promise.all([
      this.api<{ status: string }>('ascan/view/status', { scanId: engineRunId }),
      this.api<{ scans: readonly { readonly id: string; readonly state: string }[] }>('ascan/view/scans'),
    ]);
    const state = scansBody.scans.find((scan) => scan.id === engineRunId)?.state ?? 'RUNNING';
    const progress = Number(statusBody.status);
    const status: EngineProgress['status'] = state.toUpperCase().includes('COMPLETE')
      ? 'complete'
      : state.toUpperCase().includes('FAILED') || state.toUpperCase().includes('STOPPED')
        ? 'failed'
        : 'running';
    return {
      status,
      progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0,
      lastActivityAt: new Date().toISOString(),
      messageCount: 0,
      ...(status === 'failed' ? { failureReason: `ZAP scan state: ${state}` } : {}),
    };
  }

  async alerts(engineRunId: string, cursor: number): Promise<{ readonly alerts: readonly EngineAlert[]; readonly nextCursor: number }> {
    // ZAP の alerts API は baseurl 持ちで page する。cursor は件数オフセットとして使う。
    const pageSize = 100;
    const body = await this.api<{ alerts: readonly ZapAlert[] }>('core/view/alerts', {
      baseurl: '',
      start: String(cursor),
      count: String(pageSize),
    });
    void engineRunId;
    const alerts: EngineAlert[] = body.alerts.map((alert) => ({
      engineAlertId: `zap-${alert.id}`,
      pluginId: alert.pluginId,
      name: alert.name,
      risk: riskOf(alert.risk),
      url: alert.url,
      method: alert.method,
      ...(alert.param === undefined || alert.param === '' ? {} : { param: alert.param }),
      evidenceSummary: alert.evidence ?? alert.other ?? '',
    }));
    const nextCursor = body.alerts.length < pageSize ? cursor : cursor + body.alerts.length;
    return { alerts, nextCursor };
  }

  async stop(engineRunId: string): Promise<void> {
    // 冪等: 完了済み run への stop も error にしない (F11-UT-005)。
    await this.api('ascan/action/stop', { scanId: engineRunId });
  }
}
