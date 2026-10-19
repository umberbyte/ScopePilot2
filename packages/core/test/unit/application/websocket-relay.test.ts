import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
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
});
