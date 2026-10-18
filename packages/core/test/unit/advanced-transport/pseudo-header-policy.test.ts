import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  checkAuthorityScope,
  classifyTransportEvent,
  negotiateTransport,
  transportCapability,
  transportEvidence,
  validateHeaderValues,
  validatePseudoHeaders,
} from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

const scope = { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] };

describe('HTTP/2 pseudo header / header policy', () => {
  test('[F15-UT-001] pseudo header の重複・不正・順序は validation error', () => {
    const valid: readonly (readonly [string, string])[] = [
      [':method', 'GET'],
      [':scheme', 'https'],
      [':authority', 'fixture.target.test'],
      [':path', '/'],
      ['accept', '*/*'],
    ];
    assert.deepEqual(validatePseudoHeaders(valid), { ordered: [':method', ':scheme', ':authority', ':path'] });

    const duplicated: readonly (readonly [string, string])[] = [
      [':method', 'GET'],
      [':method', 'POST'],
    ];
    assert.throws(() => validatePseudoHeaders(duplicated), /unique and known/);

    const misordered: readonly (readonly [string, string])[] = [
      [':method', 'GET'],
      ['accept', '*/*'],
      [':path', '/'],
    ];
    assert.throws(() => validatePseudoHeaders(misordered), /must precede regular headers/);
  });

  test('[F15-UT-002] :authority が scope 外なら OutOfScope', () => {
    const headers: readonly (readonly [string, string])[] = [[':authority', 'fixture.target.test']];
    assert.deepEqual(checkAuthorityScope(headers, 'http', scope), { allowed: true });
    const outOfScope = checkAuthorityScope([[':authority', 'elsewhere.example']], 'http', scope);
    assert.equal(outOfScope.allowed, false);
  });

  test('[F15-UT-003] CRLF 注入になり得る header 値は拒否する', () => {
    assert.throws(
      () => validateHeaderValues([['X-Custom', 'value\r\nInjected: yes']]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'ValidationFailed');
        assert.match((error as DomainError).message, /CR\/LF/);
        return true;
      },
    );
    assert.doesNotThrow(() => validateHeaderValues([['X-Custom', 'safe-value']]));
  });
});

describe('transport plan / result / capability / evidence', () => {
  test('[F15-UT-004] fallback 未許可なら H1 へ暗黙 fallback しない', () => {
    assert.throws(
      () => negotiateTransport({ offered: ['http/1.1'], allowFallback: false }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'CapabilityUnavailable');
        return true;
      },
    );
    assert.deepEqual(negotiateTransport({ offered: ['http/1.1'], allowFallback: true }), { protocol: 'http/1.1', downgraded: true });
    assert.deepEqual(negotiateTransport({ offered: ['h2', 'http/1.1'], allowFallback: false }), { protocol: 'h2', downgraded: false });
  });

  test('[F15-UT-005] GOAWAY は response 成功と区別する', () => {
    assert.deepEqual(classifyTransportEvent({ kind: 'response', status: 200 }), { isResponse: true, terminal: false });
    assert.deepEqual(classifyTransportEvent({ kind: 'goaway', errorCode: 0, lastStreamId: 5 }), { isResponse: false, terminal: true });
    assert.deepEqual(classifyTransportEvent({ kind: 'connection-closed' }), { isResponse: false, terminal: true });
  });

  test('[F15-UT-006] HTTP/3 は能力表で Unsupported', () => {
    assert.equal(transportCapability('h3'), 'Unsupported');
    assert.equal(transportCapability('h2'), 'Supported');
    assert.equal(transportCapability('http/1.1'), 'Supported');
  });

  test('[F15-UT-007] negotiation 結果は runtime/ALPN を保持する', () => {
    const evidence = transportEvidence({ alpn: 'h2', runtime: 'node-http2-fixture' });
    assert.deepEqual(evidence, { alpn: 'h2', runtime: 'node-http2-fixture' });
  });
});
