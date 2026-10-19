import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

/**
 * Sequencer session の service 経路 (design/f07)。token 原文は応答・監査の
 * いずれにも出ない (F07-UT-006)。sample 不足は断定しない (F07-UT-005)。
 */
describe('sequencer session (service)', () => {
  test('sample を収集して統計を返す。token 原文は応答に出ない', async () => {
    const { service, operator } = await bootstrapFlow();
    const result = service.runSequencerSession(operator, { targetUrl: 'http://fixture.target.test/session-token', samples: 100 });
    assert.equal(result.verdict, 'assessed');
    assert.equal(result.sampleCount, 100);
    assert.equal(result.duplicates, 0);
    assert.equal(result.missing, 0);
    assert.ok((result.shannonEntropyBitsPerByte ?? 0) > 3, '変化する token は高い entropy');
    assert.ok((result.distinctByteValues ?? 0) > 10);
    assert.equal(JSON.stringify(result).includes('sample-'), false, 'token 原文は応答に出ない');
    assert.equal(service.listSequencerSessions().length, 1);

    // URL に fixed を含む対象は毎回同一 token — 重複が増える (entropy は byte 分布の
    // 統計のため繰り返しでは下がらない。低 entropy 自体は F07-UT-004 の domain UT で担保)。
    const fixed = service.runSequencerSession(operator, { targetUrl: 'http://fixture.target.test/fixed-token', samples: 40 });
    assert.equal(fixed.verdict, 'assessed');
    assert.equal(fixed.sampleCount, 40);
    assert.equal(fixed.duplicates, 39, '2 件目以降はすべて重複');

    // URL に no-token を含む対象は欠落が混入する (F07-UT-002 の service 経路)。
    const withMissing = service.runSequencerSession(operator, { targetUrl: 'http://fixture.target.test/no-token-page', samples: 40 });
    assert.equal(withMissing.missing, 8, '5 回に 1 回は token 欠落');
    assert.equal(withMissing.sampleCount, 32);

    // 監査は統計のみ。
    const eventsText = JSON.stringify(service.events());
    assert.ok(eventsText.includes('SequencerSessionCompleted'));
    assert.equal(eventsText.includes('sample-'), false);
  });

  test('sample 数は domain 境界 (30..10000) で検証される。scope 外は拒否', async () => {
    const { service, operator } = await bootstrapFlow();
    assert.throws(
      () => service.runSequencerSession(operator, { targetUrl: 'http://fixture.target.test/x', samples: 29 }),
      /between 30 and 10000/,
    );
    assert.throws(
      () => service.runSequencerSession(operator, { targetUrl: 'http://fixture.target.test/x', samples: 10001 }),
      /between 30 and 10000/,
    );
    // 最小より少ない採取数では断定しない (F07-UT-005)。
    const insufficient = service.runSequencerSession(operator, { targetUrl: 'http://fixture.target.test/no-token-page', samples: 30 });
    assert.equal(insufficient.sampleCount, 24);
    assert.equal(insufficient.verdict, 'insufficient');
    assert.equal(insufficient.minimum, 30);
    assert.equal(insufficient.shannonEntropyBitsPerByte, undefined);

    assert.throws(
      () => service.runSequencerSession(operator, { targetUrl: 'http://elsewhere.example/x', samples: 40 }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'OutOfScope');
        return true;
      },
    );
  });
});
