/**
 * migration。`docs/design/20-storage-evidence.md` §7 (移行と削除)。
 * 各 migration は transaction の内側で適用し、失敗時は rollback して次へ進まない。
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline-a0',
    statements: [
      `CREATE TABLE IF NOT EXISTS cases (
        case_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        revision INTEGER NOT NULL,
        scope_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS authorizations (
        authorization_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(case_id),
        allowed_json TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        evidence_id TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        case_id TEXT NOT NULL REFERENCES cases(case_id),
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        stop_reason TEXT,
        started_at TEXT,
        ended_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS findings (
        finding_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(case_id),
        dedupe_key TEXT NOT NULL,
        title TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        url TEXT NOT NULL,
        source_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        occurrences INTEGER NOT NULL DEFAULT 1,
        UNIQUE(case_id, dedupe_key)
      )`,
      `CREATE TABLE IF NOT EXISTS evidence_objects (
        evidence_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        metadata_json TEXT
      )`,
    ],
  },
  {
    version: 2,
    name: 'case-workspace',
    statements: [
      `CREATE TABLE IF NOT EXISTS workspace_settings (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        start_url TEXT NOT NULL,
        supporting_origins_json TEXT NOT NULL,
        target_roles_json TEXT NOT NULL,
        forbidden_actions_json TEXT NOT NULL,
        ai_provider TEXT NOT NULL,
        ai_model TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS input_sources (
        input_id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        imported_at TEXT NOT NULL,
        UNIQUE (sha256, original_name)
      )`,
      'CREATE INDEX IF NOT EXISTS input_sources_sha256_idx ON input_sources (sha256)',
    ],
  },
  {
    version: 3,
    name: 'ai-assistance-audit',
    statements: [
      `CREATE TABLE IF NOT EXISTS ai_invocations (
        invocation_id TEXT PRIMARY KEY,
        task_kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        output_hash TEXT,
        status TEXT NOT NULL,
        proposal_json TEXT,
        error_message TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS ai_invocations_task_idx ON ai_invocations (task_kind, completed_at)',
    ],
  },
  {
    version: 4,
    name: 'durable-findings',
    statements: [
      'ALTER TABLE findings ADD COLUMN finding_json TEXT',
      'CREATE INDEX IF NOT EXISTS findings_case_seen_idx ON findings (case_id, last_seen_at)',
    ],
  },
  {
    version: 5,
    name: 'canonical-run-states',
    statements: [
      "UPDATE runs SET state = 'Completed', stop_reason = 'completed' WHERE state = 'Succeeded'",
      "UPDATE runs SET state = 'Stopped', stop_reason = CASE WHEN stop_reason IN ('user-request', 'budget-exhausted', 'scope-violation', 'authorization-expired') THEN stop_reason ELSE 'user-request' END WHERE state = 'Cancelled'",
    ],
  },
  {
    version: 6, name: 'job-foundation', statements: [
      'CREATE TABLE jobs (job_id TEXT PRIMARY KEY, state TEXT NOT NULL, record_json TEXT NOT NULL)',
      'CREATE TABLE job_events (seq INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id), category TEXT NOT NULL, level TEXT NOT NULL, event_json TEXT NOT NULL)',
      'CREATE INDEX job_events_job_seq ON job_events(job_id, seq)',
      'CREATE TABLE audit_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, event_json TEXT NOT NULL)',
      'CREATE INDEX audit_events_job_seq ON audit_events(job_id, seq)',
    ],
  },
];

export interface MigrationResult {
  readonly appliedVersions: readonly number[];
}

export function migrate(db: DatabaseSync): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const existing = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
  const applied = new Set(existing.map((row) => row.version));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.exec('BEGIN');
    try {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      applied.add(migration.version);
    } catch (cause) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${migration.version} (${migration.name}) failed: ${String(cause)}`);
    }
  }
  return { appliedVersions: [...applied].sort((a, b) => a - b) };
}
