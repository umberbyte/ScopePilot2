/**
 * 出力の分離。`docs/design/19-cli-automation.md` §3、f21 §4。
 * `--json` では最終結果のみ stdout へ 1 つ出し、進捗 (NDJSON) は stderr だけへ出す (F21-UT-004)。
 */
import type { BaselineFlowEvent } from '@scopepilot2/contracts';
import type { SimulateSummary } from './simulate.ts';

export interface OutputWriters {
  stdout(line: string): void;
  stderr(line: string): void;
}

export class OutputFormatter {
  private readonly json: boolean;
  private readonly writers: OutputWriters;

  constructor(options: { json: boolean }, writers: OutputWriters) {
    this.json = options.json;
    this.writers = writers;
  }

  /** 進捗は NDJSON として stderr へ。stdout へ出さない。 */
  progress(event: BaselineFlowEvent): void {
    this.writers.stderr(JSON.stringify(event));
  }

  /** 最終結果。json は stdout へ 1 行だけ。 */
  result(summary: SimulateSummary): void {
    if (this.json) {
      this.writers.stdout(JSON.stringify(summary));
      return;
    }
    for (const line of humanLines(summary)) {
      this.writers.stdout(line);
    }
  }
}

function humanLines(summary: SimulateSummary): readonly string[] {
  const lines: string[] = [];
  lines.push(`simulate: ${summary.status} (exit ${summary.exitCode})`);
  lines.push(`- case: ${summary.caseId}`);
  lines.push(`- explore plan hash: ${summary.explorePlanHash}`);
  lines.push(`- active scan plan hash: ${summary.scanPlanHash}`);
  lines.push(`- explored URLs: ${summary.exploredCount}, scanned URLs: ${summary.scannedCount}`);
  lines.push(`- findings: ${summary.findingsCount} (imported ${summary.importedCount}, duplicates ${summary.duplicateCount})`);
  lines.push(`- engines: explorer ${summary.engineVersions.explorer}, zap ${summary.engineVersions.zap}`);
  lines.push(`- zap capability fixture hash: ${summary.capabilityFixtureHashes.zap ?? '(none)'}`);
  lines.push(`- report model hash: ${summary.reportModelHash}`);
  lines.push(`- audit events: ${summary.eventsCount}`);
  if (summary.failure !== undefined) {
    lines.push(`- failure: ${summary.failure.code}: ${summary.failure.message}`);
  }
  return lines;
}
