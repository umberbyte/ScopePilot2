import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { OutputFormatter, type OutputWriters } from '../../src/output-formatter.ts';
import type { SimulateSummary } from '../../src/simulate.ts';

function writers(): OutputWriters & { stdoutLines: string[]; stderrLines: string[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    stdout: (line) => {
      stdoutLines.push(line);
    },
    stderr: (line) => {
      stderrLines.push(line);
    },
  };
}

const summary: SimulateSummary = {
  schemaVersion: 'scopepilot2.simulate.v1',
  command: 'simulate',
  status: 'completed',
  exitCode: 4,
  caseId: 'case-0001',
  explorePlanHash: 'explore-hash',
  scanPlanHash: 'scan-hash',
  reportModelHash: 'report-hash',
  exploredCount: 5,
  scannedCount: 5,
  findingsCount: 3,
  importedCount: 3,
  duplicateCount: 1,
  engineVersions: { explorer: 'fixture-playwright-1', zap: '2.17.0-fixture' },
  capabilityFixtureHashes: { zap: 'zap-fixture-hash' },
  eventsCount: 16,
};

describe('OutputFormatter', () => {
  test('[F21-UT-004] --json では進捗は stderr のみ、結果は stdout へ 1 行だけ', () => {
    const w = writers();
    const formatter = new OutputFormatter({ json: true }, w);
    formatter.progress({ type: 'CaseCreated', at: '2026-10-18T09:00:00.000Z', caseId: 'case-0001', revision: 1 });
    formatter.progress({ type: 'RunStarted', at: '2026-10-18T09:02:00.000Z', runId: 'run-0001', planHash: 'explore-hash' });
    formatter.result(summary);

    assert.equal(w.stdoutLines.length, 1);
    const parsed: unknown = JSON.parse(w.stdoutLines[0] ?? '');
    assert.ok(typeof parsed === 'object' && parsed !== null);
    assert.equal((parsed as SimulateSummary).schemaVersion, 'scopepilot2.simulate.v1');
    assert.equal(w.stderrLines.length, 2);
    for (const line of w.stderrLines) {
      const event: unknown = JSON.parse(line);
      assert.ok(typeof event === 'object' && event !== null && 'type' in (event as Record<string, unknown>));
    }
  });

  test('[F21-UT-004] human 出力でも進捗が stdout を汚さない', () => {
    const w = writers();
    const formatter = new OutputFormatter({ json: false }, w);
    formatter.progress({ type: 'CaseCreated', at: '2026-10-18T09:00:00.000Z', caseId: 'case-0001', revision: 1 });
    formatter.result(summary);

    assert.equal(w.stderrLines.length, 1);
    assert.ok(w.stdoutLines.length > 1);
    assert.ok(w.stdoutLines.every((line) => !line.startsWith('{"type"')));
  });
});
