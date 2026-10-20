/** Node 24 built-in WebSocket client による text message 実送受信 (design/f14)。 */
import { RateGovernor, type WebSocketTransportPort } from '@scopepilot2/core';

const DEFAULT_MAX_MESSAGE_BYTES = 1_000_000;

export interface NodeWebSocketTransportOptions {
  readonly connectTimeoutMs?: number;
  readonly responseWaitMs?: number;
  readonly messagesPerSecond?: number;
  readonly maxMessageBytes?: number;
}

function websocketUrl(targetUrl: string): string {
  const parsed = new URL(targetUrl);
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'ws:';
  } else if (parsed.protocol === 'https:') {
    parsed.protocol = 'wss:';
  } else {
    throw new Error(`WebSocket transport unsupported protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Node 24 accepts an Undici WebSocketInit with handshake headers; lib.dom exposes only the standard overload. */
const NodeWebSocket = WebSocket as unknown as new (
  url: string,
  options?: { readonly protocols?: string | string[]; readonly headers?: Readonly<Record<string, string>> },
) => WebSocket;

export class NodeWebSocketTransport implements WebSocketTransportPort {
  private readonly connectTimeoutMs: number;
  private readonly responseWaitMs: number;
  private readonly messagesPerSecond: number;
  private readonly maxMessageBytes: number;

  constructor(options: NodeWebSocketTransportOptions = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.responseWaitMs = options.responseWaitMs ?? 500;
    this.messagesPerSecond = options.messagesPerSecond ?? 10;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    if (!Number.isFinite(this.messagesPerSecond) || this.messagesPerSecond <= 0) {
      throw new Error('WebSocket messagesPerSecond must be positive');
    }
  }

  async exchange(input: Parameters<WebSocketTransportPort['exchange']>[0]): Promise<{ readonly sent: number; readonly negotiatedSubprotocol?: string }> {
    const cookieHeader = input.sessionCookies === undefined || input.sessionCookies.length === 0
      ? undefined
      : input.sessionCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const socket = new NodeWebSocket(
      websocketUrl(input.targetUrl),
      input.subprotocols === undefined && cookieHeader === undefined
        ? undefined
        : {
            ...(input.subprotocols === undefined ? {} : { protocols: [...input.subprotocols] }),
            ...(cookieHeader === undefined ? {} : { headers: { Cookie: cookieHeader } }),
          },
    );
    let connectionError: Error | null = null;
    let closed = false;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        return; // 初期能力は text frame のみ。binary を暗黙変換しない。
      }
      if (Buffer.byteLength(event.data, 'utf8') > this.maxMessageBytes) {
        connectionError = new Error(`WebSocket text frame exceeds ${this.maxMessageBytes} bytes`);
        socket.close(1009, 'message too large');
        return;
      }
      input.onTextFrame(event.data);
    });
    socket.addEventListener('error', () => {
      connectionError ??= new Error('WebSocket connection failed');
    });
    socket.addEventListener('close', () => {
      closed = true;
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`WebSocket connection timeout after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(connectionError ?? new Error('WebSocket connection failed'));
      }, { once: true });
    });

    const governor = new RateGovernor(this.messagesPerSecond);
    let sent = 0;
    try {
      for (const message of input.messages) {
        if (Buffer.byteLength(message, 'utf8') > this.maxMessageBytes) {
          throw new Error(`WebSocket text frame exceeds ${this.maxMessageBytes} bytes`);
        }
        if (closed || connectionError !== null) {
          throw connectionError ?? new Error('WebSocket connection closed before all messages were sent');
        }
        const waitMs = governor.tryAcquire(Date.now());
        if (waitMs > 0) {
          await delay(waitMs);
        }
        socket.send(message);
        input.onSentFrame(message);
        sent += 1;
      }
      await delay(this.responseWaitMs);
      if (connectionError !== null) {
        throw connectionError;
      }
      return { sent, ...(socket.protocol === '' ? {} : { negotiatedSubprotocol: socket.protocol }) };
    } finally {
      if (!closed) {
        socket.close(1000, 'complete');
      }
    }
  }
}
