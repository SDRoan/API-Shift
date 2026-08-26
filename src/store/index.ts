/**
 * SQLite access. Synchronous throughout, because better-sqlite3 is synchronous
 * and this is a local single user tool, so there is no reason to pay for async
 * plumbing.
 *
 * This is what makes APIShift Dependabot shaped rather than diff tool shaped. It
 * remembers which specs you track and what they looked like last time, so a
 * check can answer "has the vendor shipped anything" without being handed two
 * files you already knew about.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { ApiChange } from '../types.js';
import type { PlannedEdit } from '../fixer/index.js';
import { MIGRATIONS } from './schema.js';

export interface TrackedSpec {
  id: number;
  name: string;
  source: string;
  repoPath: string | undefined;
  lastSeenVersion: string | undefined;
  lastContentHash: string | undefined;
  lastCheckedAt: string | undefined;
  createdAt: string;
}

export interface Snapshot {
  specId: number;
  version: string;
  contentHash: string;
  content: string;
  capturedAt: string;
}

export type RunStatus = 'running' | 'success' | 'failed' | 'no-change';

export interface RunRecord {
  id: number;
  specName: string | undefined;
  oldVersion: string;
  newVersion: string;
  repoPath: string;
  startedAt: string;
  finishedAt: string | undefined;
  status: RunStatus;
  prUrl: string | undefined;
  error: string | undefined;
  breakingCount: number;
  siteCount: number;
  appliedCount: number;
  reviewCount: number;
}

interface SpecRow {
  id: number;
  name: string;
  source: string;
  repo_path: string | null;
  last_seen_version: string | null;
  last_content_hash: string | null;
  last_checked_at: string | null;
  created_at: string;
}

interface SnapshotRow {
  spec_id: number;
  version: string;
  content_hash: string;
  content: string;
  captured_at: string;
}

interface RunRow {
  id: number;
  spec_name: string | null;
  old_version: string;
  new_version: string;
  repo_path: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  pr_url: string | null;
  error: string | null;
  breaking_count: number;
  site_count: number;
  applied_count: number;
  review_count: number;
}

/** SQLite gives back null, the rest of the code speaks undefined. */
function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export const DEFAULT_DB_PATH = '.apishift/apishift.db';

export class Store {
  private readonly db: Database.Database;

  constructor(path: string = process.env['APISHIFT_DB'] ?? DEFAULT_DB_PATH) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  /** Apply any migrations this database has not seen. */
  private migrate(): void {
    const current = Number(this.db.pragma('user_version', { simple: true }));

    for (let version = current; version < MIGRATIONS.length; version += 1) {
      const migration = MIGRATIONS[version];
      if (migration === undefined) continue;
      this.db.exec(migration);
      this.db.pragma(`user_version = ${version + 1}`);
    }
  }

  private toSpec(row: SpecRow): TrackedSpec {
    return {
      id: row.id,
      name: row.name,
      source: row.source,
      repoPath: optional(row.repo_path),
      lastSeenVersion: optional(row.last_seen_version),
      lastContentHash: optional(row.last_content_hash),
      lastCheckedAt: optional(row.last_checked_at),
      createdAt: row.created_at,
    };
  }

  /** Register a spec, or update its source and repo if already tracked. */
  trackSpec(input: { name: string; source: string; repoPath?: string | undefined }): TrackedSpec {
    this.db
      .prepare(
        `INSERT INTO specs (name, source, repo_path, created_at)
         VALUES (@name, @source, @repoPath, @createdAt)
         ON CONFLICT(name) DO UPDATE SET source = @source, repo_path = @repoPath`,
      )
      .run({
        name: input.name,
        source: input.source,
        repoPath: input.repoPath ?? null,
        createdAt: new Date().toISOString(),
      });

    const spec = this.getSpec(input.name);
    if (spec === undefined) throw new Error(`failed to track spec ${input.name}`);
    return spec;
  }

  getSpec(name: string): TrackedSpec | undefined {
    const row = this.db.prepare('SELECT * FROM specs WHERE name = ?').get(name) as SpecRow | undefined;
    return row === undefined ? undefined : this.toSpec(row);
  }

  listSpecs(): TrackedSpec[] {
    const rows = this.db.prepare('SELECT * FROM specs ORDER BY name').all() as SpecRow[];
    return rows.map((row) => this.toSpec(row));
  }

  untrackSpec(name: string): boolean {
    return this.db.prepare('DELETE FROM specs WHERE name = ?').run(name).changes > 0;
  }

  getSnapshot(specId: number): Snapshot | undefined {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE spec_id = ?').get(specId) as
      | SnapshotRow
      | undefined;
    if (row === undefined) return undefined;

    return {
      specId: row.spec_id,
      version: row.version,
      contentHash: row.content_hash,
      content: row.content,
      capturedAt: row.captured_at,
    };
  }

  /** Replace the stored snapshot and move the spec's last seen markers forward. */
  saveSnapshot(specId: number, input: { version: string; content: string }): Snapshot {
    const hash = contentHash(input.content);
    const capturedAt = new Date().toISOString();

    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO snapshots (spec_id, version, content_hash, content, captured_at)
           VALUES (@specId, @version, @hash, @content, @capturedAt)
           ON CONFLICT(spec_id) DO UPDATE SET
             version = @version, content_hash = @hash, content = @content, captured_at = @capturedAt`,
        )
        .run({ specId, version: input.version, hash, content: input.content, capturedAt });

      this.db
        .prepare(
          `UPDATE specs SET last_seen_version = @version, last_content_hash = @hash, last_checked_at = @capturedAt
           WHERE id = @specId`,
        )
        .run({ specId, version: input.version, hash, capturedAt });
    });

    write();
    return { specId, version: input.version, contentHash: hash, content: input.content, capturedAt };
  }

  /** Record that a check happened, whether or not anything changed. */
  markChecked(specId: number): void {
    this.db
      .prepare('UPDATE specs SET last_checked_at = ? WHERE id = ?')
      .run(new Date().toISOString(), specId);
  }

  startRun(input: {
    specId?: number | undefined;
    oldVersion: string;
    newVersion: string;
    repoPath: string;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO runs (spec_id, old_version, new_version, repo_path, started_at, status)
         VALUES (@specId, @oldVersion, @newVersion, @repoPath, @startedAt, 'running')`,
      )
      .run({
        specId: input.specId ?? null,
        oldVersion: input.oldVersion,
        newVersion: input.newVersion,
        repoPath: input.repoPath,
        startedAt: new Date().toISOString(),
      });

    return Number(result.lastInsertRowid);
  }

  finishRun(
    runId: number,
    input: {
      status: RunStatus;
      prUrl?: string | undefined;
      error?: string | undefined;
      breakingCount?: number | undefined;
      siteCount?: number | undefined;
      appliedCount?: number | undefined;
      reviewCount?: number | undefined;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET finished_at = @finishedAt, status = @status, pr_url = @prUrl, error = @error,
           breaking_count = @breakingCount, site_count = @siteCount,
           applied_count = @appliedCount, review_count = @reviewCount
         WHERE id = @runId`,
      )
      .run({
        runId,
        finishedAt: new Date().toISOString(),
        status: input.status,
        prUrl: input.prUrl ?? null,
        error: input.error ?? null,
        breakingCount: input.breakingCount ?? 0,
        siteCount: input.siteCount ?? 0,
        appliedCount: input.appliedCount ?? 0,
        reviewCount: input.reviewCount ?? 0,
      });
  }

  recordChanges(runId: number, changes: ApiChange[]): void {
    const insert = this.db.prepare(
      `INSERT INTO changes (run_id, change_id, kind, breaking, confidence, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      for (const change of changes) {
        insert.run(runId, change.id, change.kind, change.breaking ? 1 : 0, change.confidence, JSON.stringify(change));
      }
    })();
  }

  recordEdits(runId: number, edits: PlannedEdit[]): void {
    const insert = this.db.prepare(
      `INSERT INTO edits (run_id, change_id, file, line, strategy, confidence, action, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      for (const edit of edits) {
        insert.run(
          runId,
          edit.changeId,
          edit.site.file,
          edit.site.line,
          edit.strategy,
          edit.confidence,
          edit.action,
          JSON.stringify({ before: edit.before, after: edit.after, reasoning: edit.reasoning }),
        );
      }
    })();
  }

  listRuns(limit = 20): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT runs.*, specs.name AS spec_name
         FROM runs LEFT JOIN specs ON specs.id = runs.spec_id
         ORDER BY runs.started_at DESC, runs.id DESC
         LIMIT ?`,
      )
      .all(limit) as RunRow[];

    return rows.map((row) => ({
      id: row.id,
      specName: optional(row.spec_name),
      oldVersion: row.old_version,
      newVersion: row.new_version,
      repoPath: row.repo_path,
      startedAt: row.started_at,
      finishedAt: optional(row.finished_at),
      status: row.status as RunStatus,
      prUrl: optional(row.pr_url),
      error: optional(row.error),
      breakingCount: row.breaking_count,
      siteCount: row.site_count,
      appliedCount: row.applied_count,
      reviewCount: row.review_count,
    }));
  }

  close(): void {
    this.db.close();
  }
}
