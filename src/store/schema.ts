/**
 * Database schema and migrations.
 *
 * Migrations are a numbered list applied in order and tracked with
 * PRAGMA user_version, so upgrading is deterministic and needs no migration
 * table of its own. Never edit an existing entry, append a new one.
 */

export const MIGRATIONS: readonly string[] = [
  // 1: tracked specs, their last seen snapshot, and run history.
  `
  CREATE TABLE specs (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    repo_path TEXT,
    last_seen_version TEXT,
    last_content_hash TEXT,
    last_checked_at TEXT,
    created_at TEXT NOT NULL
  );

  -- The spec text as last seen. Kept so the next check has something to diff
  -- against without asking the user for the old file.
  CREATE TABLE snapshots (
    spec_id INTEGER PRIMARY KEY REFERENCES specs(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    captured_at TEXT NOT NULL
  );

  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    spec_id INTEGER REFERENCES specs(id) ON DELETE SET NULL,
    old_version TEXT NOT NULL,
    new_version TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    pr_url TEXT,
    error TEXT,
    breaking_count INTEGER NOT NULL DEFAULT 0,
    site_count INTEGER NOT NULL DEFAULT 0,
    applied_count INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE changes (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    change_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    breaking INTEGER NOT NULL,
    confidence TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE edits (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    change_id TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    strategy TEXT NOT NULL,
    confidence TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL
  );

  CREATE INDEX idx_runs_spec ON runs(spec_id, started_at);
  CREATE INDEX idx_changes_run ON changes(run_id);
  CREATE INDEX idx_edits_run ON edits(run_id);
  `,
];
