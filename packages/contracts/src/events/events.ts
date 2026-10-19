/** 基準シナリオの監査 event。`docs/design/19-cli-automation.md` 5章、`docs/design/22-execution-control.md`。 */
import type { FindingSourceKind } from '../findings/findings.ts';
import type { StopReason } from '../common/runtime.ts';

export type BaselineFlowEvent =
  | { readonly type: 'CaseCreated'; readonly at: string; readonly caseId: string; readonly revision: number }
  | { readonly type: 'CaseScopeUpdated'; readonly at: string; readonly caseId: string; readonly revision: number; readonly narrowed: boolean }
  | { readonly type: 'ConfirmationsInvalidated'; readonly at: string; readonly caseId: string; readonly confirmationIds: readonly string[]; readonly reason: string }
  | { readonly type: 'AuthorizationGranted'; readonly at: string; readonly authorizationId: string; readonly caseId: string }
  | { readonly type: 'PlanValidated'; readonly at: string; readonly planHash: string }
  | { readonly type: 'PlanAuthorized'; readonly at: string; readonly planHash: string; readonly authorizationId: string }
  | { readonly type: 'PlanConfirmed'; readonly at: string; readonly planHash: string; readonly confirmedBy: string }
  | { readonly type: 'RunStarted'; readonly at: string; readonly runId: string; readonly planHash: string }
  | { readonly type: 'RunCompleted'; readonly at: string; readonly runId: string; readonly stopReason: StopReason }
  | { readonly type: 'EgressDenied'; readonly at: string; readonly url: string; readonly reason: string }
  | { readonly type: 'CandidatesAdopted'; readonly at: string; readonly adoptedCount: number }
  | { readonly type: 'FindingsImported'; readonly at: string; readonly source: FindingSourceKind; readonly engineVersion?: string; readonly importedCount: number; readonly duplicateCount: number }
  | { readonly type: 'FindingStatusChanged'; readonly at: string; readonly findingId: string; readonly from: string; readonly to: string; readonly changedBy: string }
  | { readonly type: 'FuzzRunCompleted'; readonly at: string; readonly runId: string; readonly targetUrl: string; readonly total: number; readonly sent: number }
  | { readonly type: 'ReportGenerated'; readonly at: string; readonly reportId: string; readonly modelHash: string };
