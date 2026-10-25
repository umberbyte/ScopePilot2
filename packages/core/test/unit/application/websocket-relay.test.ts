import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoginExecutorPort, LoginSessionCookie, WebSocketTransportPort } from '@scopepilot2/core';
import { bootstrapFlow } from '../support/test-flow.ts';

/** WebSocket の service 経路 (design/f14)。text のみ・重複 dedupe・上限で adapter 前に拒否。 */
describe('websocket (service)', () => {
  test('frame を取り込み (重複は dedupe)・送信は frame 台帳へ sent として残る', async () => {
    const { service, operator } = await bootstrapFlow();
    const first = service.importWsFrames(operator, {
      targetUrl: 'http://fixture.target.test/ws',
      frames: [
        { direction: 'received', payload: 'hello' },
        { direction: 'received', payload: 'hello' },
        { direction: 'sent', payload: 'hello' },
      ],
    });
    assert.deepEqual(first, { imported: 2, duplicates: 1 }, '同方向同内容のみ重複 (方向違いは別 frame)');

    const resent = service.importWsFrames(operator, {
      targetUrl: 'http://fixture.target.test/ws',
      frames: [{ direction: 'received', payload: 'hello' }],
    });
    assert.deepEqual(resent, { imported: 0, duplicates: 1 }, '持越し fingerprint でも dedupe');

    const sent = await service.sendWsMessages(operator, { targetUrl: 'http://fixture.target.test/ws', messages: ['ping', 'pong'] });
    assert.equal(sent.sent, 2);
    assert.equal(sent.rejected, null);
    assert.match(sent.planHash, /^[0-9a-f]{64}$/);

    const frames = service.listWsFrames();
    assert.equal(frames.length, 4);
    assert.ok(frames.some((frame) => frame.direction === 'sent' && frame.text === 'ping'));
    assert.ok(frames.every((frame) => frame.rawHash.length === 12), 'raw hash と text を区別した表示素材');

    const eventsText = JSON.stringify(service.events());
    assert.ok(eventsText.includes('WsFramesImported'));
    assert.ok(eventsText.includes('WsMessagesSent'));
  });

  test('上限超過 (size) は adapter を呼ばず拒否。scope 外・空入力は拒否', async () => {
    const { service, operator } = await bootstrapFlow();
    const oversized = await service.sendWsMessages(operator, {
      targetUrl: 'http://fixture.target.test/ws',
      messages: ['a'.repeat(1_000_001)],
    });
    assert.equal(oversized.sent, 0);
    assert.equal(oversized.rejected, 'size');
    assert.equal(service.listWsFrames().length, 0, '拒否時は frame 台帳に残らない');

    await assert.rejects(
      service.sendWsMessages(operator, { targetUrl: 'http://elsewhere.example/ws', messages: ['x'] }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'OutOfScope');
        return true;
      },
    );
    assert.throws(
      () => service.importWsFrames(operator, { targetUrl: 'http://fixture.target.test/ws', frames: [] }),
      /at least one frame/,
    );
  });

  test('実 transport の送信数と受信 text frame を台帳へ反映する', async () => {
    let calls = 0;
    const { service, operator } = await bootstrapFlow({
      webSocketTransport: {
        async exchange(input) {
          calls += 1;
          for (const message of input.messages) {
            input.onSentFrame(message);
            input.onTextFrame(`echo:${message}`);
          }
          return { sent: input.messages.length };
        },
      },
    });
    const result = await service.sendWsMessages(operator, {
      targetUrl: 'http://fixture.target.test/ws',
      messages: ['one', 'two'],
    });
    assert.match(result.planHash, /^[0-9a-f]{64}$/);
    assert.equal(result.sent, 2);
    assert.equal(result.rejected, null);
    assert.equal(calls, 1);
    assert.deepEqual(
      service.listWsFrames().map((frame) => [frame.direction, frame.text]),
      [['sent', 'one'], ['received', 'echo:one'], ['sent', 'two'], ['received', 'echo:two']],
    );

    const oversized = await service.sendWsMessages(operator, {
      targetUrl: 'http://fixture.target.test/ws',
      messages: ['x'.repeat(1_000_001)],
    });
    assert.equal(oversized.rejected, 'size');
    assert.equal(calls, 1, 'size 超過は接続前に拒否する');
  });

  test('role 指定は対象URLに適用可能なcookieだけをhandshakeへ渡し、値を保存しない', async () => {
    const transportCalls: Parameters<WebSocketTransportPort['exchange']>[0][] = [];
    const webSocketTransport: WebSocketTransportPort = {
      async exchange(input) {
        transportCalls.push(input);
        for (const message of input.messages) {
          input.onSentFrame(message);
          input.onTextFrame(`echo:${message}`);
        }
        const negotiatedSubprotocol = input.subprotocols?.[0];
        return {
          sent: input.messages.length,
          ...(negotiatedSubprotocol === undefined ? {} : { negotiatedSubprotocol }),
        };
      },
    };
    const cookies: readonly LoginSessionCookie[] = [
      { name: 'WS_SESSION', value: 'websocket-secret', domain: 'fixture.target.test', path: '/socket' },
      { name: 'OTHER_PATH', value: 'other-path-secret', domain: 'fixture.target.test', path: '/admin' },
      { name: 'OTHER_ORIGIN', value: 'other-origin-secret', domain: 'elsewhere.example', path: '/' },
    ];
    const loginExecutor: LoginExecutorPort = {
      engineVersion: 'fake-login-websocket-1',
      async execute() {
        return { authenticated: true, finalUrl: 'http://fixture.target.test/socket', cookies };
      },
    };
    const { service, operator } = await bootstrapFlow({ loginExecutor, webSocketTransport });
    service.registerLoginFlow(operator, {
      role: 'analyst',
      flowVersion: 'websocket-flow-1',
      steps: [
        { kind: 'navigate', target: 'http://fixture.target.test/login' },
        { kind: 'assert', target: 'Authenticated' },
      ],
    });
    await service.runLogin(operator, {
      role: 'analyst',
      baseUrl: 'http://fixture.target.test',
      secretValues: {},
      expectedUrlPrefix: 'http://fixture.target.test/socket',
    });

    const result = await service.sendWsMessages(operator, {
      targetUrl: 'http://fixture.target.test/socket/echo',
      messages: ['role-message'],
      role: 'analyst',
      subprotocols: ['scopepilot.echo', 'json-v2'],
    });
    assert.deepEqual(transportCalls[0]?.sessionCookies, [
      { name: 'WS_SESSION', value: 'websocket-secret', domain: 'fixture.target.test', path: '/socket' },
    ]);
    assert.deepEqual(result.sessionCookieNames, ['WS_SESSION']);
    assert.deepEqual(transportCalls[0]?.subprotocols, ['scopepilot.echo', 'json-v2']);
    assert.equal(result.negotiatedSubprotocol, 'scopepilot.echo');
    assert.equal(JSON.stringify(result).includes('websocket-secret'), false);
    assert.equal(JSON.stringify(service.listWsFrames()).includes('websocket-secret'), false);
    assert.equal(JSON.stringify(service.events()).includes('websocket-secret'), false);

    await assert.rejects(
      service.sendWsMessages(operator, { targetUrl: 'http://fixture.target.test/socket', messages: ['x'], role: 'missing' }),
      /no session for role/,
    );
  });
});
