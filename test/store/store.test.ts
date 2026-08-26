/**
 * The store, against an in memory database. Nothing here touches disk.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { ApiChange } from '../../src/types.js';
import { Store, contentHash } from '../../src/store/index.js';
import { makeChange } from '../../src/differ/changes.js';

let store: Store;

beforeEach(() => {
  store = new Store(':memory:');
});

afterEach(() => {
  store.close();
});

const change = (): ApiChange =>
  makeChange({
    kind: 'path.renamed',
    breaking: true,
    confidence: 'high',
    path: '/v1/charges',
    detail: 'renamed',
    target: { location: 'path', from: '/v1/charges', to: '/v1/payments' },
  });

describe('migrations', () => {
  it('creates the schema and records the version', () => {
    expect(store.listSpecs()).toEqual([]);
    expect(store.listRuns()).toEqual([]);
  });

  it('is safe to open the same database twice', () => {
    const second = new Store(':memory:');
    expect(second.listSpecs()).toEqual([]);
    second.close();
  });
});

describe('tracking specs', () => {
  it('tracks a spec and reads it back', () => {
    const spec = store.trackSpec({ name: 'stripe', source: 'https://example.test/spec.json', repoPath: './app' });

    expect(spec.name).toBe('stripe');
    expect(spec.repoPath).toBe('./app');
    expect(spec.lastSeenVersion).toBeUndefined();
    expect(store.getSpec('stripe')).toEqual(spec);
  });

  it('updates the source instead of duplicating on the same name', () => {
    store.trackSpec({ name: 'stripe', source: 'https://old.test/spec.json' });
    store.trackSpec({ name: 'stripe', source: 'https://new.test/spec.json' });

    expect(store.listSpecs()).toHaveLength(1);
    expect(store.getSpec('stripe')?.source).toBe('https://new.test/spec.json');
  });

  it('returns undefined for an unknown spec', () => {
    expect(store.getSpec('nope')).toBeUndefined();
  });

  it('untracks, and reports whether anything was removed', () => {
    store.trackSpec({ name: 'stripe', source: 'https://example.test/spec.json' });

    expect(store.untrackSpec('stripe')).toBe(true);
    expect(store.untrackSpec('stripe')).toBe(false);
    expect(store.listSpecs()).toEqual([]);
  });

  it('lists specs in name order', () => {
    store.trackSpec({ name: 'zulip', source: 'z' });
    store.trackSpec({ name: 'acme', source: 'a' });

    expect(store.listSpecs().map((spec) => spec.name)).toEqual(['acme', 'zulip']);
  });
});

describe('snapshots', () => {
  it('stores a snapshot and moves the spec markers forward', () => {
    const spec = store.trackSpec({ name: 'acme', source: 'a' });
    store.saveSnapshot(spec.id, { version: '1.0.0', content: 'openapi: 3.0.3' });

    const snapshot = store.getSnapshot(spec.id);
    expect(snapshot?.version).toBe('1.0.0');
    expect(snapshot?.contentHash).toBe(contentHash('openapi: 3.0.3'));

    const updated = store.getSpec('acme');
    expect(updated?.lastSeenVersion).toBe('1.0.0');
    expect(updated?.lastCheckedAt).toBeDefined();
  });

  it('replaces the snapshot rather than accumulating them', () => {
    const spec = store.trackSpec({ name: 'acme', source: 'a' });
    store.saveSnapshot(spec.id, { version: '1.0.0', content: 'one' });
    store.saveSnapshot(spec.id, { version: '2.0.0', content: 'two' });

    expect(store.getSnapshot(spec.id)?.content).toBe('two');
    expect(store.getSpec('acme')?.lastSeenVersion).toBe('2.0.0');
  });

  it('detects an unchanged spec by content hash, not by version string', () => {
    const spec = store.trackSpec({ name: 'acme', source: 'a' });
    store.saveSnapshot(spec.id, { version: '1.0.0', content: 'body' });

    // A vendor that edits a spec without bumping its version is still a change.
    expect(store.getSnapshot(spec.id)?.contentHash).toBe(contentHash('body'));
    expect(store.getSnapshot(spec.id)?.contentHash).not.toBe(contentHash('body edited'));
  });

  it('drops snapshots when the spec is untracked', () => {
    const spec = store.trackSpec({ name: 'acme', source: 'a' });
    store.saveSnapshot(spec.id, { version: '1.0.0', content: 'body' });
    store.untrackSpec('acme');

    expect(store.getSnapshot(spec.id)).toBeUndefined();
  });
});

describe('runs', () => {
  it('records a run from start to finish', () => {
    const spec = store.trackSpec({ name: 'acme', source: 'a' });
    const runId = store.startRun({ specId: spec.id, oldVersion: '1.0.0', newVersion: '2.0.0', repoPath: './app' });

    const running = store.listRuns()[0];
    expect(running?.status).toBe('running');
    expect(running?.finishedAt).toBeUndefined();

    store.finishRun(runId, {
      status: 'success',
      prUrl: 'https://github.com/acme/app/pull/1',
      breakingCount: 3,
      siteCount: 9,
      appliedCount: 6,
      reviewCount: 3,
    });

    const finished = store.listRuns()[0];
    expect(finished).toMatchObject({
      status: 'success',
      prUrl: 'https://github.com/acme/app/pull/1',
      breakingCount: 3,
      siteCount: 9,
      appliedCount: 6,
      reviewCount: 3,
      specName: 'acme',
    });
    expect(finished?.finishedAt).toBeDefined();
  });

  it('records a failure with its message', () => {
    const runId = store.startRun({ oldVersion: '1', newVersion: '2', repoPath: '.' });
    store.finishRun(runId, { status: 'failed', error: 'spec unreachable' });

    expect(store.listRuns()[0]).toMatchObject({ status: 'failed', error: 'spec unreachable' });
  });

  it('keeps a run after its spec is untracked, so history survives', () => {
    const spec = store.trackSpec({ name: 'acme', source: 'a' });
    const runId = store.startRun({ specId: spec.id, oldVersion: '1', newVersion: '2', repoPath: '.' });
    store.finishRun(runId, { status: 'success' });
    store.untrackSpec('acme');

    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.specName).toBeUndefined();
  });

  it('returns runs newest first and honours the limit', () => {
    for (const version of ['2', '3', '4']) {
      const runId = store.startRun({ oldVersion: '1', newVersion: version, repoPath: '.' });
      store.finishRun(runId, { status: 'success' });
    }

    expect(store.listRuns(2)).toHaveLength(2);
    expect(store.listRuns()[0]?.newVersion).toBe('4');
  });

  it('stores changes and edits against a run', () => {
    const runId = store.startRun({ oldVersion: '1', newVersion: '2', repoPath: '.' });
    store.recordChanges(runId, [change()]);
    store.recordEdits(runId, [
      {
        changeId: change().id,
        site: {
          changeId: change().id,
          file: 'src/a.ts',
          absoluteFile: '/repo/src/a.ts',
          line: 4,
          column: 1,
          start: 0,
          end: 5,
          text: 'x',
          strategy: 'url.literal',
          confidence: 'high',
          snippet: 'x',
          reason: 'r',
        },
        strategy: 'rename-path',
        confidence: 'high',
        action: 'apply',
        before: 'x',
        after: 'y',
        reasoning: 'r',
      },
    ]);

    store.finishRun(runId, { status: 'success' });
    expect(store.listRuns()[0]?.id).toBe(runId);
  });
});
