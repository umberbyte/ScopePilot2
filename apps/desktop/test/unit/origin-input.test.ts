import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseHttpOriginInput } from '../../src/renderer/origin-input.ts';

describe('origin input', () => {
  test('開始URLと同じ完全URL、末尾slash、既定portを同一のcanonical originへ正規化する', () => {
    assert.deepEqual(parseHttpOriginInput('http://192.168.0.27/\nhttp://192.168.0.27/path?q=1\nhttp://192.168.0.27:80').origins, [
      'http://192.168.0.27',
    ]);
  });

  test('HTTP(S)以外と不正URLをinvalidとして返す', () => {
    assert.deepEqual(parseHttpOriginInput('ftp://example.test\nnot-a-url'), {
      origins: [], invalidEntries: ['ftp://example.test', 'not-a-url'],
    });
  });
});

