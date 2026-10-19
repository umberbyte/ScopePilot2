import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

/** DOM value-flow 調査の service 経路 (design/f16)。観測なしでは候補を作らない。 */
describe('dom investigation (service)', () => {
  test('同一 marker の source→sink を候補として返し、PII node は redact する', async () => {
    const { service, operator } = await bootstrapFlow();
    const result = service.analyzeDomFlows(operator, {
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
    const empty = service.analyzeDomFlows(operator, { targetUrl: 'http://fixture.target.test/app', observations: [] });
    assert.deepEqual(empty, { candidates: [], evidence: [] });

    assert.throws(
      () => service.analyzeDomFlows(operator, { targetUrl: 'http://elsewhere.example/app', observations: [{ api: 'location.search', marker: 'x' }] }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'OutOfScope');
        return true;
      },
    );
  });
});
