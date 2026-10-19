import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

/** fuzz session の service 経路 (design/f05)。組合せ上限・cluster 集約・供給元登録。 */
describe('fuzz session (service)', () => {
  test('payload 集合は供給元・版・license なしでは登録できない', async () => {
    const { service, operator } = await bootstrapFlow();
    assert.throws(
      () =>
        service.registerPayloadSet(operator, {
          name: 'sqli',
          source: '',
          version: '1',
          license: 'MIT',
          sha256: 'abc',
          values: ["' OR '1'='1"],
        }),
      /payload set field source is required/,
    );
    const registered = service.registerPayloadSet(operator, {
      name: 'sqli',
      source: 'fixture-handbook',
      version: '1.0.0',
      license: 'MIT',
      sha256: 'abc123',
      values: ["' OR '1'='1", "' OR '1'='2"],
    });
    assert.equal(registered.valueCount, 2);
    assert.deepEqual(
      service.listPayloadSets().map((set) => set.name),
      ['sqli'],
    );
  });

  test('fuzz session は組合せを実行し cluster 集約を返す。上限超過は送信前に拒否', async () => {
    const { service, operator } = await bootstrapFlow();
    const result = await service.runFuzzSession(operator, {
      targetUrl: 'http://fixture.target.test/fuzz',
      positions: [
        { name: 'user', values: ['admin', 'guest'] },
        { name: 'id', values: ['1', '2', '3'] },
      ],
    });
    assert.equal(result.total, 6);
    assert.equal(result.sent, 6);
    // fixture 応答は先頭 position の値だけで決まるため 2 cluster (各 3 member)。
    assert.equal(result.clusters.length, 2);
    assert.deepEqual(result.clusters[0]?.members.length, 3);
    assert.ok(result.clusters.every((cluster) => cluster.representative.length === 2));

    // 組合せ上限 (maxRequests) 超過は送信前に拒否 (F05-UT-001)。
    await assert.rejects(
      service.runFuzzSession(operator, {
        targetUrl: 'http://fixture.target.test/fuzz',
        positions: [
          { name: 'a', values: ['1', '2', '3', '4', '5'] },
          { name: 'b', values: ['1', '2', '3', '4', '5'] },
        ],
        maxRequests: 10,
      }),
      /combination count 25 exceeds plan limit 10/,
    );

    // scope 外 URL は拒否。
    await assert.rejects(
      service.runFuzzSession(operator, { targetUrl: 'http://elsewhere.example/fuzz', positions: [{ name: 'a', values: ['1'] }] }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'OutOfScope');
        return true;
      },
    );
  });
});
