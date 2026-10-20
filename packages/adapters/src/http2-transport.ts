/** Real HTTP/2 capability/request probe backed by node:http2 (design/f15). */
import * as http from 'node:http';
import * as http2 from 'node:http2';
import * as https from 'node:https';
import * as tls from 'node:tls';
import type { ClientHttp2Session } from 'node:http2';
import type { TLSSocket } from 'node:tls';
import type { AdvancedTransportPort } from '@scopepilot2/core';

const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

export interface NodeHttp2TransportOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

class Http2UnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'Http2UnavailableError';
  }
}

function isProtocolUnavailable(cause: unknown): boolean {
  if (cause instanceof Http2UnavailableError) {
    return true;
  }
  const code = (cause as { code?: unknown } | null)?.code;
  return code === 'ERR_HTTP2_ERROR' || code === 'ERR_HTTP2_SESSION_ERROR';
}

export class NodeHttp2Transport implements AdvancedTransportPort {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: NodeHttp2TransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('HTTP/2 timeoutMs must be a positive integer');
    }
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new Error('HTTP/2 maxResponseBytes must be a positive integer');
    }
  }

  async probe(input: Parameters<AdvancedTransportPort['probe']>[0]): ReturnType<AdvancedTransportPort['probe']> {
    const target = new URL(input.targetUrl);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`HTTP/2 transport unsupported protocol: ${target.protocol}`);
    }

    const runtime = `node ${process.versions.node} (node:http2)`;
    const h2 = target.protocol === 'https:'
      ? await this.tryTlsHttp2(target)
      : await this.tryCleartextHttp2(target);
    if (h2.available) {
      return { offered: ['h2'], alpn: h2.alpn, runtime };
    }
    if (input.allowFallback) {
      await this.requestHttp1(target);
    }
    return { offered: ['http/1.1'], alpn: h2.alpn, runtime };
  }

  private async tryCleartextHttp2(target: URL): Promise<{ available: boolean; alpn: string }> {
    try {
      await this.requestHttp2(target);
      return { available: true, alpn: 'h2c' };
    } catch (cause) {
      if (isProtocolUnavailable(cause)) {
        return { available: false, alpn: 'h2c-unavailable' };
      }
      throw cause;
    }
  }

  private async tryTlsHttp2(target: URL): Promise<{ available: boolean; alpn: string }> {
    const socket = await this.connectTls(target);
    const alpn = socket.alpnProtocol || 'none';
    if (socket.alpnProtocol !== 'h2') {
      socket.destroy();
      return { available: false, alpn };
    }
    try {
      await this.requestHttp2(target, socket);
      return { available: true, alpn };
    } catch (cause) {
      if (isProtocolUnavailable(cause)) {
        return { available: false, alpn };
      }
      throw cause;
    }
  }

  private async connectTls(target: URL): Promise<TLSSocket> {
    return await new Promise<TLSSocket>((resolve, reject) => {
      const socket = tls.connect({
        host: target.hostname,
        port: target.port === '' ? 443 : Number(target.port),
        servername: target.hostname,
        ALPNProtocols: ['h2', 'http/1.1'],
      });
      const timer = setTimeout(() => {
        socket.destroy(new Error(`HTTP/2 TLS negotiation timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const cleanup = (): void => clearTimeout(timer);
      socket.once('secureConnect', () => {
        cleanup();
        resolve(socket);
      });
      socket.once('error', (cause) => {
        cleanup();
        reject(cause);
      });
    });
  }

  private async requestHttp2(target: URL, tlsSocket?: TLSSocket): Promise<void> {
    const origin = target.origin;
    const session = http2.connect(origin, tlsSocket === undefined ? {} : { createConnection: () => tlsSocket });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let responseStarted = false;
      let total = 0;
      let stream: ReturnType<ClientHttp2Session['request']> | undefined;
      const timer = setTimeout(() => finish(new Error(`HTTP/2 request timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
      const finish = (cause?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (cause === undefined) {
          resolve();
        } else {
          reject(cause);
        }
        stream?.close();
        session.destroy();
      };
      session.once('error', finish);
      session.once('goaway', (errorCode, lastStreamId) => {
        if (!responseStarted) {
          finish(new Error(`HTTP/2 GOAWAY before response (errorCode=${errorCode}, lastStreamId=${lastStreamId})`));
        }
      });
      try {
        stream = session.request({
          ':method': 'GET',
          ':scheme': target.protocol.slice(0, -1),
          ':authority': target.host,
          ':path': `${target.pathname}${target.search}`,
        });
        stream.once('response', () => {
          responseStarted = true;
        });
        stream.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > this.maxResponseBytes) {
            finish(new Error(`HTTP/2 response exceeds ${this.maxResponseBytes} bytes`));
          }
        });
        stream.once('end', () => {
          if (!responseStarted) {
            finish(new Http2UnavailableError('HTTP/2 stream ended before response headers'));
            return;
          }
          finish();
        });
        stream.once('error', finish);
        stream.end();
      } catch (cause) {
        finish(cause);
      }
    });
  }

  private async requestHttp1(target: URL): Promise<void> {
    const client = target.protocol === 'https:' ? https : http;
    await new Promise<void>((resolve, reject) => {
      const request = client.request(target, { method: 'GET', headers: { Connection: 'close' } }, (response) => {
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > this.maxResponseBytes) {
            request.destroy(new Error(`HTTP/1.1 response exceeds ${this.maxResponseBytes} bytes`));
          }
        });
        response.once('end', resolve);
        response.once('error', reject);
      });
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error(`HTTP/1.1 request timeout after ${this.timeoutMs}ms`)));
      request.once('error', reject);
      request.end();
    });
  }
}
