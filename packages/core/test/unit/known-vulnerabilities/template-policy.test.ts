import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hashStable } from '@scopepilot2/contracts';
import {
  buildProcessCommand,
  classifyRunOutcome,
  importMatches,
  normalizeNucleiSeverity,
  parseNucleiJsonl,
  selectPlanTargets,
  validateTemplateBundle,
  validateTemplateProtocol,
  verifyTemplateCatalog,
} from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';
import type { NucleiTemplate } from '@scopepilot2/core';

const scope = { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] };
const template = (protocol: string, content = 'id: t\nhttp:\n  - method: GET\n    path: /x\n'): NucleiTemplate => ({
  templateId: 't-1',
  protocol,
  content,
});

/** 実 fixture と同形の合成 JSONL (core の unit test は simulation package に依存しない)。 */
const NUCLEI_JSONL: readonly string[] = [
  '{"template-id":"fixture-missing-header.yaml","matcher-name":"x-content-type-options","matched-at":"http://fixture.target.test/","info":{"severity":"info","name":"Fixture: missing security header"}}',
  '{"template-id":"fixture-verbose-path.yaml","matcher-name":"setup","matched-at":"http://fixture.target.test/setup.php","info":{"severity":"info","name":"Fixture: exposed setup path"}}',
];

describe('nuclei template policy (F18)', () => {
  test('[F18-UT-001] code protocol は拒否する', () => {
    assert.throws(() => validateTemplateProtocol(template('code')), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'ValidationFailed');
      assert.match((error as DomainError).message, /HTTP-only allowlist/);
      return true;
    });
    assert.doesNotThrow(() => validateTemplateProtocol(template('http')));
  });

  test('[F18-UT-002] size/count 超過は bounded error', () => {
    assert.throws(() => validateTemplateBundle(Array.from({ length: 1001 }, (_, i) => template('http', `id: t${i}\n`))), /exceeds 1000 templates/);
    const huge = 'x'.repeat(512 * 1024 + 1);
    assert.throws(() => validateTemplateBundle([template('http', huge)]), /exceeds 524288 bytes/);
    assert.doesNotThrow(() => validateTemplateBundle([template('http')]));
  });

  test('[F18-UT-003] scope 外 target は plan に入れない', () => {
    assert.deepEqual(
      selectPlanTargets(['http://fixture.target.test/', 'http://elsewhere.example/'], scope),
      ['http://fixture.target.test/'],
    );
  });

  test('[F18-UT-004] metachar を含む path も引数として保持し、shell を使わない', () => {
    const argv = buildProcessCommand('C:/tools/nuclei/nuclei.exe', ['-target', 'http://x.test/a;b&c|d', '-jsonl']);
    assert.ok(Array.isArray(argv));
    assert.equal(argv[0], 'C:/tools/nuclei/nuclei.exe');
    assert.equal(argv[2], 'http://x.test/a;b&c|d');
    assert.ok(!argv.some((arg) => /sh -c|cmd \/c/.test(arg)), 'shell 経由の文字列を含まない');
    assert.throws(() => buildProcessCommand('nuclei', ['a\0b']), /NUL/);
  });

  test('[F18-UT-005] 同一 JSONL 再取込は dedupe する (実 fixture 使用)', () => {
    const first = parseNucleiJsonl(NUCLEI_JSONL);
    assert.equal(first.matches.length, 2);
    assert.equal(first.quarantined, 0);
    const reimported = importMatches([...first.matches, ...first.matches]);
    assert.equal(reimported.imported.length, 2);
    assert.equal(reimported.duplicates, 2);
    const broken = parseNucleiJsonl(['{invalid json', '{"template-id":"x"}']);
    assert.equal(broken.quarantined, 2);
  });

  test('[F18-UT-006] 未知 severity は Unknown と原値を保持する', () => {
    assert.deepEqual(normalizeNucleiSeverity('critical'), { severity: 'high', sourceSeverity: 'critical' });
    assert.deepEqual(normalizeNucleiSeverity('high'), { severity: 'high', sourceSeverity: 'high' });
    assert.deepEqual(normalizeNucleiSeverity('super-critical'), { severity: 'unknown', sourceSeverity: 'super-critical' });
  });

  test('[F18-UT-007] partial/cancel は success と区別する', () => {
    assert.equal(classifyRunOutcome(10, 10, false), 'success');
    assert.equal(classifyRunOutcome(7, 10, false), 'partial');
    assert.equal(classifyRunOutcome(3, 10, true), 'cancelled');
  });

  test('[F18-UT-008] hash/signature 不一致の template は実行拒否する', () => {
    const content = 'id: fixture-header-missing\nhttp:\n  - method: GET\n    path: /\n';
    const sha256 = hashStable('scopepilot2.nuclei.template', { id: 'fixture-header-missing', content });
    assert.equal(verifyTemplateCatalog({ templateId: 'fixture-header-missing', content, sha256 }).allowed, true);
    assert.equal(verifyTemplateCatalog({ templateId: 'fixture-header-missing', content: content + ' ', sha256 }).allowed, false);
  });
});
