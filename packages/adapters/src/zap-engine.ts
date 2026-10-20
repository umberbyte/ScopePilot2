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
  /** runId → 対象 URL 一覧。alerts をこの run の対象 origin に限定する。 */
  private readonly runTargets = new Map<string, readonly string[]>();
  /** scanId → status API が連続で does_not_exist を返した回数 (消失判定用)。 */
  private readonly missingStatusCounts = new Map<string, number>();
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
        const detail = await response.text().catch(() => '');
        throw new Error(`ZAP API ${path} failed: HTTP ${String(response.status)}${detail === '' ? '' : ` ${detail.slice(0, 200)}`}`);
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
    // accessUrl の応答と site tree への反映は非同期で、直後の scan が
    // url_not_found になることがある (実機で確認) — 短く待って再取得し
    // 指定回数だけ再試行する。
    const first = request.targets[0] ?? '';
    let scanId: string | undefined;
    for (let attempt = 0; attempt < 3 && (scanId === undefined || scanId === ''); attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, 500);
        });
      }
      for (const target of request.targets) {
        await this.api('core/action/accessUrl', { url: target });
      }
      const body = await this.api<{ scan?: string }>('ascan/action/scan', {
        url: first,
        recurse: 'true',
        inScopeOnly: 'false',
        ...(this.scanPolicy === '' ? {} : { scanPolicyName: this.scanPolicy }),
      }).catch((cause: unknown) => {
        if (attempt < 2 && cause instanceof Error && cause.message.includes('url_not_found')) {
          return { scan: '' } as { scan?: string };
        }
        throw cause;
      });
      scanId = body.scan;
    }
    if (scanId === undefined || scanId === '') {
      throw new Error('ZAP ascan did not return a scan id');
    }
    this.runTargets.set(scanId, [...request.targets]);
    return scanId;
  }

  async progress(engineRunId: string): Promise<EngineProgress> {
    const [statusBody, scansBody] = await Promise.all([
      this.api<{ status: string }>('ascan/view/status', { scanId: engineRunId }).catch((cause: unknown) => {
        // scan 開始直後は登録が status API に間に合わず does_not_exist が返ることが
        // ある (実機で確認)。まだ見えていない = 実行中として扱い poll を継続する。
        if (cause instanceof Error && cause.message.includes('does_not_exist')) {
          const missing = (this.missingStatusCounts.get(engineRunId) ?? 0) + 1;
          this.missingStatusCounts.set(engineRunId, missing);
          return { status: '-1' };
        }
        throw cause;
      }),
      this.api<{ scans: readonly { readonly id: string; readonly state: string }[] }>('ascan/view/scans'),
    ]);
    if (statusBody.status !== '-1') {
      this.missingStatusCounts.delete(engineRunId);
    } else if ((this.missingStatusCounts.get(engineRunId) ?? 0) >= 3) {
      // 登録 race を過ぎても status API に存在しない scan は ZAP 側で消失した
      // (実機で確認 — 同一 session で複数 scan を重ねると起きる)。完了として
      // 扱い、取得できている alert だけを返す (poll の無限待ちを避ける)。
      return { status: 'complete', progress: 100, lastActivityAt: new Date().toISOString(), messageCount: 0 };
    }
    const state = scansBody.scans.find((scan) => scan.id === engineRunId)?.state ?? 'RUNNING';
    const progress = Number(statusBody.status);
    const upperState = state.toUpperCase();
    // 実 ZAP の state は FINISHED (旧表記 COMPLETED も許容)。
    const status: EngineProgress['status'] = upperState.includes('FINISHED') || upperState.includes('COMPLETE')
      ? 'complete'
      : upperState.includes('FAILED') || upperState.includes('STOPPED')
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
    // ZAP session には他 run・他対象の alert が残っている (baseurl='' は全件)。
    // この run の対象 origin のみに限定する — そうしないと過去 run の所見が混入する。
    const origins = new Set((this.runTargets.get(engineRunId) ?? []).map((target) => new URL(target).origin));
    const alerts: EngineAlert[] = body.alerts
      .filter((alert) => origins.size === 0 || [...origins].some((origin) => alert.url.startsWith(`${origin}/`)))
      .map((alert) => ({
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

  /** テスト向け: run ごとの対象記録を消す (本番運用では process と同じ寿命)。 */
  forgetRun(engineRunId: string): void {
    this.runTargets.delete(engineRunId);
  }

async stop(engineRunId: string): Promise<void> {
    // 停止は冪等 (F11-UT-005)。既に存在しない (完了して掃除された) scan への停止は
    // 成功として扱う — 実機で does_not_exist が返ることを確認済み。
    await this.api('ascan/action/stop', { scanId: engineRunId }).catch((cause: unknown) => {
      if (cause instanceof Error && cause.message.includes('does_not_exist')) {
        return;
      }
      throw cause;
    });
  }
}
