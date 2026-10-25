import assert from 'node:assert/strict';
import { createServer as createHttp1Server, type Server as Http1Server } from 'node:http';
import { createServer as createHttp2Server, createSecureServer, type Http2SecureServer, type Http2Server } from 'node:http2';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { describe, test } from 'node:test';
import { NodeHttp2Transport } from '../src/http2-transport.ts';
import { selfSignedLocalhostCertificate } from './support/self-signed-certificate.ts';

async function listen(server: Http1Server | Http2Server | Http2SecureServer | HttpsServer, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected TCP server address');
  }
  return address.port;
}

async function close(server: Http1Server | Http2Server | Http2SecureServer | HttpsServer): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((cause) => cause === undefined ? resolve() : reject(cause)));
}

describe('NodeHttp2Transport', () => {
  test('sends a bounded h2c GET probe and reports the real runtime marker', async () => {
    const paths: string[] = [];
    const server = createHttp2Server();
    server.on('stream', (stream, headers) => {
      paths.push(String(headers[':path']));
      stream.respond({ ':status': 204 });
      stream.end();
    });
    const port = await listen(server);
    try {
      const transport = new NodeHttp2Transport({ timeoutMs: 2_000 });
      const result = await transport.probe({ targetUrl: `http://127.0.0.1:${port}/probe?x=1`, requested: 'h2', allowFallback: false });
      assert.deepEqual(result.offered, ['h2']);
      assert.equal(result.alpn, 'h2c');
      assert.match(result.runtime, /^node \S+ \(node:http2\)$/);
      assert.equal(result.response?.statusCode, 204);
      assert.equal(result.response?.streamId, 1);
      assert.equal(result.response?.remoteSettings?.maxFrameSize, 16_384);
      assert.ok((result.response?.elapsedMs ?? -1) >= 0);
      assert.deepEqual(paths, ['/probe?x=1']);
    } finally {
      await close(server);
    }
  });

  test('does not send HTTP/1.1 unless fallback is allowed', async () => {
    let requests = 0;
    const server = createHttp1Server((_request, response) => {
      requests += 1;
      response.writeHead(204);
      response.end();
    });
    // h2c prior-knowledge bytes are intentionally rejected as a protocol mismatch.
    server.on('clientError', (_error, socket) => socket.destroy());
    const port = await listen(server);
    try {
      const transport = new NodeHttp2Transport({ timeoutMs: 2_000 });
      const unavailable = await transport.probe({ targetUrl: `http://127.0.0.1:${port}/probe`, requested: 'h2', allowFallback: false });
      assert.deepEqual(unavailable.offered, ['http/1.1']);
      assert.equal(unavailable.response, undefined);
      assert.equal(requests, 0);

      const fallback = await transport.probe({ targetUrl: `http://127.0.0.1:${port}/probe`, requested: 'h2', allowFallback: true });
      assert.deepEqual(fallback.offered, ['http/1.1']);
      assert.equal(requests, 1);
    } finally {
      await close(server);
    }
  });

  test('explicit HTTP/1.1 sends exactly one H1 request without an H2 preface', async () => {
    let requests = 0;
    let clientErrors = 0;
    const server = createHttp1Server((_request, response) => {
      requests += 1;
      response.writeHead(204);
      response.end();
    });
    server.on('clientError', (_error, socket) => {
      clientErrors += 1;
      socket.destroy();
    });
    const port = await listen(server);
    try {
      const transport = new NodeHttp2Transport({ timeoutMs: 2_000 });
      const result = await transport.probe({
        targetUrl: `http://127.0.0.1:${port}/probe`,
        requested: 'http/1.1',
        allowFallback: false,
      });
      assert.deepEqual(result.offered, ['http/1.1']);
      assert.equal(result.alpn, 'http/1.1 (cleartext)');
      assert.equal(result.response?.statusCode, 204);
      assert.equal(result.response?.streamId, undefined);
      assert.ok((result.response?.elapsedMs ?? -1) >= 0);
      assert.equal(requests, 1);
      assert.equal(clientErrors, 0);
    } finally {
      await close(server);
    }
  });

  test('negotiates TLS ALPN h2 and explicit HTTP/1.1 against an owned trusted fixture', async () => {
    const { cert, key } = selfSignedLocalhostCertificate();
    const versions: string[] = [];
    const paths: string[] = [];
    const server = createSecureServer({ cert, key, allowHTTP1: true }, (request, response) => {
      versions.push(request.httpVersion);
      paths.push(request.url ?? '');
      response.writeHead(204);
      response.end();
    });
    const port = await listen(server, 'localhost');
    try {
      const untrustedTransport = new NodeHttp2Transport({ timeoutMs: 2_000 });
      await assert.rejects(
        () => untrustedTransport.probe({
          targetUrl: `https://localhost:${port}/untrusted`,
          requested: 'h2',
          allowFallback: false,
        }),
        (cause: unknown) => {
          assert.equal((cause as { code?: string }).code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
          return true;
        },
      );

      const transport = new NodeHttp2Transport({ timeoutMs: 2_000, trustedCa: cert });
      const h2 = await transport.probe({
        targetUrl: `https://localhost:${port}/h2?x=1`,
        requested: 'h2',
        allowFallback: false,
      });
      assert.deepEqual(h2.offered, ['h2']);
      assert.equal(h2.alpn, 'h2');
      assert.equal(h2.response?.statusCode, 204);
      assert.equal(h2.response?.streamId, 1);
      assert.equal(h2.response?.remoteSettings?.maxFrameSize, 16_384);

      const h1 = await transport.probe({
        targetUrl: `https://localhost:${port}/h1`,
        requested: 'http/1.1',
        allowFallback: false,
      });
      assert.deepEqual(h1.offered, ['http/1.1']);
      assert.equal(h1.alpn, 'http/1.1');
      assert.equal(h1.response?.statusCode, 204);
      assert.equal(h1.response?.streamId, undefined);
      assert.deepEqual(versions, ['2.0', '1.1']);
      assert.deepEqual(paths, ['/h2?x=1', '/h1']);
    } finally {
      await close(server);
    }
  });

  test('TLS ALPN downgrade sends an H1 request only when fallback is allowed', async () => {
    const { cert, key } = selfSignedLocalhostCertificate();
    let requests = 0;
    const server = createHttpsServer({ cert, key }, (_request, response) => {
      requests += 1;
      response.writeHead(204);
      response.end();
    });
    const port = await listen(server, 'localhost');
    try {
      const transport = new NodeHttp2Transport({ timeoutMs: 2_000, trustedCa: cert });
      const unavailable = await transport.probe({
        targetUrl: `https://localhost:${port}/probe`,
        requested: 'h2',
        allowFallback: false,
      });
      assert.deepEqual(unavailable.offered, ['http/1.1']);
      assert.equal(unavailable.alpn, 'http/1.1');
      assert.equal(unavailable.response, undefined);
      assert.equal(requests, 0);

      const fallback = await transport.probe({
        targetUrl: `https://localhost:${port}/probe`,
        requested: 'h2',
        allowFallback: true,
      });
      assert.deepEqual(fallback.offered, ['http/1.1']);
      assert.equal(fallback.alpn, 'http/1.1');
      assert.equal(fallback.response?.statusCode, 204);
      assert.equal(requests, 1);
    } finally {
      await close(server);
    }
  });
});
