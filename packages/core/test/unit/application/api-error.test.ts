import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { apiErrorOf } from '@scopepilot2/core';
import { DomainErrorCodes, domainError, DomainError } from '@scopepilot2/contracts';

describe('apiErrorOf (error mapper)', () => {
  test('[SYS-UT-003] domain error を安定した API code へ一意に変換する', () => {
    const mapped = DomainErrorCodes.map((code) => apiErrorOf(domainError(code, `message:${code}`, { retryable: code === 'EngineFailure' })));
    // 全 code が欠落なく一意に対応する。
    assert.deepEqual(
      mapped.map((shape) => shape.code),
      [...DomainErrorCodes],
    );
    for (const shape of mapped) {
      assert.match(shape.message, new RegExp(`message:${shape.code}`));
    }
    assert.equal(mapped.find((shape) => shape.code === 'EngineFailure')?.retryable, true);
    assert.equal(mapped.find((shape) => shape.code === 'OutOfScope')?.retryable, false);

    // DomainError 以外は変換せず伝播させる。
    assert.throws(() => apiErrorOf(new Error('plain') as unknown as DomainError), /plain/);
  });
});
