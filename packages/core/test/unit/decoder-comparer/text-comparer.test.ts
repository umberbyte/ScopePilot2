import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareBinary, compareHttpMessages, compareText, provenanceOf, type HttpMessageShape } from '@scopepilot2/core';

describe('TextComparer', () => {
  test('[F06-UT-004] LF/CRLF 正規化 option の有無で差分が変わる', () => {
    const left = 'line1\nline2\nline3';
    const right = 'line1\r\nline2\r\nline3';
    const strict = compareText(left, right);
    assert.equal(strict.equal, false);
    assert.equal(strict.differingLines.length, 2);
    const normalized = compareText(left, right, { normalizeNewlines: true });
    assert.equal(normalized.equal, true);
  });
});

describe('HttpMessageComparer', () => {
  test('[F06-UT-005] header 順のみの相違は raw と semantic の結果を分離する', () => {
    const left: HttpMessageShape = {
      startLine: 'HTTP/1.1 200 OK',
      headers: [
        ['Content-Type', 'text/html'],
        ['X-Frame-Options', 'DENY'],
      ],
      body: '<html></html>',
    };
    const right: HttpMessageShape = {
      startLine: 'HTTP/1.1 200 OK',
      headers: [
        ['X-Frame-Options', 'DENY'],
        ['Content-Type', 'text/html'],
      ],
      body: '<html></html>',
    };
    const result = compareHttpMessages(left, right);
    assert.equal(result.raw.equal, false, 'raw 比較では順序の差を検出する');
    assert.equal(result.semantic.equal, true, 'semantic 比較では header 順を無視する');
  });
});

describe('BinaryComparer と比較 provenance', () => {
  test('[F06-UT-006] 大容量でも bounded な要約を返す', () => {
    const left = Buffer.alloc(2 * 1024 * 1024, 0x00);
    const right = Buffer.alloc(2 * 1024 * 1024, 0x00);
    right[1024 * 1024] = 0xff;
    const summary = compareBinary(left, right);
    assert.equal(summary.equal, false);
    assert.equal(summary.firstDifferenceOffset, 1024 * 1024);
    assert.equal(summary.commonPrefixBytes, 1024 * 1024);
    assert.equal(summary.leftBytes, summary.rightBytes);
    assert.deepEqual(compareBinary(left, Buffer.from(left)), {
      equal: true,
      leftBytes: left.length,
      rightBytes: left.length,
      firstDifferenceOffset: null,
      commonPrefixBytes: left.length,
    });
  });

  test('[F06-UT-007] 比較保存は両 artifact hash と option を保持する', () => {
    const left = Buffer.from('a');
    const right = Buffer.from('b');
    const provenance = provenanceOf(left, right, { normalizeNewlines: true });
    assert.match(provenance.leftHash, /^[0-9a-f]{64}$/);
    assert.match(provenance.rightHash, /^[0-9a-f]{64}$/);
    assert.notEqual(provenance.leftHash, provenance.rightHash);
    assert.deepEqual(provenance.options, { normalizeNewlines: true });
  });
});
