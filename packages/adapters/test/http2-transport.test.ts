import assert from 'node:assert/strict';
import { createServer as createHttp1Server, type Server as Http1Server } from 'node:http';
import { createServer as createHttp2Server, type Http2Server } from 'node:http2';
import { describe, test } from 'node:test';
import { NodeHttp2Transport } from '../src/http2-transport.ts';

async function listen(server: Http1Server | Http2Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected TCP server address');
  }
  return address.port;
}

async function close(server: Http1Server | Http2Server): Promise<void> {
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
      const result = await transport.probe({ targetUrl: `http://127.0.0.1:${port}/probe?x=1`, allowFallback: false });
      assert.deepEqual(result.offered, ['h2']);
      assert.equal(result.alpn, 'h2c');
      assert.match(result.runtime, /^node \S+ \(node:http2\)$/);
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
      const unavailable = await transport.probe({ targetUrl: `http://127.0.0.1:${port}/probe`, allowFallback: false });
      assert.deepEqual(unavailable.offered, ['http/1.1']);
      assert.equal(requests, 0);

      const fallback = await transport.probe({ targetUrl: `http://127.0.0.1:${port}/probe`, allowFallback: true });
      assert.deepEqual(fallback.offered, ['http/1.1']);
      assert.equal(requests, 1);
    } finally {
      await close(server);
    }
  });
});
