import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

/** transport 選択と HTTP/2 header 検証の service 経路 (design/f15)。 */
describe('advanced transport (service)', () => {
  test('h2 を選択し、h1-only peer は fallback 許可時のみ downgrade する', async () => {
    const { service, operator } = await bootstrapFlow();
    const h2 = await service.negotiateTransportFor(operator, { targetUrl: 'http://fixture.target.test/api', allowFallback: false });
    assert.equal(h2.protocol, 'h2');
    assert.equal(h2.downgraded, false);
    assert.equal(h2.alpn, 'h2');
    assert.equal(h2.runtime, 'fixture-transport');

    const explicitH1 = await service.negotiateTransportFor(operator, {
      targetUrl: 'http://fixture.target.test/api',
      requested: 'http/1.1',
      allowFallback: false,
    });
    assert.deepEqual(explicitH1, {
      protocol: 'http/1.1',
      downgraded: false,
      alpn: 'http/1.1 (explicit)',
      runtime: 'fixture-transport',
    });

    const downgraded = await service.negotiateTransportFor(operator, { targetUrl: 'http://fixture.target.test/h1-only-api', allowFallback: true });
    assert.equal(downgraded.protocol, 'http/1.1');
    assert.equal(downgraded.downgraded, true);

    await assert.rejects(
      () => service.negotiateTransportFor(operator, { targetUrl: 'http://fixture.target.test/h1-only-api', allowFallback: false }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'CapabilityUnavailable');
        return true;
      },
    );

    // HTTP/3 は能力表で Unsupported (F15-UT-006)。
    await assert.rejects(
      () => service.negotiateTransportFor(operator, { targetUrl: 'http://fixture.target.test/api', allowFallback: true, requested: 'h3' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'CapabilityUnavailable');
        return true;
      },
    );
    assert.ok(JSON.stringify(service.events()).includes('TransportNegotiated'));
  });

  test('configured probe receives the canonical in-scope target and preserves measured evidence', async () => {
    const calls: { targetUrl: string; requested: 'h2' | 'http/1.1'; allowFallback: boolean }[] = [];
    const { service, operator } = await bootstrapFlow({
      advancedTransport: {
        async probe(input) {
          calls.push(input);
          return {
            offered: ['h2'],
            alpn: 'h2',
            runtime: 'node-test-runtime',
            response: {
              statusCode: 204,
              elapsedMs: 12.5,
              streamId: 1,
              remoteSettings: { maxFrameSize: 16_384, maxConcurrentStreams: 100 },
            },
          };
        },
      },
    });

    const result = await service.negotiateTransportFor(operator, {
      targetUrl: 'HTTP://FIXTURE.TARGET.TEST:80/real-h2?x=1',
      allowFallback: false,
    });
    assert.deepEqual(calls, [{ targetUrl: 'http://fixture.target.test/real-h2?x=1', requested: 'h2', allowFallback: false }]);
    assert.deepEqual(result, {
      protocol: 'h2',
      downgraded: false,
      alpn: 'h2',
      runtime: 'node-test-runtime',
      response: {
        statusCode: 204,
        elapsedMs: 12.5,
        streamId: 1,
        remoteSettings: { maxFrameSize: 16_384, maxConcurrentStreams: 100 },
      },
    });
  });

  test('header 検証は pseudo header 規則・CRLF・:authority scope を強制する', async () => {
    const { service, operator } = await bootstrapFlow();
    const valid = service.validateTransportHeaders(operator, {
      headers: [
        [':method', 'GET'],
        [':scheme', 'http'],
        [':authority', 'fixture.target.test'],
        [':path', '/api'],
        ['x-custom', '1'],
      ],
      scheme: 'http',
    });
    assert.deepEqual(valid.ordered, [':method', ':scheme', ':authority', ':path']);
    assert.equal(valid.authority, 'fixture.target.test');

    // pseudo header が通常 header の後に来るのは不正 (F15-UT-001)。
    assert.throws(
      () =>
        service.validateTransportHeaders(operator, {
          headers: [
            ['x-custom', '1'],
            [':method', 'GET'],
          ],
          scheme: 'http',
        }),
      /pseudo headers must precede/,
    );
    // CRLF 注入になり得る値は拒否 (F15-UT-003)。
    assert.throws(
      () =>
        service.validateTransportHeaders(operator, {
          headers: [
            [':method', 'GET'],
            [':scheme', 'http'],
            [':authority', 'fixture.target.test'],
            [':path', '/'],
            ['x-bad', 'a\r\nb'],
          ],
          scheme: 'http',
        }),
      /CR\/LF/,
    );
    // :authority が scope 外なら OutOfScope (F15-UT-002)。
    assert.throws(
      () =>
        service.validateTransportHeaders(operator, {
          headers: [
            [':method', 'GET'],
            [':scheme', 'http'],
            [':authority', 'elsewhere.example'],
            [':path', '/'],
          ],
          scheme: 'http',
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'OutOfScope');
        return true;
      },
    );
  });
});
