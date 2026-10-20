import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  analyzeEntropy,
  assess,
  createSamplePlan,
  createSequencerExtractor,
  extractBearerToken,
  extractCookieToken,
  extractDelimitedToken,
  extractHiddenInputToken,
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
    assert.throws(() => createSequencerExtractor('body', 'unused'), /not supported/);
  });

  test('[F07-UT-009] hidden input は属性順に依存せず指定fieldのHTML decode済み値だけを抽出する', () => {
    const extractor = createSequencerExtractor('hidden', undefined, 'csrf_token');
    const response = {
      body: [
        '<input type="hidden" name="other" value="ignored">',
        '<INPUT value="abc&gt;123&amp;x=1" NAME="csrf_token" TYPE="HIDDEN">',
      ].join(''),
    };
    assert.deepEqual(extractHiddenInputToken(response, 'csrf_token'), { kind: 'collected', token: 'abc>123&x=1' });
    assert.deepEqual(extractSequencerToken(response, extractor, /token=([a-z-]+)/), { kind: 'collected', token: 'abc>123&x=1' });
    assert.equal(extractHiddenInputToken({ body: '<input type="text" name="csrf_token" value="ignored">' }, 'csrf_token').kind, 'missing');
    assert.equal(extractHiddenInputToken({ body: '<input type="hidden" name="csrf_token" value="">' }, 'csrf_token').kind, 'missing');
    assert.throws(() => createSequencerExtractor('hidden', undefined, 'bad field'), /valid form field name/);
    assert.throws(() => createSequencerExtractor('hidden'), /valid form field name/);
    assert.throws(() => createSequencerExtractor('hidden', 'unused', 'csrf_token'), /only supported/);
    assert.throws(() => createSequencerExtractor('cookie', 'SEQ_TOKEN', 'unused'), /only supported/);
  });

  test('[F07-UT-010] response Authorization は Bearer b64token だけを抽出する', () => {
    const extractor = createSequencerExtractor('bearer');
    const response = { body: 'token=body-value', authorizationHeader: 'bEaReR abc-._~+/==' };
    assert.deepEqual(extractBearerToken(response), { kind: 'collected', token: 'abc-._~+/==' });
    assert.deepEqual(extractSequencerToken(response, extractor, /token=([a-z-]+)/), { kind: 'collected', token: 'abc-._~+/==' });
    assert.equal(extractBearerToken({ authorizationHeader: 'Basic abc123' }).kind, 'missing');
    assert.equal(extractBearerToken({ authorizationHeader: 'Bearer ' }).kind, 'missing');
    assert.equal(extractBearerToken({ authorizationHeader: 'Bearer abc, Basic def' }).kind, 'missing');
    assert.equal(extractBearerToken({ authorizationHeader: 'Bearer abc def' }).kind, 'missing');
    assert.throws(() => createSequencerExtractor('bearer', 'unused'), /not supported/);
    assert.throws(() => createSequencerExtractor('bearer', undefined, 'unused'), /not supported/);
  });

  test('[F07-UT-012] custom delimiter extractor はregexなしで上限付き抽出を行う', () => {
    const extractor = createSequencerExtractor('custom', undefined, undefined, '<token>', '</token>');
    const response = { body: '<token>first-value</token><token>ignored</token>' };
    assert.deepEqual(extractDelimitedToken(response, '<token>', '</token>'), { kind: 'collected', token: 'first-value' });
    assert.deepEqual(extractSequencerToken(response, extractor, /unused/g), { kind: 'collected', token: 'first-value' });
    assert.equal(extractDelimitedToken({ body: '<token></token>' }, '<token>', '</token>').kind, 'missing');
    assert.equal(extractDelimitedToken({ body: 'no delimiters' }, '<token>', '</token>').kind, 'missing');

    assert.throws(() => createSequencerExtractor('custom', undefined, undefined, '', '</token>'), /tokenStartDelimiter/);
    assert.throws(() => createSequencerExtractor('custom', undefined, undefined, '<token>\n', '</token>'), /control characters/);
    assert.throws(() => createSequencerExtractor('custom', undefined, undefined, 'é'.repeat(65), '</token>'), /128 UTF-8 bytes/);
    assert.throws(() => createSequencerExtractor('custom', 'unused', undefined, '<token>', '</token>'), /not supported/);
    assert.throws(() => extractDelimitedToken({ body: 'x'.repeat(1024 * 1024 + 1) }, '<token>', '</token>'), /scan exceeds/);
    assert.throws(() => extractDelimitedToken({ body: `<token>${'x'.repeat(4097)}</token>` }, '<token>', '</token>'), /token exceeds/);
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

  test('[F07-UT-011] byte 頻度を固定16区間へ集約し、UTF-8のbyte数で entropy を計算する', () => {
    const distribution = analyzeEntropy(['09AZaz']);
    assert.deepEqual(distribution.byteFrequencyBuckets, [0, 0, 0, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(distribution.byteFrequencyBuckets.reduce((sum, count) => sum + count, 0), 6);

    const utf8 = analyzeEntropy(['é']);
    assert.equal(utf8.shannonEntropyBitsPerByte, 1, 'UTF-8 の2 byteを母数にする');
    assert.equal(utf8.byteFrequencyBuckets.reduce((sum, count) => sum + count, 0), 2);
  });

  test('[F07-UT-013] token のUTF-8 byte長とUnicode文字長を固定16区間へ集約する', () => {
    const distribution = analyzeEntropy(['', 'a', 'é', 'abc', 'abcdefghij']);
    assert.deepEqual(distribution.tokenLengthBucketMinimums, [0, 1, 2, 3, 5, 9, 17, 33, 65, 129, 257, 513, 1025, 2049, 4097, 8193]);
    assert.deepEqual(distribution.tokenByteLengthBuckets, [1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(distribution.tokenCharacterLengthBuckets, [1, 2, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(distribution.tokenByteLengthBuckets.reduce((sum, count) => sum + count, 0), 5);
    assert.equal(distribution.tokenCharacterLengthBuckets.reduce((sum, count) => sum + count, 0), 5);
  });

  test('[F07-UT-014] alphabet は文字を返さず固定classと種類数へ集約する', () => {
    const distribution = analyzeEntropy(['aA0-_', '/+=?', 'é😀', 'a']);
    assert.equal(distribution.observedAlphabetSize, 11);
    assert.deepEqual(distribution.alphabetClassCounts, {
      digit: 1,
      lowerAscii: 2,
      upperAscii: 1,
      base64UrlPunctuation: 2,
      base64StandardPunctuation: 2,
      padding: 1,
      otherAscii: 1,
      nonAscii: 2,
    });
    assert.equal(JSON.stringify(distribution).includes('é'), false, '個々の文字は統計へ残さない');
    assert.equal(JSON.stringify(distribution).includes('😀'), false, '個々の文字は統計へ残さない');
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
