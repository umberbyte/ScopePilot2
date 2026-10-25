import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  FIXTURE_NUCLEI_JSONL,
  FIXTURE_NUCLEI_MALFORMED_LINE_INDEXES,
  nucleiJsonlFixtureHash,
  targetSiteFixtureHash,
  zapAlertsFixtureHash,
} from '@scopepilot2/simulation';

interface NucleiLine {
  readonly 'template-id': string;
  readonly 'matched-at': string;
  readonly info: { readonly severity: string };
}

function isValidMatchLine(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null && 'template-id' in (parsed as object);
  } catch {
    return false;
  }
}

describe('simulation fixtures', () => {
  test('fixture hash は呼出しごとに安定している', () => {
    assert.equal(targetSiteFixtureHash(), targetSiteFixtureHash());
    assert.equal(zapAlertsFixtureHash(), zapAlertsFixtureHash());
    assert.equal(nucleiJsonlFixtureHash(), nucleiJsonlFixtureHash());
  });

  test('Nuclei JSONL fixture は取込の境界ケース (重複・破損・scope外・critical) を含む', () => {
    assert.equal(FIXTURE_NUCLEI_JSONL.length, 7);

    for (const index of FIXTURE_NUCLEI_MALFORMED_LINE_INDEXES) {
      const line = FIXTURE_NUCLEI_JSONL[index];
      assert.ok(line !== undefined, `line ${index} が存在する`);
      assert.equal(isValidMatchLine(line), false, `line ${index} は意図的に不正 (quarantine 確認用)`);
    }

    const validLines = FIXTURE_NUCLEI_JSONL.filter((_, index) => !FIXTURE_NUCLEI_MALFORMED_LINE_INDEXES.includes(index));
    assert.equal(validLines.length, 5);
    const parsed = validLines.map((line) => JSON.parse(line) as NucleiLine);

    const keys = parsed.map((entry) => `${entry['template-id']}|${entry['matched-at']}`);
    assert.equal(new Set(keys).size, keys.length - 1, 'ちょうど 1 行の重複を含む');

    assert.ok(parsed.some((entry) => entry.info.severity === 'critical'), 'critical 正規化確認用の行');
    assert.ok(
      parsed.some((entry) => !entry['matched-at'].startsWith('http://fixture.target.test')),
      'scope 外 matched-at 確認用の行',
    );
  });
});
