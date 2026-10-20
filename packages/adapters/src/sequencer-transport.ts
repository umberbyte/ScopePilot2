/**
 * Sequencer の実 HTTP sample collector (design/f07)。GET を逐次送信し、各応答を
 * callback へ渡した直後に破棄する。token 原文を adapter や台帳へ保持しない。
 * sessionCookies は Core が対象URLへ適用可能と判定済みのものだけを受け取る。
 */
import * as http from 'node:http';
import * as https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { RateGovernor, type SequencerTransportPort, type SequencerTransportResponse } from '@scopepilot2/core';

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface NodeSequencerTransportOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly requestsPerSecond?: number;
}

export class NodeSequencerTransport implements SequencerTransportPort {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly requestsPerSecond: number;

  constructor(options: NodeSequencerTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.requestsPerSecond = options.requestsPerSecond ?? 2;
    if (!Number.isFinite(this.requestsPerSecond) || this.requestsPerSecond <= 0) {
      throw new Error('sequencer requestsPerSecond must be positive');
    }
  }

  async collect(input: Parameters<SequencerTransportPort['collect']>[0]): Promise<void> {
    const target = new URL(input.targetUrl);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`sequencer transport unsupported protocol: ${target.protocol}`);
    }
    const governor = new RateGovernor(this.requestsPerSecond);
    for (let index = 0; index < input.samples; index += 1) {
      input.signal?.throwIfAborted();
      const waitMs = governor.tryAcquire(Date.now());
      if (waitMs > 0) {
        await delay(waitMs, undefined, input.signal === undefined ? undefined : { signal: input.signal });
      }
      input.signal?.throwIfAborted();
      input.onResponse(await this.requestOnce(target, input.sessionCookies, input.signal));
    }
  }

  private async requestOnce(
    target: URL,
    sessionCookies: Parameters<SequencerTransportPort['collect']>[0]['sessionCookies'],
    signal: AbortSignal | undefined,
  ): Promise<SequencerTransportResponse> {
    const requestUrl = target.toString();
    const client = target.protocol === 'https:' ? https : http;
    const cookieHeader = sessionCookies === undefined || sessionCookies.length === 0
      ? undefined
      : sessionCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    return await new Promise<SequencerTransportResponse>((resolve, reject) => {
      const request = client.request(
        {
          hostname: target.hostname,
          port: target.port === '' ? undefined : Number(target.port),
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          headers: { Host: target.host, ...(cookieHeader === undefined ? {} : { Cookie: cookieHeader }) },
          setHost: false,
          ...(signal === undefined ? {} : { signal }),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let total = 0;
          let rejectedForSize = false;
          response.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > this.maxResponseBytes) {
              rejectedForSize = true;
              response.destroy(new Error(`sequencer response exceeds ${this.maxResponseBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (rejectedForSize) {
              return;
            }
            const rawContentType = response.headers['content-type'];
            const setCookieHeaders = response.headers['set-cookie'];
            const rawAuthorization = response.headers.authorization;
            const authorizationHeader = Array.isArray(rawAuthorization) ? rawAuthorization[0] : rawAuthorization;
            resolve({
              requestUrl,
              status: response.statusCode ?? 0,
              contentType: Array.isArray(rawContentType) ? rawContentType[0] ?? '' : rawContentType ?? '',
              body: Buffer.concat(chunks).toString('utf8'),
              ...(setCookieHeaders === undefined ? {} : { setCookieHeaders }),
              ...(authorizationHeader === undefined ? {} : { authorizationHeader }),
            });
          });
          response.on('error', reject);
        },
      );
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error('sequencer transport timeout'));
      });
      request.on('error', reject);
      request.end();
    });
  }
}
