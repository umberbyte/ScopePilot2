/**
 * ZAP proxy を listener として使う adapter (design/f02 §3・design/24 §2)。
 * ZAP daemon 自体が HTTP proxy listener であるため、session の start/stop は
 * ZAP session の作り直しで表現し、通信の傍受は messages API からの観測で行う。
 * forward/drop の判断 (scope 強制) は core の BreakQueue が持つ — ここは運搬のみ。
 * CA 証明書は ZAP が profile ごとに生成するものを公開鍵部分のみ取得する
 * (private key material は扱わない — F02-UT-006)。
 */
import { createHash } from 'node:crypto';
import type { ProxyListenerPort, ObservedProxyMessage } from '@scopepilot2/core';

export interface ZapProxyAdapterOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

interface ZapMessageSummary {
  readonly id: number;
  readonly direction: string;
  readonly requestHeader?: string;
  readonly responseHeader?: string;
  readonly url?: string;
  readonly method?: string;
}

export class ZapProxyAdapter implements ProxyListenerPort {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: ZapProxyAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey ?? process.env['SCOPEPILOT_ZAP_API_KEY'] ?? '';
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async apiText(path: string, params: Readonly<Record<string, string>> = {}): Promise<string> {
    const url = new URL(`${this.baseUrl}${path}`);
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
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /** proxy session の開始: 過去通信を切り離すため ZAP session を作り直す。 */
  async startSession(): Promise<void> {
    await this.apiText('/JSON/core/action/newSession/');
  }

  /** proxy session の停止: 通信の reject ではなく観測の終了 (daemon は存続)。 */
  async stopSession(): Promise<void> {
    await this.apiText('/JSON/core/action/newSession/');
  }

  /**
   * 傍受した通信の観測 (F03 と同じ messages API・cursor は start offset)。
   * requestHeader の先頭行から method・URL を解釈する。
   */
  async observeMessages(cursor: number, count: number): Promise<{ readonly messages: readonly ObservedProxyMessage[]; readonly nextCursor: number }> {
    const body = await this.apiText('/JSON/core/view/messages', { start: String(cursor), count: String(count) });
    const parsed = JSON.parse(body) as { messages: readonly ZapMessageSummary[] };
    const messages = parsed.messages.map((message) => {
      const firstLine = (message.requestHeader ?? '').split('\r\n', 1)[0] ?? '';
      const parts = firstLine.split(' ');
      const method = message.method ?? parts[0] ?? 'GET';
      const url = message.url ?? parts[1] ?? '';
      return {
        messageReference: `zap-${String(message.id)}`,
        method,
        url,
        direction: message.direction === 'OUT' ? ('sent' as const) : ('received' as const),
      } satisfies ObservedProxyMessage;
    });
    return {
      messages,
      nextCursor: parsed.messages.length < count ? cursor : cursor + parsed.messages.length,
    };
  }

  /**
   * ZAP が生成した HTTPS 記録用 root CA 証明書 (公開部のみ)。応答は PEM。
   * private key material は含まれないことを呼出側で検証する。
   */
  async rootCaCertificate(): Promise<{ readonly pem: string; readonly sha256Fingerprint: string }> {
    const pem = await this.apiText('/OTHER/network/other/rootCaCert/');
    if (!pem.includes('BEGIN CERTIFICATE')) {
      throw new Error(`ZAP root CA response is not a PEM certificate: ${pem.slice(0, 80)}`);
    }
    const derBase64 = pem
      .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
      .replace(/\s+/g, '');
    const fingerprint = createHash('sha256').update(Buffer.from(derBase64, 'base64')).digest('hex');
    return { pem, sha256Fingerprint: fingerprint };
  }
}
