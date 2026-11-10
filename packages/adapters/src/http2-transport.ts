/** Real HTTP/2 capability/request probe backed by node:http2 (design/f15). */
import * as http from 'node:http';
import * as http2 from 'node:http2';
import * as https from 'node:https';
import * as tls from 'node:tls';
import type { ClientHttp2Session } from 'node:http2';
import type { SecureContextOptions, TLSSocket } from 'node:tls';
import type { AdvancedTransportPort, TransportProbeResponseEvidence } from '@scopepilot2/core';

const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

export interface NodeHttp2TransportOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Optional explicit trust anchor for an owned target or test fixture. Certificate checks remain enabled. */
  readonly trustedCa?: SecureContextOptions['ca'];
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
  readonly adapterKind = 'real' as const;
  readonly version = `node:${process.versions.node}`;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly trustedCa: SecureContextOptions['ca'];

  constructor(options: NodeHttp2TransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.trustedCa = options.trustedCa;
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
    if (input.requested === 'http/1.1') {
      const h1 = await this.requestHttp1(target);
      return { offered: ['http/1.1'], alpn: h1.alpn, runtime, response: h1.response };
    }
    const h2 = target.protocol === 'https:'
      ? await this.tryTlsHttp2(target)
      : await this.tryCleartextHttp2(target);
    if (h2.available) {
      return { offered: ['h2'], alpn: h2.alpn, runtime, response: h2.response };
    }
    if (input.allowFallback) {
      const h1 = await this.requestHttp1(target);
      return { offered: ['http/1.1'], alpn: h2.alpn, runtime, response: h1.response };
    }
    return { offered: ['http/1.1'], alpn: h2.alpn, runtime };
  }

  private async tryCleartextHttp2(target: URL): Promise<{ available: true; alpn: string; response: TransportProbeResponseEvidence } | { available: false; alpn: string }> {
    try {
      const response = await this.requestHttp2(target);
      return { available: true, alpn: 'h2c', response };
    } catch (cause) {
      if (isProtocolUnavailable(cause)) {
        return { available: false, alpn: 'h2c-unavailable' };
      }
      throw cause;
    }
  }

  private async tryTlsHttp2(target: URL): Promise<{ available: true; alpn: string; response: TransportProbeResponseEvidence } | { available: false; alpn: string }> {
    const socket = await this.connectTls(target);
    const alpn = socket.alpnProtocol || 'none';
    if (socket.alpnProtocol !== 'h2') {
      socket.destroy();
      return { available: false, alpn };
    }
    try {
      const response = await this.requestHttp2(target, socket);
      return { available: true, alpn, response };
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
        ...(this.trustedCa === undefined ? {} : { ca: this.trustedCa }),
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

  private async requestHttp2(target: URL, tlsSocket?: TLSSocket): Promise<TransportProbeResponseEvidence> {
    const origin = target.origin;
    const session = http2.connect(origin, tlsSocket === undefined ? {} : { createConnection: () => tlsSocket });
    const startedAt = process.hrtime.bigint();
    return await new Promise<TransportProbeResponseEvidence>((resolve, reject) => {
      let settled = false;
      let responseStarted = false;
      let statusCode: number | undefined;
      let total = 0;
      let stream: ReturnType<ClientHttp2Session['request']> | undefined;
      const timer = setTimeout(() => finish(new Error(`HTTP/2 request timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
      const finish = (cause?: unknown, response?: TransportProbeResponseEvidence): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (cause === undefined && response !== undefined) {
          resolve(response);
        } else {
          reject(cause ?? new Error('HTTP/2 response evidence was unavailable'));
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
        stream.once('response', (headers) => {
          const measuredStatus = headers[':status'];
          if (typeof measuredStatus !== 'number') {
            finish(new Error('HTTP/2 response did not include a numeric :status'));
            return;
          }
          responseStarted = true;
          statusCode = measuredStatus;
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
          if (statusCode === undefined) {
            finish(new Error('HTTP/2 response status was unavailable'));
            return;
          }
          const settings = session.remoteSettings;
          const streamId = stream?.id;
          finish(undefined, {
            statusCode,
            elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
            ...(typeof streamId === 'number' ? { streamId } : {}),
            remoteSettings: {
              ...(settings.headerTableSize === undefined ? {} : { headerTableSize: settings.headerTableSize }),
              ...(settings.enablePush === undefined ? {} : { enablePush: settings.enablePush }),
              ...(settings.initialWindowSize === undefined ? {} : { initialWindowSize: settings.initialWindowSize }),
              ...(settings.maxFrameSize === undefined ? {} : { maxFrameSize: settings.maxFrameSize }),
              ...(settings.maxConcurrentStreams === undefined ? {} : { maxConcurrentStreams: settings.maxConcurrentStreams }),
              ...(settings.maxHeaderListSize === undefined ? {} : { maxHeaderListSize: settings.maxHeaderListSize }),
            },
          });
        });
        stream.once('error', finish);
        stream.end();
      } catch (cause) {
        finish(cause);
      }
    });
  }

  private async requestHttp1(target: URL): Promise<{ readonly alpn: string; readonly response: TransportProbeResponseEvidence }> {
    const client = target.protocol === 'https:' ? https : http;
    const startedAt = process.hrtime.bigint();
    return await new Promise<{ readonly alpn: string; readonly response: TransportProbeResponseEvidence }>((resolve, reject) => {
      const request = client.request(target, {
        method: 'GET',
        headers: { Connection: 'close' },
        ...(target.protocol === 'https:' ? { ALPNProtocols: ['http/1.1'] } : {}),
        ...(target.protocol === 'https:' && this.trustedCa !== undefined ? { ca: this.trustedCa } : {}),
      }, (response) => {
        let total = 0;
        const statusCode = response.statusCode;
        if (statusCode === undefined) {
          request.destroy(new Error('HTTP/1.1 response status was unavailable'));
          return;
        }
        const alpn = target.protocol === 'https:'
          ? (response.socket as TLSSocket).alpnProtocol || 'none'
          : 'http/1.1 (cleartext)';
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > this.maxResponseBytes) {
            request.destroy(new Error(`HTTP/1.1 response exceeds ${this.maxResponseBytes} bytes`));
          }
        });
        response.once('end', () => resolve({
          alpn,
          response: {
            statusCode,
            elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
          },
        }));
        response.once('error', reject);
      });
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error(`HTTP/1.1 request timeout after ${this.timeoutMs}ms`)));
      request.once('error', reject);
      request.end();
    });
  }
}
