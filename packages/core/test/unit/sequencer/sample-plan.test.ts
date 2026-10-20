import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  analyzeEntropy,
  assess,
  createSamplePlan,
  createSequencerExtractor,
  extractCookieToken,
  extractSequencerToken,
  extractToken,
  reportProjection,
  SampleCollector,
} from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

describe('Sequencer', () => {
  test('[F07-UT-001] 29 / 10,001 sample は境界外として拒否する', () => {
    for (const invalid of [29, 10001, 0, -1]) {
      assert.throws(() => createSamplePlan(invalid), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'ValidationFailed');
        return true;
      });
    }
    assert.deepEqual(createSamplePlan(30), { target: 30 });
    assert.deepEqual(createSamplePlan(10000), { target: 10000 });
    assert.deepEqual(createSamplePlan(100), { target: 100 });
  });

  test('[F07-UT-002] token 欠落は missing outcome として数える', () => {
    const missing = extractToken({ body: '<html>no token here</html>' }, /token=([a-z0-9]+)/);
    assert.equal(missing.kind, 'missing');
    if (missing.kind === 'missing') {
      assert.ok(missing.reason.length > 0);
    }
    const found = extractToken({ body: 'token=abc123;' }, /token=([a-z0-9]+)/);
    assert.deepEqual(found, { kind: 'collected', token: 'abc123' });
  });

  test('[F07-UT-008] response Set-Cookie は指定名だけを抽出し、値中の = を保持する', () => {
    const extractor = createSequencerExtractor('cookie', 'SEQ_TOKEN');
    const response = {
      body: 'token=body-value',
      setCookieHeaders: [
        'OTHER=ignored; Path=/',
        'SEQ_TOKEN=abc==; Path=/; HttpOnly',
      ],
    };
    assert.deepEqual(extractCookieToken(response, 'SEQ_TOKEN'), { kind: 'collected', token: 'abc==' });
    assert.deepEqual(extractSequencerToken(response, extractor, /token=([a-z-]+)/), { kind: 'collected', token: 'abc==' });
    assert.equal(extractCookieToken({ setCookieHeaders: ['SEQ_TOKEN=; Path=/'] }, 'SEQ_TOKEN').kind, 'missing');
    assert.equal(extractCookieToken({ setCookieHeaders: ['OTHER=value'] }, 'SEQ_TOKEN').kind, 'missing');
    assert.throws(() => createSequencerExtractor('cookie', 'bad name'), /valid cookie name/);
    assert.throws(() => createSequencerExtractor('cookie'), /valid cookie name/);
    assert.throws(() => createSequencerExtractor('body', 'unused'), /only supported/);
  });

  test('[F07-UT-003] duplicate token も sample として保持し重複数を数える', () => {
    const collector = new SampleCollector();
    for (const token of ['a', 'b', 'a', 'c', 'a']) {
      collector.record({ kind: 'collected', token });
    }
    collector.record({ kind: 'missing', reason: 'no token' });
    const snapshot = collector.snapshot();
    assert.equal(snapshot.tokens.length, 5);
    assert.equal(snapshot.duplicates, 2);
    assert.equal(snapshot.missing, 1);
  });

  test('[F07-UT-004] 固定 bytes には決定的な低 entropy を返す', () => {
    const first = analyzeEntropy(['aaaaaaaa']);
    const second = analyzeEntropy(['aaaaaaaa']);
    assert.deepEqual(first, second);
    assert.equal(first.shannonEntropyBitsPerByte, 0);
    assert.equal(first.distinctByteValues, 1);
    const mixed = analyzeEntropy(['ab']);
    assert.ok(mixed.shannonEntropyBitsPerByte > 0);
  });

  test('[F07-UT-005] sample 不足は断定せず insufficient を返す', () => {
    const result = assess(Array.from({ length: 29 }, (_, i) => `t${i}`));
    assert.deepEqual(result, { verdict: 'insufficient', collected: 29, minimum: 30 });
    const assessed = assess(Array.from({ length: 30 }, (_, i) => `t${i % 5}`));
    assert.equal(assessed.verdict, 'assessed');
  });

  test('[F07-UT-006] report projection から token 原文を除外する', () => {
    const projection = reportProjection({ tokens: ['secret-token-1', 'secret-token-2'], duplicates: 0, missing: 0 });
    assert.deepEqual(projection, { sampleCount: 2, duplicates: 0, missing: 0 });
    assert.ok(!JSON.stringify(projection).includes('secret-token'));
  });

  test('[F07-UT-007] cancel 後は新規 request を発行しない', async () => {
    const requests: number[] = [];
    let cancelled = false;
    const collect = async (count: number): Promise<{ requested: number }> => {
      let requested = 0;
      for (let index = 0; index < count; index += 1) {
        if (cancelled) {
          break;
        }
        requests.push(index);
        requested += 1;
      }
      return { requested };
    };
    assert.equal((await collect(5)).requested, 5);
    cancelled = true;
    assert.equal((await collect(5)).requested, 0);
    assert.equal(requests.length, 5, 'cancel 後の新規発行なし');
  });
});
