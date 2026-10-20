import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BaselineFlowService, FixedClock, InMemoryEvidenceStore, SequentialIdGenerator } from '@scopepilot2/core';
import type { OperatorProfile } from '@scopepilot2/contracts';
import { NucleiRunner } from '../src/nuclei-runner.ts';
import { startVulnerableTarget } from './vulnerable-target.ts';

/**
 * nuclei templates 一式 (実環境の管理物・design/21) を使った取込確認。
 * 既定では skip。SCOPEPILOT_NUCLEI_COMMAND (binary) と
 * SCOPEPILOT_NUCLEI_TEMPLATES (templates dir) の両方で実行する。
 *   SCOPEPILOT_NUCLEI_COMMAND=C:/Users/GoSugawara/src/ScopePilot2/nuclei.exe \
 *   SCOPEPILOT_NUCLEI_TEMPLATES=C:/Users/GoSugawara/nuclei-templates \
 *   npm run test:gated -w @scopepilot2/adapters
 * 対象は所有している vulnerable-target (127.0.0.1) のみ。
 */
const nucleiCommand = process.env['SCOPEPILOT_NUCLEI_COMMAND'] ?? '';
const templatesDir = process.env['SCOPEPILOT_NUCLEI_TEMPLATES'] ?? '';
const gated = nucleiCommand !== '' && templatesDir !== '' ? describe : describe.skip;

const OPERATOR: OperatorProfile = {
  operatorId: 'operator-nuclei-library',
  displayName: 'Nuclei Library Operator',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

interface NucleiLine {
  readonly 'template-id': string;
  readonly 'matched-at': string;
  readonly info: { readonly severity: string; readonly name?: string };
}

gated('nuclei templates 一式の取込 (実 library・所有ターゲット)', () => {
  test('実 library の template が match し、JSONL 取込 (重複除外つき) が通る', { timeout: 300_000 }, async () => {
    const target = await startVulnerableTarget();
    try {
      // 1. 実 library の 1 template (misconfiguration/http-missing-security-headers):
      //    本体に security header が無い vulnerable-target に必ず match する。
      const runner = new NucleiRunner({
        command: nucleiCommand,
        argsPrefix: ['-t', `${templatesDir}/http/misconfiguration/http-missing-security-headers.yaml`],
        timeoutMs: 240_000,
      });
      const version = await runner.version();
      assert.match(version, /^nuclei v\d+\.\d+/);

      const result = await runner.run({ targets: [target.indexUrl] });
      assert.equal(result.engineVersion, version);
      assert.ok(result.lines.length >= 1, `match がない: ${result.lines.join(' / ')}`);
      const parsed = result.lines.map((line) => JSON.parse(line) as NucleiLine);
      assert.ok(parsed.every((line) => line['template-id'] === 'http-missing-security-headers'));
      assert.ok(parsed.every((line) => line['matched-at'].startsWith(target.base)));

      // 2. 実 library 出力の JSONL を取込 (product 経路・重複除外つき)。
      const service = new BaselineFlowService({
        clock: new FixedClock(['2026-10-20T11:00:00.000Z']),
        ids: new SequentialIdGenerator(),
        evidence: new InMemoryEvidenceStore(),
        explorer: { engineVersion: 'fixture', observe: async () => null },
        scanEngine: {
          engineVersion: 'fixture-zap',
          start: async () => 'run',
          progress: async () => ({ status: 'complete' as const, progress: 100, lastActivityAt: '', messageCount: 0 }),
          alerts: async (_id, cursor) => ({ alerts: [], nextCursor: cursor }),
          stop: async () => undefined,
        },
        capabilities: [],
        runtimeBundleHash: 'nuclei-library-it',
      });
      service.createCase(OPERATOR, {
        name: 'nuclei-library-it',
        allowedOrigins: [new URL(target.base).origin],
        deniedOrigins: [],
        limits: { maxRequests: 100, maxPages: 10, maxDurationMinutes: 5 },
      });
      const first = await service.importNucleiResults(OPERATOR, { engineVersion: version.replace('nuclei ', ''), lines: [...result.lines] });
      assert.ok(first.findings.length >= 1, '取込所見がない');
      const imported = first.findings[0];
      assert.ok(imported !== undefined);
      assert.ok(imported.url.startsWith(target.base));
      assert.ok(imported.source.kind === 'nuclei-match');

      // 再取込は新規 0・全行が重複 (batch 内同一 template+URL の畳み込み + 既存一致)。
      const second = await service.importNucleiResults(OPERATOR, { engineVersion: version.replace('nuclei ', ''), lines: [...result.lines] });
      assert.equal(second.importedCount, 0);
      assert.equal(second.duplicateCount, result.lines.length);
      assert.equal(second.findings.length, first.findings.length);
    } finally {
      target.server.close();
    }
  });

  test('directory 指定 (-t dir) でも実 library が走り JSONL が解析できる', { timeout: 300_000 }, async () => {
    const target = await startVulnerableTarget();
    try {
      // exposures/configs は小さめの実サブセット。match の有無は保証しない —
      // 実 library を directory 指定で走らせ、出力形式が解析可能であることの確認。
      const runner = new NucleiRunner({
        command: nucleiCommand,
        argsPrefix: ['-t', `${templatesDir}/http/exposures/configs`, '-silent'],
        timeoutMs: 240_000,
      });
      const result = await runner.run({ targets: [target.plainUrl] });
      assert.equal(result.engineVersion, (await runner.version()));
      for (const line of result.lines) {
        const parsed = JSON.parse(line) as NucleiLine;
        assert.ok(typeof parsed['template-id'] === 'string');
        assert.ok(typeof parsed.info.severity === 'string');
      }
    } finally {
      target.server.close();
    }
  });
});
