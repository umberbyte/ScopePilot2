import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BreakQueue, decideIntercept, maskSecretHeaders, presentCertificate, ProxySession } from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

const scope = { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] };

function item(itemId: string, deadlineMs = 10_000): Omit<import('@scopepilot2/core').BreakItem, 'state'> {
  return { itemId, messageReference: `msg-${itemId}`, direction: 'request', receivedAtMs: 0, deadlineMs, originalRequestHash: `hash-${itemId}` };
}

describe('BreakQueue', () => {
  test('[F02-UT-001] queue 上限超過は新規 item を拒否する', () => {
    const queue = new BreakQueue(2);
    queue.enqueue(item('a'));
    queue.enqueue(item('b'));
    assert.throws(() => queue.enqueue(item('c')), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'ValidationFailed');
      assert.match((error as DomainError).message, /break queue is full/);
      return true;
    });
  });

  test('[F02-UT-002] deadline 経過は drop し expired event を出す (暗黙 forward しない)', () => {
    const queue = new BreakQueue(2);
    queue.enqueue(item('a', 1_000));
    const expired = queue.expireDeadlines(1_000);
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.state, 'Expired');
    assert.deepEqual(queue.recordedEvents(), [{ type: 'expired', itemId: 'a' }]);
  });
});

describe('InterceptDecisionPolicy', () => {
  test('[F02-UT-003] 編集後 forward は新 hash と decision を記録する', () => {
    const queue = new BreakQueue(1);
    queue.enqueue(item('a'));
    const decision = decideIntercept(queue, 'a', { requestHash: 'edited-hash-1', targetUrl: 'http://fixture.target.test/edited' }, scope);
    assert.equal(decision.action, 'forward');
    assert.equal(decision.newRequestHash, 'edited-hash-1');
    assert.equal(queue.get('a')?.state, 'Forwarded');
    assert.equal(queue.get('a')?.editedRequestHash, 'edited-hash-1');
  });

  test('[F02-UT-004] scope 外への URL 編集は forward せず拒否する', () => {
    const queue = new BreakQueue(1);
    queue.enqueue(item('a'));
    const decision = decideIntercept(queue, 'a', { requestHash: 'h', targetUrl: 'http://elsewhere.example/x' }, scope);
    assert.equal(decision.action, 'reject');
    assert.match(decision.reason ?? '', /not in allowed origins|deny rule/);
    assert.equal(queue.get('a')?.state, 'Held', 'forward しない');
  });
});

describe('ProxySession', () => {
  test('[F02-UT-005] start 中の stop で adapter stop は一度だけ呼ばれる', async () => {
    const stops: string[] = [];
    const session = new ProxySession({ sessionId: 'zap-proxy-1', stop: async (id) => { stops.push(id); } });
    session.markReady();
    await session.stop();
    await session.stop();
    assert.deepEqual(stops, ['zap-proxy-1']);
    assert.equal(session.currentState, 'Stopped');
  });
});

describe('CertificatePresenter / redaction', () => {
  test('[F02-UT-006] CA 情報表示に private key material を含めない', () => {
    const presented = presentCertificate({
      subject: 'CN=ScopePilot Root CA (fixture)',
      serialNumber: '00aa',
      validUntil: '2036-01-01T00:00:00Z',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
    });
    assert.equal(presented.subject, 'CN=ScopePilot Root CA (fixture)');
    assert.ok(!('privateKeyPem' in presented));
    assert.ok(!JSON.stringify(presented).includes('PRIVATE KEY'));
  });

  test('[F02-UT-007] Cookie/Authorization の表示値を mask する', () => {
    const masked = maskSecretHeaders([
      ['Cookie', 'SID=supersecret'],
      ['Authorization', 'Bearer eyJhb.abc'],
      ['Content-Type', 'text/html'],
    ]);
    assert.deepEqual(masked, [
      ['Cookie', '***masked***'],
      ['Authorization', '***masked***'],
      ['Content-Type', 'text/html'],
    ]);
    assert.ok(!JSON.stringify(masked).includes('supersecret'));
  });
});
