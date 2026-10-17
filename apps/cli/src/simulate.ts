/**
 * `scopepilot simulate` command。`docs/design/19-cli-automation.md` §2・§5。
 * 固定 fixture 上で基準シナリオ (探索→能動診断→所見→報告) を完走させ、
 * 終了コード・監査 event・版情報を返す (F21-UT-009)。
 *
 * A0 では Core API HTTP server の代わりに core/simulation を直接呼ぶ
 * (トレーサビリティ決定「direct CLI」)。HTTP 契約への差し替え時に本 file だけを置き換える。
 */
import { DomainError, type BaselineFlowEvent } from '@scopepilot2/contracts';
import { runBaselineScenario } from '@scopepilot2/simulation';
import { exitCodeForDomainError, ExitCodes } from './exit-codes.ts';

export interface SimulateSummary {
  readonly schemaVersion: 'scopepilot2.simulate.v1';
  readonly command: 'simulate';
  readonly status: 'completed' | 'failed';
  readonly exitCode: number;
  readonly caseId: string;
  readonly explorePlanHash: string;
  readonly scanPlanHash: string;
  readonly reportModelHash: string;
  readonly exploredCount: number;
  readonly scannedCount: number;
  readonly findingsCount: number;
  readonly importedCount: number;
  readonly duplicateCount: number;
  readonly engineVersions: { readonly explorer: string; readonly zap: string };
  readonly capabilityFixtureHashes: {
    readonly playwright?: string;
    readonly zap?: string;
    readonly nuclei?: string;
  };
  readonly eventsCount: number;
  readonly failure?: { readonly code: string; readonly message: string };
}

export interface SimulateOutcome {
  readonly exitCode: number;
  readonly summary: SimulateSummary;
  readonly events: readonly BaselineFlowEvent[];
}

export interface SimulateOptions {
  readonly injectUnknownScanTarget?: boolean;
}

export async function runSimulate(options: SimulateOptions = {}): Promise<SimulateOutcome> {
  try {
    const result = await runBaselineScenario({
      ...(options.injectUnknownScanTarget === undefined
        ? {}
        : { injectUnknownScanTarget: options.injectUnknownScanTarget }),
    });
    const imported = result.events.find((event): event is Extract<BaselineFlowEvent, { type: 'FindingsImported' }> => event.type === 'FindingsImported');
    const zapSnapshot = result.capabilities.find((capability) => capability.engineKind === 'zap');
    const playwrightSnapshot = result.capabilities.find((capability) => capability.engineKind === 'playwright');
    const nucleiSnapshot = result.capabilities.find((capability) => capability.engineKind === 'nuclei');
    const findingsCount = result.findings.length;
    const exitCode = findingsCount > 0 ? ExitCodes.FindingsPresent : ExitCodes.Success;
    const summary: SimulateSummary = {
      schemaVersion: 'scopepilot2.simulate.v1',
      command: 'simulate',
      status: 'completed',
      exitCode,
      caseId: result.caseRecord.caseId,
      explorePlanHash: result.explorePlanHash,
      scanPlanHash: result.scanPlanHash,
      reportModelHash: result.report.modelHash,
      exploredCount: result.exploration.observations.length,
      scannedCount: result.activeScan.scanRequest.targets.length,
      findingsCount,
      importedCount: imported?.importedCount ?? 0,
      duplicateCount: imported?.duplicateCount ?? 0,
      engineVersions: {
        explorer: result.harness.explorer.engineVersion,
        zap: result.activeScan.engineVersion,
      },
      capabilityFixtureHashes: {
        ...(playwrightSnapshot?.fixtureHash === undefined ? {} : { playwright: playwrightSnapshot.fixtureHash }),
        ...(zapSnapshot?.fixtureHash === undefined ? {} : { zap: zapSnapshot.fixtureHash }),
        ...(nucleiSnapshot?.fixtureHash === undefined ? {} : { nuclei: nucleiSnapshot.fixtureHash }),
      },
      eventsCount: result.events.length,
    };
    return { exitCode, summary, events: result.events };
  } catch (cause) {
    if (!(cause instanceof DomainError)) {
      throw cause;
    }
    const exitCode = exitCodeForDomainError(cause.code);
    const summary: SimulateSummary = {
      schemaVersion: 'scopepilot2.simulate.v1',
      command: 'simulate',
      status: 'failed',
      exitCode,
      caseId: '',
      explorePlanHash: '',
      scanPlanHash: '',
      reportModelHash: '',
      exploredCount: 0,
      scannedCount: 0,
      findingsCount: 0,
      importedCount: 0,
      duplicateCount: 0,
      engineVersions: { explorer: '', zap: '' },
      capabilityFixtureHashes: {},
      eventsCount: 0,
      failure: { code: cause.code, message: cause.message },
    };
    return { exitCode, summary, events: [] };
  }
}
