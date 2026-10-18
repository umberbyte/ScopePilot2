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
