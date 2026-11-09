/**
 * Repeater の実 HTTP transport (design/f04)。node:http/https で対象へ直接送信する。
 * - 要求は draft の requestBytes (canonical) を先頭行 (method) と header 行に分解し、
 *   host は targetUrl 由来で上書きする (Host header 偽装を避ける)。
 * - redirect は自動追従しない — Location を収集して core の runRedirects
 *   (scope 再評価・F04-UT-004) に渡すため。
 * - sessionCookies は applicableSessionCookies 済みのものだけを受け取り
 *   Cookie header として 1 つに結合する (値はここを通過するだけで保存しない)。
 * - timeout は応答なし attempt として Error (message に 'timeout') を出す
 *   (F04-UT-007 の呼出側分類に合わせる)。
 */
import * as http from 'node:http';
import * as https from 'node:https';
import type { RepeaterTransportPort, RepeaterTransportResponse } from '@scopepilot2/core';

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export interface NodeRepeaterTransportOptions {
  readonly timeoutMs?: number;
}

interface ParsedRequest {
  readonly method: string;
  readonly headerLines: readonly string[];
  readonly body: string;
}

/**
 * requestBytes (domain の canonical 形式: LF 区切り) を分解する。
 */
function parseCanonicalRequest(requestBytes: string): ParsedRequest {
  const separator = requestBytes.indexOf('\n\n');
  const head = separator === -1 ? requestBytes : requestBytes.slice(0, separator);
  const body = separator === -1 ? '' : requestBytes.slice(separator + 2);
  const lines = head.split('\n');
  const firstParts = (lines[0] ?? '').split(' ');
  // domain の canonical 先頭行は「<path> HTTP/1.1」で method を含まないため
  // 既定 GET。3 token の場合は「<method> <path> HTTP/1.1」拡張として解釈する。
  const method = firstParts.length >= 3 ? firstParts[0]! : 'GET';
  return { method, headerLines: lines.slice(1).filter((line) => line !== ''), body };
}

export class NodeRepeaterTransport implements RepeaterTransportPort {
  readonly adapterKind = 'real' as const;
  readonly version = `node:${process.versions.node}`;
  private readonly timeoutMs: number;

  constructor(options: NodeRepeaterTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async send(input: {
    readonly targetUrl: string;
    readonly requestBytes: string;
    readonly sessionCookies?: readonly { readonly name: string; readonly value: string; readonly domain: string; readonly path: string }[];
  }): Promise<RepeaterTransportResponse> {
    const target = new URL(input.targetUrl);
    const parsed = parseCanonicalRequest(input.requestBytes);
    const headers: Record<string, string> = {};
    let cookieHeader: string | undefined;
    for (const line of parsed.headerLines) {
      const separator = line.indexOf(':');
      if (separator === -1) {
        continue;
      }
      const name = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (name.toLowerCase() === 'host' || name.toLowerCase() === 'cookie') {
        continue;
      }
      headers[name] = value;
    }
    if (input.sessionCookies !== undefined && input.sessionCookies.length > 0) {
      cookieHeader = input.sessionCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    }
    if (parsed.body !== '') {
      headers['Content-Length'] = String(Buffer.byteLength(parsed.body, 'utf8'));
    }

    const client = target.protocol === 'https:' ? https : http;
    return await new Promise<RepeaterTransportResponse>((resolve, reject) => {
      const request = client.request(
        {
          hostname: target.hostname,
          port: target.port === '' ? undefined : Number(target.port),
          method: parsed.method,
          path: `${target.pathname}${target.search}`,
          headers: {
            ...headers,
            // Host は送信先から組み立てる (header 偽装を許さない)。
            Host: target.host,
            ...(cookieHeader === undefined ? {} : { Cookie: cookieHeader }),
          },
          setHost: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let total = 0;
          response.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total <= MAX_RESPONSE_BYTES) {
              chunks.push(chunk);
            }
          });
          response.on('end', () => {
            const responseHeaders: [string, string][] = [];
            const redirectLocations: string[] = [];
            for (const [name, value] of Object.entries(response.headers)) {
              if (value === undefined) {
                continue;
              }
              for (const entry of Array.isArray(value) ? value : [value]) {
                responseHeaders.push([name, entry]);
                if (name.toLowerCase() === 'location') {
                  // 相対 Location は要求 URL を基準に解決してから渡す
                  // (core の scope 判定は絶対 URL を要求する)。
                  redirectLocations.push(new URL(entry, input.targetUrl).toString());
                }
              }
            }
            resolve({
              status: response.statusCode ?? 0,
              headers: responseHeaders,
              body: Buffer.concat(chunks),
              redirectLocations,
            });
          });
          response.on('error', reject);
        },
      );
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error('repeater transport timeout'));
      });
      request.on('error', reject);
      if (parsed.body !== '') {
        request.write(parsed.body);
      }
      request.end();
    });
  }
}
