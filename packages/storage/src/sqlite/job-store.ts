import type { DatabaseSync } from 'node:sqlite';
import type { BaselineFlowEvent, JobEvent } from '@scopepilot2/contracts';
import type { JobStore, StoredJob } from '@scopepilot2/core';
/** Workspace-scoped store. Summary and replay event commit atomically. */
export class SqliteJobStore implements JobStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  loadJobs(): readonly StoredJob[] { return this.read('SELECT record_json AS json FROM jobs'); }
  loadEvents(): readonly JobEvent[] { return this.read('SELECT event_json AS json FROM job_events ORDER BY seq'); }
  loadAudit(): readonly BaselineFlowEvent[] { return this.read('SELECT event_json AS json FROM audit_events ORDER BY seq'); }
  appendAudit(event: BaselineFlowEvent): void {
    this.db.prepare('INSERT INTO audit_events(job_id, event_json) VALUES (?, ?)').run(event.jobId ?? null, JSON.stringify(event));
  }
  save(job: StoredJob, event: JobEvent): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO jobs(job_id,state,record_json) VALUES (?,?,?) ON CONFLICT(job_id) DO UPDATE SET state=excluded.state,record_json=excluded.record_json').run(job.summary.jobId, job.summary.state, JSON.stringify(job));
      this.db.prepare('INSERT INTO job_events(seq,job_id,category,level,event_json) VALUES (?,?,?,?,?)').run(event.seq, event.jobId, event.category, event.level, JSON.stringify(event));
      this.db.exec('COMMIT');
    } catch (cause) { this.db.exec('ROLLBACK'); throw cause; }
  }
  private read<T>(sql: string): T[] { return (this.db.prepare(sql).all() as { json: string }[]).map(row => JSON.parse(row.json) as T); }
}
