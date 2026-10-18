import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  correlate,
  linkFinding,
  normalizeCallbacks,
  oastEvidenceProjection,
  pollDeadline,
  providerCapability,
  TokenIssuer,
  type ProviderEvent,
} from '@scopepilot2/core';

describe('OAST', () => {
  test('[F13-UT-001] 同一 attempt での再発行は一意 token と履歴を返す', () => {
    const issuer = new TokenIssuer();
    const first = issuer.issue('attempt-1');
    const second = issuer.issue('attempt-1');
    assert.notEqual(first.token, second.token);
    assert.deepEqual(second.history, [first.token, second.token]);
  });

  test('[F13-UT-002] 同一 provider event は dedupe する', () => {
    const events: ProviderEvent[] = [
      { eventId: 'e1', token: 't1', payload: 'dns' },
      { eventId: 'e2', token: 't1', payload: 'http' },
      { eventId: 'e1', token: 't1', payload: 'dns' },
    ];
    const result = normalizeCallbacks(events);
    assert.equal(result.kept.length, 2);
    assert.equal(result.duplicates, 1);
  });

  test('[F13-UT-003] 未知 token は uncorrelated として隔離する', () => {
    const callbacks = correlate(
      [
        { eventId: 'e1', token: 'known', payload: 'p1' },
        { eventId: 'e2', token: 'unknown', payload: 'p2' },
      ],
      new Set(['known']),
    );
    assert.equal(callbacks[0]?.kind, 'correlated');
    const uncorrelated = callbacks[1];
    assert.ok(uncorrelated !== undefined && uncorrelated.kind === 'uncorrelated');
    assert.match(uncorrelated.reason, /not issued/);
  });

  test('[F13-UT-004] 24h/7d の待機 deadline を遵守する', () => {
    const day = pollDeadline(0, 24 * 60 * 60 * 1000 - 1);
    assert.deepEqual(day, { expired: false, remainingMs: 1 });
    assert.deepEqual(pollDeadline(0, 24 * 60 * 60 * 1000), { expired: true, remainingMs: 0 });
    const week = pollDeadline(0, 7 * 24 * 60 * 60 * 1000 - 1, 7 * 24 * 60 * 60 * 1000);
    assert.equal(week.expired, false);
    assert.deepEqual(pollDeadline(0, 7 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000).expired, true);
  });

  test('[F13-UT-005] DNS 非対応 provider は Unsupported とする', () => {
    assert.equal(providerCapability(['http'], 'dns'), 'Unsupported');
    assert.equal(providerCapability(['http', 'dns'], 'dns'), 'Supported');
    assert.equal(providerCapability(['http'], 'http'), 'Supported');
  });

  test('[F13-UT-006] 曖昧 correlation (未知/複数 token) は candidate のみとする', () => {
    const single = linkFinding([{ kind: 'correlated', token: 't1', payload: 'p' }]);
    assert.deepEqual(single, { linkedTokens: ['t1'], candidateOnly: false });

    const withUnknown = linkFinding([
      { kind: 'correlated', token: 't1', payload: 'p' },
      { kind: 'uncorrelated', token: 't2', reason: 'unknown' },
    ]);
    assert.equal(withUnknown.candidateOnly, true);

    const multi = linkFinding([
      { kind: 'correlated', token: 't1', payload: 'p' },
      { kind: 'correlated', token: 't2', payload: 'p' },
    ]);
    assert.equal(multi.candidateOnly, true);
  });

  test('[F13-UT-007] report projection から token/credential を除外する', () => {
    const projection = oastEvidenceProjection({ token: 'secret-oast-token', payload: 'secret-interaction-body' });
    assert.ok(!('token' in projection) && !('payload' in projection));
    assert.deepEqual(projection, { interactionCount: 1, protocols: [] });
  });
});
