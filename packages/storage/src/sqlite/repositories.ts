/**
 * SQLite repository 群。`docs/design/20-storage-evidence.md` §3。
 * core の port を実装し、逆方向の import を作らない。
 * crash 検出 (design/22 §6): Running/Stopping の run を Interrupted として検出し、
 * 自動再開は行わない。
 */
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, hashStable, type CaseRecord, type Finding, type RunRecord, type StopReason } from '@scopepilot2/contracts';
import type { EvidenceStorePort, StoredEvidence } from '@scopepilot2/core';
import { RunStateMachine } from '@scopepilot2/core';

/** EvidenceStorePort の SQLite 実装。原本 hash は content hash を正本とする。 */
export class SqliteEvidenceStore implements EvidenceStorePort {
  private readonly db: DatabaseSync;
  private sequence = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM evidence_objects').get() as { c: number };
    this.sequence = row.c;
  }

  async saveText(label: string, content: string, metadata?: Readonly<Record<string, string>>): Promise<StoredEvidence> {
    this.sequence += 1;
    const evidence: StoredEvidence = {
      evidenceId: `evidence-${String(this.sequence).padStart(4, '0')}`,
      sha256: hashStable('scopepilot2.evidence', content),
      label,
      savedAt: new Date().toISOString(),
      ...(metadata === undefined || Object.keys(metadata).length === 0 ? {} : { metadata }),
    };
    this.db
      .prepare('INSERT INTO evidence_objects (evidence_id, label, sha256, saved_at, metadata_json) VALUES (?, ?, ?, ?, ?)')
      .run(evidence.evidenceId, evidence.label, evidence.sha256, evidence.savedAt, metadata === undefined ? null : canonicalJson(metadata));
    return evidence;
  }

  list(): readonly StoredEvidence[] {
    const rows = this.db.prepare('SELECT evidence_id, label, sha256, saved_at, metadata_json FROM evidence_objects ORDER BY evidence_id').all() as {
      evidence_id: string;
      label: string;
      sha256: string;
      saved_at: string;
      metadata_json: string | null;
    }[];
    return rows.map((row) => ({
      evidenceId: row.evidence_id,
      label: row.label,
      sha256: row.sha256,
      savedAt: row.saved_at,
      ...(row.metadata_json === null ? {} : { metadata: JSON.parse(row.metadata_json) as Record<string, string> }),
    }));
  }
}

export class CaseRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  save(record: CaseRecord): void {
    this.db
      .prepare(
        'INSERT INTO cases (case_id, name, revision, scope_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(case_id) DO UPDATE SET name = excluded.name, revision = excluded.revision, scope_json = excluded.scope_json',
      )
      .run(record.caseId, record.name, record.revision, canonicalJson(record.scope), record.createdAt);
  }

  get(caseId: string): CaseRecord | null {
    const row = this.db.prepare('SELECT case_id, name, revision, scope_json, created_at FROM cases WHERE case_id = ?').get(caseId) as
      | { case_id: string; name: string; revision: number; scope_json: string; created_at: string }
      | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      caseId: row.case_id,
      name: row.name,
      revision: row.revision,
      scope: JSON.parse(row.scope_json) as CaseRecord['scope'],
      createdAt: row.created_at,
    };
  }
}

export class RunRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  save(record: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, plan_id, case_id, state, attempt, stop_reason, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET state = excluded.state, stop_reason = excluded.stop_reason, ended_at = excluded.ended_at`,
      )
      .run(record.runId, record.planId, record.caseId, record.state, record.attempt, record.stopReason ?? null, record.startedAt ?? null, record.endedAt ?? null);
  }

  get(runId: string): RunRecord | null {
    const row = this.db.prepare('SELECT run_id, plan_id, case_id, state, attempt, stop_reason, started_at, ended_at FROM runs WHERE run_id = ?').get(runId) as
      | { run_id: string; plan_id: string; case_id: string; state: RunRecord['state']; attempt: number; stop_reason: string | null; started_at: string | null; ended_at: string | null }
      | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      runId: row.run_id,
      planId: row.plan_id,
      caseId: row.case_id,
      state: row.state,
      attempt: row.attempt,
      ...(row.stop_reason === null ? {} : { stopReason: row.stop_reason as StopReason }),
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    };
  }

  /** crash 検出: 実行中の run を列挙する (design/22 §6)。 */
  listInterruptedCandidates(): readonly RunRecord[] {
    const rows = this.db
      .prepare("SELECT run_id, plan_id, case_id, state, attempt, stop_reason, started_at, ended_at FROM runs WHERE state IN ('Running', 'Stopping')")
      .all() as { run_id: string; plan_id: string; case_id: string; state: RunRecord['state']; attempt: number; stop_reason: string | null; started_at: string | null; ended_at: string | null }[];
    return rows.map((row) => ({
      runId: row.run_id,
      planId: row.plan_id,
      caseId: row.case_id,
      state: row.state,
      attempt: row.attempt,
      ...(row.stop_reason === null ? {} : { stopReason: row.stop_reason as StopReason }),
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    }));
  }

  /** 検出した実行中 run を Interrupted へ。自動再開は行わない。 */
  markInterrupted(): readonly RunRecord[] {
    const interrupted: RunRecord[] = [];
    for (const run of this.listInterruptedCandidates()) {
      const next = RunStateMachine.detectInterrupted(run.state);
      if (next === null) {
        continue;
      }
      const updated: RunRecord = { ...run, state: next, stopReason: 'interrupted', endedAt: new Date().toISOString() };
      this.save(updated);
      interrupted.push(updated);
    }
    return interrupted;
  }
}

export class FindingRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 同一 (case, dedupe key) は新規作らず観測回数を増やす (F11-UT-006 の保存側)。 */
  upsert(caseId: string, dedupeKey: string, finding: Finding): { inserted: boolean; occurrences: number } {
    const existing = this.db.prepare('SELECT finding_id, occurrences FROM findings WHERE case_id = ? AND dedupe_key = ?').get(caseId, dedupeKey) as
      | { finding_id: string; occurrences: number }
      | undefined;
    if (existing === undefined) {
      this.db
        .prepare(
          `INSERT INTO findings (finding_id, case_id, dedupe_key, title, severity, status, url, source_json, first_seen_at, last_seen_at, occurrences)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          finding.findingId,
          caseId,
          dedupeKey,
          finding.title,
          finding.severity,
          finding.status,
          finding.url,
          canonicalJson(finding.source),
          finding.firstSeenAt,
          finding.lastSeenAt,
        );
      return { inserted: true, occurrences: 1 };
    }
    const occurrences = existing.occurrences + 1;
    this.db
      .prepare('UPDATE findings SET occurrences = ?, last_seen_at = ? WHERE finding_id = ?')
      .run(occurrences, finding.lastSeenAt, existing.finding_id);
    return { inserted: false, occurrences };
  }

  list(caseId: string): readonly Finding[] {
    const rows = this.db
      .prepare('SELECT finding_id, title, severity, status, url, source_json, first_seen_at, last_seen_at, occurrences FROM findings WHERE case_id = ? ORDER BY finding_id')
      .all(caseId) as {
      finding_id: string;
      title: string;
      severity: string;
      status: string;
      url: string;
      source_json: string;
      first_seen_at: string;
      last_seen_at: string;
      occurrences: number;
    }[];
    return rows.map((row) => ({
      findingId: row.finding_id,
      title: row.title,
      source: JSON.parse(row.source_json) as Finding['source'],
      url: row.url,
      severity: row.severity as Finding['severity'],
      status: row.status as Finding['status'],
      evidenceRefs: [],
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      occurrences: row.occurrences,
    }));
  }
}
