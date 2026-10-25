/**
 * Fuzzer の実 HTTP transport (design/f05)。現行の product/API 契約では position は
 * name/value の組なので、各組合せを target URL の query parameter へ適用して GET する。
 *
 * - redirect は自動追従しない（ZAP sendRequest 基準経路と同じく followRedirects 無効）。
 * - sessionCookies は core で対象 URL に適用可能と判定済みのものだけを受け取る。
 * - 応答本文は保存せず、cluster 集約に必要な byte length と SHA-256 だけを streaming 算出する。
 * - response 上限超過と timeout は成功応答として扱わない。
 */
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { FuzzTransportPort, FuzzTransportResponse } from '@scopepilot2/core';

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export interface NodeFuzzTransportOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class NodeFuzzTransport implements FuzzTransportPort {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: NodeFuzzTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async send(input: Parameters<FuzzTransportPort['send']>[0]): Promise<FuzzTransportResponse> {
    if (input.combination.length !== input.positions.length) {
      throw new Error('fuzz transport combination/position length mismatch');
    }
    const target = new URL(input.targetUrl);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`fuzz transport unsupported protocol: ${target.protocol}`);
    }
    const seenNames = new Set<string>();
    input.positions.forEach((position, index) => {
      const name = position.name.trim();
      if (name === '') {
        throw new Error('fuzz transport position name is required');
      }
      if (seenNames.has(name)) {
        throw new Error(`fuzz transport duplicate position name: ${name}`);
      }
      seenNames.add(name);
      target.searchParams.set(name, input.combination[index] ?? '');
    });

    const requestUrl = target.toString();
    const cookieHeader = input.sessionCookies === undefined || input.sessionCookies.length === 0
      ? undefined
      : input.sessionCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const client = target.protocol === 'https:' ? https : http;

    return await new Promise<FuzzTransportResponse>((resolve, reject) => {
      const request = client.request(
        {
          hostname: target.hostname,
          port: target.port === '' ? undefined : Number(target.port),
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          headers: {
            Host: target.host,
            ...(cookieHeader === undefined ? {} : { Cookie: cookieHeader }),
          },
          setHost: false,
        },
        (response) => {
          const hash = createHash('sha256');
          let contentLength = 0;
          let rejectedForSize = false;
          response.on('data', (chunk: Buffer) => {
            contentLength += chunk.length;
            if (contentLength > this.maxResponseBytes) {
              rejectedForSize = true;
              response.destroy(new Error(`fuzz transport response exceeds ${this.maxResponseBytes} bytes`));
              return;
            }
            hash.update(chunk);
          });
          response.on('end', () => {
            if (rejectedForSize) {
              return;
            }
            const rawContentType = response.headers['content-type'];
            resolve({
              requestUrl,
              status: response.statusCode ?? 0,
              contentType: Array.isArray(rawContentType) ? rawContentType[0] ?? '' : rawContentType ?? '',
              contentLength,
              bodyHash: hash.digest('hex'),
            });
          });
          response.on('error', reject);
        },
      );
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error('fuzz transport timeout'));
      });
      request.on('error', reject);
      request.end();
    });
  }
}
