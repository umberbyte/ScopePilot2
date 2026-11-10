import type { JobCounters } from './jobs.ts';
export const JobEventCategories = ['lifecycle', 'phase', 'request', 'egress-denied', 'budget', 'engine-log', 'finding', 'warning', 'error'] as const;
export type JobEventCategory = typeof JobEventCategories[number];
export const JobMessageKeys = ['job.state.changed', 'job.phase', 'job.request.sent', 'job.request.batch', 'job.egress.denied', 'job.findings.imported', 'job.error', 'job.events.truncated'] as const;
export type JobMessageKey = typeof JobMessageKeys[number];
export interface JobEvent {
  readonly seq: number;
  readonly jobId: string;
  readonly at: string;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly category: JobEventCategory;
  readonly source: 'scopepilot' | 'zap' | 'nuclei' | 'playwright' | 'interactsh' | 'engine';
  readonly route?: string;
  readonly messageKey: JobMessageKey;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly message: string;
  readonly estimated?: boolean;
  /** Absolute snapshot of fields changed by this event (never an implicit delta). */
  readonly counters?: Partial<JobCounters>;
  readonly refs?: { readonly exchangeId?: string; readonly evidenceId?: string; readonly findingId?: string; readonly url?: string; readonly command?: string };
}
