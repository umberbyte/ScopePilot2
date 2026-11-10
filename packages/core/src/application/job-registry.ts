import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActiveScanExecutionEvent } from './baseline-flow.ts';
import { DomainError, type JobSummary, type JobState, type JobEvent, type JobCounters, type BaselineFlowEvent } from '@scopepilot2/contracts';

export interface StoredJob { readonly summary: JobSummary; readonly result?: unknown; readonly error?: string }
export interface JobStore {
  loadJobs(): readonly StoredJob[];
  loadEvents(): readonly JobEvent[];
  save(job: StoredJob, event: JobEvent): void;
  loadAudit(): readonly BaselineFlowEvent[];
  appendAudit(event: BaselineFlowEvent): void;
}
export const jobContext = new AsyncLocalStorage<{ jobId: string; registry: JobRegistry; runId?: string }>();
const transitions: Record<JobState, readonly JobState[]> = {
  Queued: ['Running', 'Stopped', 'Interrupted'], Running: ['Stopping', 'Completed', 'Stopped', 'Failed', 'Interrupted'],
  Stopping: ['Stopped', 'Failed', 'Interrupted'], Completed: [], Stopped: [], Failed: [], Interrupted: [],
};
/** Defence in depth: callers provide summaries only; never HTTP bodies or credentials. */
export function redactJobText(text: string): string {
  return text.replace(/((?:authorization|cookie|set-cookie|password|passwd|token|api[-_]?key)\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:password|token|key|secret|api_key|access_token)=)[^&#\s]*/gi, '$1[redacted]');
}
export class JobRegistry {
  private readonly jobs = new Map<string, StoredJob>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly log: JobEvent[];
  private readonly listeners = new Set<(event: JobEvent) => void>();
  private seq: number;
  private readonly eventCounts = new Map<string, number>();
  private readonly truncated = new Set<string>();
  private readonly batches = new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly store: JobStore | undefined;
  private readonly eventLimit: number;
  private readonly maxConcurrent: number;
  private workers = 0;
  private readonly queue: (() => void)[] = [];
  constructor(store?: JobStore, eventLimit = 50_000, maxConcurrent = 2) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new DomainError('ValidationFailed', 'invalid job concurrency');
    this.maxConcurrent = maxConcurrent;
    this.store = store;
    this.eventLimit = eventLimit;
    this.log = [...(store?.loadEvents() ?? [])];
    this.seq = this.log.at(-1)?.seq ?? 0;
    for (const e of this.log) {
      this.eventCounts.set(e.jobId, (this.eventCounts.get(e.jobId) ?? 0) + 1);
      if (e.messageKey === 'job.events.truncated') this.truncated.add(e.jobId);
    }
    for (const job of store?.loadJobs() ?? []) this.jobs.set(job.summary.jobId, job);
    for (const job of this.jobs.values()) if (this.active(job.summary.state)) this.transition(job.summary.jobId, 'Interrupted');
  }
  active(state: JobState): boolean { return ['Queued', 'Running', 'Stopping'].includes(state); }
  list(): readonly JobSummary[] { return [...this.jobs.values()].map(j => structuredClone(j.summary)); }
  aggregateCounters(ids = this.list().map(j => j.jobId)): JobCounters {
    const counters = ids.map(id => this.require(id).summary.counters);
    const sum = (key: 'requestsSent' | 'requestsReportedByEngine' | 'deniedByScope' | 'errors' | 'warnings' | 'findings'): number => counters.reduce((n, c) => n + (c[key] ?? 0), 0);
    return { requestsSent: sum('requestsSent'), ...(counters.some(c => c.requestsReportedByEngine !== undefined) ? { requestsReportedByEngine: sum('requestsReportedByEngine') } : {}),
      deniedByScope: sum('deniedByScope'), errors: sum('errors'), warnings: sum('warnings'), findings: sum('findings'),
      budget: { leased: counters.reduce((n, c) => n + c.budget.leased, 0), used: counters.reduce((n, c) => n + c.budget.used, 0), limit: Math.max(0, ...counters.map(c => c.budget.limit)) } };
  }
  get(id: string): StoredJob | undefined { const j = this.jobs.get(id); return j === undefined ? undefined : structuredClone(j); }
  events(): readonly JobEvent[] { return structuredClone(this.log); }
  subscribe(listener: (event: JobEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  create(input: Omit<JobSummary, 'jobId' | 'state' | 'createdAt' | 'counters' | 'lastEventSeq'> & { readonly budgetLimit?: number }): string {
    const id = randomUUID();
    const { budgetLimit, ...fields } = input;
    this.jobs.set(id, { summary: { ...fields, jobId: id, state: 'Queued', createdAt: new Date().toISOString(), lastEventSeq: 0,
      counters: { requestsSent: 0, budget: { leased: 0, used: 0, limit: budgetLimit ?? 0 }, deniedByScope: 0, errors: 0, warnings: 0, findings: 0 } } });
    this.controllers.set(id, new AbortController());
    this.emit(id, { category: 'lifecycle', messageKey: 'job.state.changed', message: 'Queued', params: { state: 'Queued' } });
    return id;
  }
  transition(id: string, state: JobState): void {
    const job = this.require(id);
    if (!transitions[job.summary.state].includes(state)) throw new DomainError('Conflict', `invalid job transition ${job.summary.state} -> ${state}`);
    const terminal = !this.active(state);
    if (terminal) this.flushBatch(id);
    job.summary = { ...job.summary, state, ...(state === 'Running' ? { startedAt: new Date().toISOString() } : {}),
      ...(terminal ? { endedAt: new Date().toISOString(), stopReason: state === 'Completed' ? 'completed' : state === 'Interrupted' ? 'interrupted' : state === 'Failed' ? 'engine-failure' : 'user-request' } : {}) };
    this.emit(id, { category: 'lifecycle', messageKey: 'job.state.changed', message: state, params: { state } });
    if (terminal) this.controllers.delete(id);
  }
  stop(id: string): JobSummary {
    const job = this.require(id);
    if (job.summary.state === 'Queued') { this.controllers.get(id)?.abort(); this.transition(id, 'Stopped'); }
    else if (job.summary.state === 'Running') { this.transition(id, 'Stopping'); this.controllers.get(id)?.abort(); }
    return this.get(id)!.summary;
  }
  execute<T>(id: string, operation: (signal: AbortSignal) => Promise<T>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push(() => {
        this.workers++;
        void this.run(id, operation).then(resolve, reject).finally(() => { this.workers--; this.pump(); });
      });
      this.pump();
    });
  }
  private pump(): void {
    while (this.workers < this.maxConcurrent && this.queue.length > 0) this.queue.shift()!();
  }
  private async run<T>(id: string, operation: (signal: AbortSignal) => Promise<T>): Promise<void> {
    if (this.require(id).summary.state !== 'Queued') return;
    const controller = this.controllers.get(id)!;
    this.transition(id, 'Running');
    await jobContext.run({ jobId: id, registry: this }, async () => {
      try {
        const result = await operation(controller.signal);
        this.require(id).result = result;
        this.transition(id, controller.signal.aborted ? 'Stopped' : 'Completed');
      } catch (cause) {
        this.require(id).error = redactJobText(cause instanceof Error ? cause.message : String(cause));
        if (!controller.signal.aborted && !(cause instanceof DomainError && cause.code === 'Cancelled')) this.emit(id, { category: 'error', level: 'error', messageKey: 'job.error', message: this.require(id).error!, params: {} });
        this.transition(id, controller.signal.aborted || (cause instanceof DomainError && cause.code === 'Cancelled') ? 'Stopped' : 'Failed');
      }
    });
  }
  recordScanEvent(id: string, event: ActiveScanExecutionEvent): void {
    this.emit(id, {
      at: event.at, category: 'phase', source: event.engine, route: event.phase,
      messageKey: 'job.phase', message: event.message, params: { phase: event.phase },
      ...(event.command === undefined ? {} : { refs: { command: event.command } }),
      ...(event.engine === 'scopepilot' ? {} : { estimated: true }),
      counters: {
        ...(event.progress === undefined ? {} : { progress: { done: event.progress, total: 100, unit: 'percent' } }),
        ...(event.requestsReportedByEngine === undefined ? {} : { requestsReportedByEngine: event.requestsReportedByEngine }),
      },
    });
  }
  bindRun(id: string, runId: string): void { const j = this.require(id); j.summary = { ...j.summary, runId }; }
  emit(id: string, input: Pick<JobEvent, 'category' | 'messageKey' | 'message' | 'params'> & Partial<Omit<JobEvent, 'seq' | 'jobId'>>): void {
    const job = this.require(id);
    // A soft cap retains important records; verbose records become one summary per second.
    const count = this.eventCounts.get(id) ?? 0;
    if (count >= this.eventLimit && input.messageKey !== 'job.request.batch' && ['request', 'phase', 'engine-log', 'budget'].includes(input.category)) {
      this.applyCounters(job, input);
      if (!this.truncated.has(id)) {
        this.truncated.add(id);
        this.emit(id, { category: 'warning', level: 'warn', messageKey: 'job.events.truncated', message: 'Verbose job events aggregated; inspect evidence for individual requests', params: {} });
      }
      const batch = this.batches.get(id);
      if (batch) batch.count++;
      else {
        const timer = setTimeout(() => this.flushBatch(id), 1000); timer.unref();
        this.batches.set(id, { count: 1, timer });
      }
      return;
    }
    this.applyCounters(job, input);
    const event: JobEvent = JSON.parse(JSON.stringify({ at: new Date().toISOString(), level: 'info', source: 'scopepilot', ...input, seq: ++this.seq, jobId: id }), (_key, value) => typeof value === 'string' ? redactJobText(value) : value);
    job.summary = { ...job.summary, lastEventSeq: event.seq };
    this.store?.save(job, event);
    this.log.push(event);
    this.eventCounts.set(id, count + 1);
    for (const listener of this.listeners) listener(event);
  }
  private flushBatch(id: string): void {
    const batch = this.batches.get(id);
    if (!batch) return;
    clearTimeout(batch.timer); this.batches.delete(id);
    this.emit(id, { category: 'request', messageKey: 'job.request.batch', message: 'Verbose events aggregated', params: { count: batch.count }, counters: this.require(id).summary.counters });
  }
  private applyCounters(job: StoredJob & { summary: JobSummary }, input: Partial<JobEvent>): void {
    const c = job.summary.counters;
    const counters: JobCounters = { ...c,
      warnings: c.warnings + (input.category === 'warning' ? 1 : 0), errors: c.errors + (input.category === 'error' ? 1 : 0),
      deniedByScope: c.deniedByScope + (input.category === 'egress-denied' ? 1 : 0), ...input.counters };
    for (const value of [...Object.values(counters), ...Object.values(counters.budget), ...(counters.progress === undefined ? [] : [counters.progress.done, counters.progress.total ?? 0])]) if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new DomainError('ValidationFailed', 'invalid job counter');
    job.summary = { ...job.summary, counters };
  }
  private require(id: string): { summary: JobSummary; result?: unknown; error?: string } {
    const job = this.jobs.get(id);
    if (!job) throw new DomainError('ValidationFailed', 'job was not found');
    return job as { summary: JobSummary; result?: unknown; error?: string };
  }
}
