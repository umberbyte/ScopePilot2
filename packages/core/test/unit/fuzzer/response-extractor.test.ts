import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clusterResponses, extractMatches, type FuzzResponseOutcome } from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

describe('response extractor / result clusterer (F05)', () => {
  test('[F05-UT-007] bounded regex の scan/match 上限超過は error となり部分結果を返さない', () => {
    const body = 'value: 1\n'.repeat(200);
    assert.deepEqual(extractMatches(/value: \d+/g, body, { maxScanBytes: 4096, maxMatches: 500 }), Array.from({ length: 200 }, () => 'value: 1'));
    assert.throws(() => extractMatches(/value: \d+/g, body, { maxScanBytes: 100, maxMatches: 500 }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'ValidationFailed');
      assert.match((error as DomainError).message, /scan exceeds 100/);
      return true;
    });
    assert.throws(() => extractMatches(/value: \d+/g, body, { maxScanBytes: 4096, maxMatches: 5 }), /matches exceed 5/);
    assert.throws(() => extractMatches(/value: \d+/, body), /must be global/);
  });

  test('[F05-UT-008] 同一 status/length/hash の結果は同一 cluster へ集約する', () => {
    const outcomes: readonly FuzzResponseOutcome[] = [
      { status: 200, contentLength: 12, bodyHash: 'h1' },
      { status: 200, contentLength: 12, bodyHash: 'h1' },
      { status: 500, contentLength: 12, bodyHash: 'h1' },
      { status: 200, contentLength: 13, bodyHash: 'h1' },
      { status: 200, contentLength: 12, bodyHash: 'h2' },
    ];
    const clusters = clusterResponses(outcomes);
    assert.equal(clusters.length, 4);
    const bigCluster = clusters.find((cluster) => cluster.members.length === 2);
    assert.deepEqual(bigCluster?.members, [0, 1]);
    assert.match(bigCluster?.key ?? '', /^200\|12\|h1$/);
  });
});
