import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

/**
 * OAST の service 経路 (design/f13)。token は発行時に一度だけ返し、一覧・監査に
 * は出さない。未知 token は uncorrelated として隔離し、所見候補にしかしない。
 */
describe('oast (service)', () => {
  test('token を発行し、callback を相関記録する。重複 event は dedupe', async () => {
    const { service, operator } = await bootstrapFlow();
    const attempt = await service.startOastAttempt(operator, { targetUrl: 'http://fixture.target.test/xss', protocol: 'http' });
    assert.match(attempt.token, /^oast-/);
    assert.equal(attempt.waitMs, 24 * 60 * 60 * 1000);

    const first = service.recordOastCallbacks(operator, {
      events: [
        { eventId: 'ev-1', token: attempt.token, payload: 'interaction-1' },
        { eventId: 'ev-1', token: attempt.token, payload: 'interaction-1' },
        { eventId: 'ev-2', token: 'oast-unknown-token', payload: 'noise' },
      ],
    });
    assert.deepEqual(first, { kept: 2, duplicates: 1, correlated: 1, uncorrelated: 1 });

    // 同一 event の再送はすべて重複。
    const resent = service.recordOastCallbacks(operator, { events: [{ eventId: 'ev-1', token: attempt.token, payload: 'interaction-1' }] });
    assert.deepEqual(resent, { kept: 0, duplicates: 1, correlated: 0, uncorrelated: 0 });

    const attempts = service.listOastAttempts();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, 'waiting');
    assert.equal(attempts[0]?.interactions, 1);
    assert.equal(JSON.stringify(attempts).includes(attempt.token), false, '一覧に token を出さない');

    const eventsText = JSON.stringify(service.events());
    assert.ok(eventsText.includes('OastAttemptStarted'));
    assert.ok(eventsText.includes('OastCallbacksRecorded'));
    assert.equal(eventsText.includes(attempt.token), false, '監査に token を出さない');
  });

  test('非対応 protocol は CapabilityUnavailable。scope 外・空 events は拒否', async () => {
    const { service, operator } = await bootstrapFlow();
    await assert.rejects(
      service.startOastAttempt(operator, { targetUrl: 'http://fixture.target.test/x', protocol: 'smtp' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'CapabilityUnavailable');
        return true;
      },
    );
    await assert.rejects(
      service.startOastAttempt(operator, { targetUrl: 'http://elsewhere.example/x', protocol: 'http' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'OutOfScope');
        return true;
      },
    );
    assert.throws(
      () => service.recordOastCallbacks(operator, { events: [] }),
      /at least one event/,
    );
  });

  test('実 provider が発行した payload と background callback を相関し token を監査へ出さない', async () => {
    const token = 'real-payload.self-host.example';
    const provider = {
      supportedProtocols: ['http', 'dns', 'smtp'] as const,
      async startSession(input: { onEvents: (events: readonly { eventId: string; token: string; payload: string }[]) => void }): Promise<{ token: string }> {
        // payload 応答と同じ event-loop 内で callback が来ても attempt 登録後に相関する。
        input.onEvents([{ eventId: 'provider-event-1', token, payload: '{"protocol":"smtp"}' }]);
        return { token };
      },
    };
    const { service, operator } = await bootstrapFlow({ oastProvider: provider });
    const attempt = await service.startOastAttempt(operator, { targetUrl: 'http://fixture.target.test/xss', protocol: 'smtp' });
    assert.equal(attempt.token, token);

    const attempts = service.listOastAttempts();
    assert.equal(attempts[0]?.interactions, 1);
    assert.equal(JSON.stringify(attempts).includes(attempt.token), false);
    assert.equal(JSON.stringify(service.events()).includes(attempt.token), false);
    assert.deepEqual(
      service.events().map((event) => event.type).filter((type) => type.startsWith('Oast')),
      ['OastAttemptStarted', 'OastCallbacksRecorded'],
    );
  });
});
