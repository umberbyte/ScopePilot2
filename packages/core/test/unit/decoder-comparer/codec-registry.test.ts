import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CodecRegistry, transformPipeline } from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';
import { gzipSync } from 'node:zlib';

describe('CodecRegistry', () => {
  test('[F06-UT-001] 未登録 codec は validation error', () => {
    const registry = new CodecRegistry();
    assert.throws(() => registry.decode('rot13', Buffer.from('abc')), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'ValidationFailed');
      assert.match((error as DomainError).message, /codec not registered: rot13/);
      return true;
    });
    assert.equal(registry.has('base64'), true);
    assert.equal(registry.has('rot13'), false);
  });
});

describe('TransformPipeline', () => {
  test('[F06-UT-002] Base64→gzip の順序通りに bytes を復元する', () => {
    const registry = new CodecRegistry();
    const original = Buffer.from('hello decoder pipeline', 'utf8');
    const gzipped = gzipSync(original);
    const encoded = Buffer.from(gzipped.toString('base64'), 'utf8');
    const decoded = transformPipeline(registry, encoded, ['base64', 'gzip']);
    assert.equal(decoded.toString('utf8'), 'hello decoder pipeline');
    // 逆順は失敗する (gzip が base64 を解釈できない)。
    assert.throws(() => transformPipeline(registry, encoded, ['gzip', 'base64']));
  });

  test('[F06-UT-003] 展開上限超過は途中停止となり部分値を成功扱いしない', () => {
    const registry = new CodecRegistry({ maxInputBytes: 1024 * 1024, maxOutputBytes: 1024 });
    const bomb = gzipSync(Buffer.alloc(64 * 1024, 0x41));
    assert.throws(() => registry.decode('gzip', bomb), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'ValidationFailed');
      // 失敗時は部分 decode 値を返さない。
      return true;
    });
  });
});
