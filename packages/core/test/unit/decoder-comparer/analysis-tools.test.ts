import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareBinary, compareBinaryRows, compareText, fingerprintBytes, parseComparisonHex, provenanceOf } from '../../../src/domain/decoder-comparer.ts';

test('fingerprints use the exact input bytes and known hash vectors', () => {
  assert.deepEqual(fingerprintBytes(Buffer.from('abc')), {
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    md5: '900150983cd24fb0d6963f7d28e17f72',
  });
  assert.notEqual(provenanceOf(Buffer.from([0x80]), Buffer.from([0x81]), {}).leftHash,
    provenanceOf(Buffer.from([0x80]), Buffer.from([0x81]), {}).rightHash);
});

test('an extra empty line is a difference, including empty inputs', () => {
  assert.equal(compareText('', '').equal, true);
  assert.equal(compareText('', '\n').equal, false);
  assert.equal(compareText('a', 'a\n').equal, false);
  assert.equal(compareText('a\r\n', 'a\n', { normalizeNewlines: true }).equal, true);
});

test('byte offsets include strict prefixes and empty versus nonempty', () => {
  for (const [left, right, offset] of [['ab', 'abc', 2], ['', 'a', 0], ['abc', 'ab', 2]] as const) {
    const summary = compareBinary(Buffer.from(left), Buffer.from(right));
    assert.equal(summary.equal, false);
    assert.equal(summary.firstDifferenceOffset, offset);
    assert.equal(summary.commonPrefixBytes, offset);
  }
});

test('hex input rejects incomplete, non-hex and oversized values', () => {
  assert.deepEqual(parseComparisonHex('00 ff\n80'), Buffer.from([0, 255, 128]));
  for (const value of ['a', 'gg', '00xx', '00'.repeat(1024 * 1024 + 1)]) {
    assert.throws(() => parseComparisonHex(value), /hex input/);
  }
});

test('byte rows preserve length differences and explicitly report truncation', () => {
  const prefix = compareBinaryRows(Buffer.from([1]), Buffer.from([1, 2]));
  assert.deepEqual(prefix.rows, [{ offset: 0, leftHex: '01', rightHex: '0102' }]);
  const bounded = compareBinaryRows(Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024, 255));
  assert.equal(bounded.rows.length, 4096);
  assert.equal(bounded.differingRows, 65536);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.nextOffset, 65536);
  const next = compareBinaryRows(Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024, 255), bounded.nextOffset ?? 0);
  assert.equal(next.rows[0]?.offset, 65536);
  assert.throws(() => compareBinaryRows(Buffer.alloc(0), Buffer.alloc(0), 1), /64 KiB/);
  assert.equal(compareBinaryRows(Buffer.alloc(0), Buffer.alloc(0)).equal, true);
});
