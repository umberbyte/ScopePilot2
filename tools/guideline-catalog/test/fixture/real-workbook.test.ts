import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { buildCatalog } from '../../src/generate.ts';
import { readWorkbook } from '../../src/xlsx.ts';

const WORKBOOK_PATH = fileURLToPath(new URL('../../../../docs/WebAppPentestGuidelines_診断項目_ScopePilot_作業用.xlsx', import.meta.url));
/** 2026-10-18 の設計確認 (docs/design/27 §3, work log) で固定した原本 hash。 */
const EXPECTED_SHA256 = '33d32b195f84a36a77dd0eadeecfb490d0034a6dc6b2b41803af5ac8c99b882c';

describe('診断項目 workbook からの catalog 生成 (design/27)', () => {
  test('[F27-FT-001] workbook は 14 sheet・固定 hash で、出典座標つき catalog が生成できる', () => {
    const buffer = readFileSync(WORKBOOK_PATH);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    assert.equal(sha256, EXPECTED_SHA256);

    const sheets = readWorkbook(buffer);
    assert.equal(sheets.length, 14);

    const catalog = buildCatalog(sheets, { workbookPath: 'docs/WebAppPentestGuidelines_診断項目_ScopePilot_作業用.xlsx', sha256 });
    assert.equal(catalog.counts.guidelineChecks, 769);
    assert.equal(catalog.counts.zapRules, 102);
    // 末尾の注記行 (※…) はデータ行に数えない。
    assert.equal(catalog.counts.zapUnsupportedThemes, 92);
    assert.equal(catalog.source.importerVersion, 1);

    // ガイドライン 6 sheet すべてに出典 note と項目がいる。
    assert.equal(catalog.guidelines.length, 6);
    for (const guideline of catalog.guidelines) {
      assert.ok(guideline.sourceNote.length > 0);
      assert.ok(guideline.checks.length > 0);
      for (const check of guideline.checks) {
        assert.ok(check.row > 0, 'source 座標 (行番号) を保持する');
        assert.ok(check.itemId.length > 0);
      }
    }
    const first = catalog.guidelines[0]?.checks[0];
    assert.equal(first?.sheet, 'OWASP Top 10-2025');
    assert.equal(first?.itemId, 'A01');

    // ZAP rule は識別列と座標を持ち、ペイロード・手順の長文列は複写しない。
    const rule = catalog.zapRules[0];
    assert.equal(rule?.ruleId, '0');
    assert.ok(rule !== undefined && !('payload' in rule) && !('procedure' in rule));
    for (const candidate of catalog.zapRules) {
      assert.ok(candidate.sheet === 'ZAP診断ルールと実ペイロード' && candidate.row > 0);
    }
  });

  test('[F27-FT-002] catalog は決定的で、同じ入力から同じ catalog hash を作る', () => {
    const buffer = readFileSync(WORKBOOK_PATH);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const first = buildCatalog(readWorkbook(buffer), { workbookPath: 'docs/x.xlsx', sha256 });
    const second = buildCatalog(readWorkbook(buffer), { workbookPath: 'docs/x.xlsx', sha256 });
    assert.equal(first.catalogHash, second.catalogHash);
    assert.match(first.catalogHash, /^[0-9a-f]{64}$/);
    // source hash が変われば catalog hash も変わる。
    const different = buildCatalog(readWorkbook(buffer), { workbookPath: 'docs/x.xlsx', sha256: '0'.repeat(64) });
    assert.notEqual(first.catalogHash, different.catalogHash);
  });
});
