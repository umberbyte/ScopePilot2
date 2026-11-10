import type { ExecutionPlan, PlanConfirmation } from '../plan/plan.ts';
import type { ScanCandidate } from '../explore/explore.ts';
import type { StopReason } from '../common/runtime.ts';

export const JobKinds = ['crawl', 'active-scan', 'fuzz', 'repeater-send', 'template-check', 'login', 'sequencer', 'ws-send', 'oast-poll', 'dom-observe', 'interactive-diagnostics', 'proxy-session', 'report'] as const;
export type JobKind = typeof JobKinds[number];
export const JobStates = ['Queued', 'Running', 'Stopping', 'Completed', 'Stopped', 'Failed', 'Interrupted'] as const;
export type JobState = typeof JobStates[number];
export interface JobCounters {
  readonly requestsSent: number;
  readonly requestsReportedByEngine?: number;
  readonly budget: { readonly leased: number; readonly used: number; readonly limit: number };
  readonly pagesVisited?: number;
  readonly queued?: number;
  readonly deniedByScope: number;
  readonly errors: number;
  readonly warnings: number;
  readonly findings: number;
  readonly progress?: { readonly done: number; readonly total?: number; readonly unit: 'pages' | 'requests' | 'checks' | 'percent' | 'samples' };
}
export interface JobSummary {
  readonly jobId: string;
  readonly kind: JobKind;
  readonly parentJobId?: string;
  readonly runId?: string;
  readonly planHash?: string;
  readonly label: string;
  readonly role?: string;
  readonly state: JobState;
  readonly stopReason?: StopReason;
  readonly guarantee: 'Enforced' | 'Delegated' | 'Mixed';
  readonly transport: 'live' | 'fixture';
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly counters: JobCounters;
  readonly lastEventSeq: number;
}
/** P0 exposes active-scan; subsequent stages extend this discriminated union. */
export type StartJobRequest = {
  readonly kind: 'active-scan';
  readonly plan: ExecutionPlan;
  readonly confirmation: PlanConfirmation;
  readonly params: { readonly adopted: readonly ScanCandidate[]; readonly role?: string };
};
export interface ScanExecutionStatus {
  readonly executionId: string;
  readonly state: 'queued' | 'running' | 'stopping' | 'completed' | 'stopped' | 'failed' | 'interrupted';
  readonly currentEngine: 'scopepilot' | 'zap' | 'nuclei';
  readonly currentCommand: string;
  readonly progress: number;
  readonly logs: readonly string[];
  readonly result?: unknown;
  readonly error?: string;
}
