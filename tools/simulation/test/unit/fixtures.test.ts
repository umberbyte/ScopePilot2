import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  FIXTURE_NUCLEI_JSONL,
  nucleiJsonlFixtureHash,
  targetSiteFixtureHash,
  zapAlertsFixtureHash,
} from '@scopepilot2/simulation';

describe('simulation fixtures', () => {
  test('fixture hash は呼出しごとに安定している', () => {
    assert.equal(targetSiteFixtureHash(), targetSiteFixtureHash());
    assert.equal(zapAlertsFixtureHash(), zapAlertsFixtureHash());
    assert.equal(nucleiJsonlFixtureHash(), nucleiJsonlFixtureHash());
  });

  test('Nuclei JSONL fixture の各行は JSON として解析できる (F18 取込の前提)', () => {
    for (const line of FIXTURE_NUCLEI_JSONL) {
      const parsed: unknown = JSON.parse(line);
      assert.ok(typeof parsed === 'object' && parsed !== null);
      assert.ok('template-id' in (parsed as Record<string, unknown>));
    }
  });
});
