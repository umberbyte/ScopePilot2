import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

/** DOM value-flow 調査の service 経路 (design/f16)。観測なしでは候補を作らない。 */
describe('dom investigation (service)', () => {
  test('同一 marker の source→sink を候補として返し、PII node は redact する', async () => {
    const { service, operator } = await bootstrapFlow();
    const result = await service.analyzeDomFlows(operator, {
      targetUrl: 'http://fixture.target.test/app',
      observations: [
        { api: 'location.search', marker: 'q=<script>' },
        { api: 'innerHTML', marker: 'q=<script>' },
        { api: 'document.referrer', marker: 'q=<script>extra' },
        { api: 'eval', marker: 'other' },
      ],
      nodes: [
        { text: 'div content', looksLikePii: false },
        { text: 'user@example.example', looksLikePii: true },
      ],
    });
    assert.equal(result.candidates.length, 2);
    const exact = result.candidates.find((candidate) => candidate.confidence === 0.9);
    assert.deepEqual(exact, { sourceApi: 'location.search', sinkApi: 'innerHTML', confidence: 0.9, marker: 'q=<script>' });
    const partial = result.candidates.find((candidate) => candidate.confidence === 0.3);
    assert.ok(partial !== undefined, '部分一致は低 confidence');

    assert.deepEqual(result.evidence, ['div content', '[redacted: potential PII]']);
  });

  test('観測なしは候補なし。scope 外は拒否', async () => {
    const { service, operator } = await bootstrapFlow();
    const empty = await service.analyzeDomFlows(operator, { targetUrl: 'http://fixture.target.test/app', observations: [] });
    assert.deepEqual(empty, { candidates: [], evidence: [] });

    await assert.rejects(
      () => service.analyzeDomFlows(operator, { targetUrl: 'http://elsewhere.example/app', observations: [{ api: 'location.search', marker: 'x' }] }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'OutOfScope');
        return true;
      },
    );
  });

  test('live observation uses the scoped browser port and fingerprints marker values', async () => {
    const calls: { targetUrl: string; allowedOrigins: readonly string[] }[] = [];
    const { service, operator } = await bootstrapFlow({
      domObserver: {
        async observe(input) {
          calls.push({ targetUrl: input.targetUrl, allowedOrigins: input.scope.allowedOrigins });
          return {
            observations: [
              { api: 'location.search', marker: 'private-marker' },
              { api: 'innerHTML', marker: 'private-marker' },
            ],
            nodes: [],
          };
        },
      },
    });

    const result = await service.analyzeDomFlows(operator, {
      targetUrl: 'HTTP://FIXTURE.TARGET.TEST:80/app?q=private-marker',
      observations: [{ api: 'location.search', marker: 'untrusted-import' }],
      live: true,
    });
    assert.deepEqual(calls, [{ targetUrl: 'http://fixture.target.test/app?q=private-marker', allowedOrigins: ['http://fixture.target.test'] }]);
    assert.equal(result.candidates.length, 1);
    assert.match(result.candidates[0]?.marker ?? '', /^sha256:[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(result).includes('private-marker'));
    assert.ok(!JSON.stringify(result).includes('untrusted-import'), 'live mode does not mix caller-supplied observations');
  });

  test('live observation without an adapter is CapabilityUnavailable', async () => {
    const { service, operator } = await bootstrapFlow();
    await assert.rejects(
      () => service.analyzeDomFlows(operator, { targetUrl: 'http://fixture.target.test/app', observations: [], live: true }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'CapabilityUnavailable');
        return true;
      },
    );

    const failing = await bootstrapFlow({
      domObserver: {
        async observe() {
          throw new Error('browser self-test failed');
        },
      },
    });
    await assert.rejects(
      () => failing.service.analyzeDomFlows(failing.operator, { targetUrl: 'http://fixture.target.test/app', observations: [], live: true }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'CapabilityUnavailable');
        assert.ok(!String(error).includes('browser self-test failed'), 'adapter details are not exposed as a successful/diagnostic result');
        return true;
      },
    );
  });
});
