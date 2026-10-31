import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, test } from 'node:test';
import { NodeWebSocketTransport } from '../src/websocket-transport.ts';

function encodeText(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function attachEcho(socket: Duplex, head: Buffer, receivedAt: number[]): void {
  let buffered = head;
  const consume = (): void => {
    while (buffered.length >= 2) {
      const opcode = buffered[0]! & 0x0f;
      const masked = (buffered[1]! & 0x80) !== 0;
      let length = buffered[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      }
      const maskBytes = masked ? 4 : 0;
      if (buffered.length < offset + maskBytes + length) return;
      const mask = masked ? buffered.subarray(offset, offset + 4) : null;
      offset += maskBytes;
      const payload = Buffer.from(buffered.subarray(offset, offset + length));
      buffered = buffered.subarray(offset + length);
      if (mask !== null) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = payload[index]! ^ mask[index % 4]!;
        }
      }
      if (opcode === 0x1) {
        receivedAt.push(Date.now());
        socket.write(encodeText(`echo:${payload.toString('utf8')}`));
      } else if (opcode === 0x8) {
        socket.end(Buffer.from([0x88, 0x00]));
        return;
      }
    }
  };
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    consume();
  });
  consume();
}

async function listenEcho(
  server: Server,
  receivedAt: number[],
  receivedCookies: (string | undefined)[],
  receivedSubprotocols: (string | undefined)[],
  receivedOrigins: (string | undefined)[],
): Promise<string> {
  server.on('upgrade', (request, socket, head) => {
    receivedCookies.push(request.headers.cookie);
    receivedSubprotocols.push(request.headers['sec-websocket-protocol']);
    receivedOrigins.push(request.headers.origin);
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      'Sec-WebSocket-Protocol: scopepilot.echo',
      '',
      '',
    ].join('\r\n'));
    attachEcho(socket, head, receivedAt);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections?.();
}

describe('NodeWebSocketTransport (実 text frame 送受信)', () => {
  test('http scope URL を ws handshake へ写像し echo を受信、既定10 message/sを守る', { timeout: 10_000 }, async () => {
    const receivedAt: number[] = [];
    const receivedCookies: (string | undefined)[] = [];
    const receivedSubprotocols: (string | undefined)[] = [];
    const receivedOrigins: (string | undefined)[] = [];
    const server = createServer();
    const base = await listenEcho(server, receivedAt, receivedCookies, receivedSubprotocols, receivedOrigins);
    try {
      const frames: string[] = [];
      const transport = new NodeWebSocketTransport({ connectTimeoutMs: 2_000, responseWaitMs: 100 });
      const result = await transport.exchange({
        targetUrl: `${base}/echo`,
        messages: ['one', 'two'],
        subprotocols: ['scopepilot.echo', 'json-v2'],
        sessionCookies: [{ name: 'WS_SESSION', value: 'transport-secret', domain: '127.0.0.1', path: '/' }],
        origin: 'https://evil.example',
        onSentFrame: () => {},
        onTextFrame: (payload) => frames.push(payload),
      });
      assert.equal(result.sent, 2);
      assert.equal(result.negotiatedSubprotocol, 'scopepilot.echo');
      assert.deepEqual(frames, ['echo:one', 'echo:two']);
      assert.deepEqual(receivedCookies, ['WS_SESSION=transport-secret']);
      assert.deepEqual(receivedSubprotocols, ['scopepilot.echo, json-v2']);
      assert.deepEqual(receivedOrigins, ['https://evil.example']);
      assert.ok((receivedAt[1] ?? 0) - (receivedAt[0] ?? 0) >= 80, '既定10 message/s の間隔を守る');
    } finally {
      await close(server);
    }
  });
});
