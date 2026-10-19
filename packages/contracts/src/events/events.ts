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
  | { readonly type: 'BusinessLogicCheckCompleted'; readonly at: string; readonly checkId: string; readonly roles: readonly string[]; readonly status: string }
  | { readonly type: 'LoginCompleted'; readonly at: string; readonly role: string; readonly authenticated: boolean; readonly secretReferences: readonly string[] }
  | { readonly type: 'DocumentHintsRegistered'; readonly at: string; readonly documentLabel: string; readonly urlCount: number; readonly acceptedUrlCount: number }
  | { readonly type: 'DocumentAuthHintsRegistered'; readonly at: string; readonly documentLabel: string; readonly entryCount: number }
  | { readonly type: 'DocumentPriorityHintsRegistered'; readonly at: string; readonly documentLabel: string; readonly ruleCount: number }
  | { readonly type: 'DocumentParameterHintsRegistered'; readonly at: string; readonly documentLabel: string; readonly parameterCount: number }
  | { readonly type: 'CaProfileTrustChanged'; readonly at: string; readonly profileId: string; readonly trusted: boolean }
  | { readonly type: 'SequencerSessionCompleted'; readonly at: string; readonly sessionId: string; readonly targetUrl: string; readonly verdict: 'assessed' | 'insufficient'; readonly sampleCount: number; readonly duplicates: number; readonly missing: number }
  | { readonly type: 'ApiSpecImported'; readonly at: string; readonly documentLabel: string; readonly endpointCount: number; readonly excludedServerCount: number }
  | { readonly type: 'OastAttemptStarted'; readonly at: string; readonly attemptId: string; readonly targetUrl: string; readonly protocol: 'http' | 'dns' | 'smtp' | 'icmp' }
  | { readonly type: 'OastCallbacksRecorded'; readonly at: string; readonly kept: number; readonly duplicates: number; readonly correlated: number; readonly uncorrelated: number }
  | { readonly type: 'WsFramesImported'; readonly at: string; readonly targetUrl: string; readonly imported: number; readonly duplicates: number }
  | { readonly type: 'WsMessagesSent'; readonly at: string; readonly targetUrl: string; readonly sent: number; readonly rejected?: 'size' | 'rate' }
  | { readonly type: 'TransportNegotiated'; readonly at: string; readonly targetUrl: string; readonly protocol: 'h2' | 'http/1.1'; readonly downgraded: boolean }
  | { readonly type: 'ExtensionInstalled'; readonly at: string; readonly extensionId: string; readonly version: string }
  | { readonly type: 'ReportGenerated'; readonly at: string; readonly reportId: string; readonly modelHash: string };
