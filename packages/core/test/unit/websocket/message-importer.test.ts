import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildWsSendPlan, decodeWsText, importFrames, sendWithPolicy, wsConfirmationValid, wsEvidence, type WsFrame } from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

const frame = (frameId: string, payload: string): WsFrame => ({ frameId, direction: 'received', payload, receivedAtMs: 0 });

describe('WebSocket', () => {
  test('[F14-UT-001] 同一 frame の再取込は dedupe する', () => {
    const result = importFrames([frame('f1', 'hello'), frame('f2', 'world'), frame('f1', 'hello')]);
    assert.equal(result.imported.length, 2);
    assert.equal(result.duplicates, 1);
  });

  test('[F14-UT-002] text message は hash 付き plan を作る', () => {
    const plan = buildWsSendPlan({ targetUrl: 'ws://fixture.target.test/ws', messages: [{ kind: 'text', payload: 'ping' }], sessionRevision: 3 });
    assert.match(plan.planHash, /^[0-9a-f]{64}$/);
    assert.equal(plan.messageBudget, 1);
    assert.equal(plan.sessionRevision, 3);
  });

  test('[F14-UT-003] binary message は Unsupported とする', () => {
    assert.throws(
      () => buildWsSendPlan({ targetUrl: 'ws://x/ws', messages: [{ kind: 'binary', payload: '00ff' }], sessionRevision: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'Unsupported');
        return true;
      },
    );
  });

  test('[F14-UT-004] session revision 変更で confirmation は無効になる', () => {
    const plan = buildWsSendPlan({ targetUrl: 'ws://x/ws', messages: [{ kind: 'text', payload: 'p' }], sessionRevision: 2 });
    assert.equal(wsConfirmationValid(plan, 2), true);
    assert.equal(wsConfirmationValid(plan, 3), false);
  });

  test('[F14-UT-005] invalid UTF-8 は暗黙置換せず error にする', () => {
    assert.throws(() => decodeWsText(Buffer.from([0xff, 0xfe, 0x80])));
    assert.equal(decodeWsText(Buffer.from('こんにちは')), 'こんにちは');
  });

  test('[F14-UT-006] rate/size 超過は adapter を呼ばない', async () => {
    const sent: string[] = [];
    const adapter = { send: async (message: string) => { sent.push(message); } };
    const sizeExceeded = await sendWithPolicy(['a'.repeat(11)], { maxMessageBytes: 10, messagesPerSecond: 100, now: () => 0 }, adapter);
    assert.deepEqual(sizeExceeded, { sent: 0, rejected: 'size' });
    assert.equal(sent.length, 0);

    let clock = 0;
    const rateExceeded = await sendWithPolicy(['one', 'two', 'three'], { maxMessageBytes: 100, messagesPerSecond: 1, now: () => clock }, {
      send: async (message: string) => {
        sent.push(message);
        clock += 0; // 仮想時計は進まない (2 通目が rate 制限に触れる)
      },
    });
    assert.deepEqual(rateExceeded, { sent: 1, rejected: 'rate' });
    assert.deepEqual(sent, ['one']);
  });

  test('[F14-UT-007] 表示生成では raw hash と text を区別する', () => {
    const evidence = wsEvidence(frame('f1', 'message-text'));
    assert.match(evidence.rawHash, /^[0-9a-f]{64}$/);
    assert.notEqual(evidence.rawHash, evidence.text);
    assert.equal(evidence.text, 'message-text');
  });
});
