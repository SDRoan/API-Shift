/**
 * `apishift check`: has any watched API shipped something?
 *
 * This is the command that makes the name honest. Everything else in APIShift
 * assumes you already know the vendor changed something, which is the hard part.
 * Check fetches the current spec, compares it with the snapshot from last time,
 * and only then runs the pipeline.
 *
 * First check on a new spec takes a baseline and reports nothing, because there
 * is nothing to compare against yet.
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { diffSpecs } from '../differ/index.js';
import { scanProject } from '../scanner/index.js';
import { planApiUpdate } from '../fixer/index.js';
import { Store, contentHash, type TrackedSpec } from '../store/index.js';
import { materializeSpec, readSpecText } from '../specs/source.js';
import { loadSpec } from '../differ/load.js';

const USAGE = `usage: apishift check [name] [options]

  [name]   check one tracked spec, or every tracked spec when omitted

options:
  --repo <path>   codebase to scan, overriding the spec's stored repo
  --json <file>   write the full result as JSON

exit codes:
  0  checked, nothing breaking found
  1  a new version with breaking changes was found
  2  bad usage, or a spec that could not be read
`;

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

interface CheckOutcome {
  spec: string;
  status: 'baseline' | 'unchanged' | 'changed' | 'failed';
  oldVersion?: string;
  newVersion?: string;
  breaking?: number;
  sites?: number;
  applied?: number;
  review?: number;
  error?: string;
}

async function checkOne(
  store: Store,
  spec: TrackedSpec,
  repoOverride: string | undefined,
): Promise<CheckOutcome> {
  const current = await readSpecText(spec.source);
  const hash = contentHash(current.text);
  const previous = store.getSnapshot(spec.id);

  // Nothing to compare against yet, so record the baseline and stop.
  if (previous === undefined) {
    const parsed = await loadSpec(spec.source);
    store.saveSnapshot(spec.id, { version: parsed.version, content: current.text });
    return { spec: spec.name, status: 'baseline', newVersion: parsed.version };
  }

  if (previous.contentHash === hash) {
    store.markChecked(spec.id);
    return { spec: spec.name, status: 'unchanged', oldVersion: previous.version };
  }

  // The bytes moved. Write the stored copy back out so the differ can read both.
  const oldPath = await materializeSpec(previous.content, `${spec.name}-old`, spec.source);
  const diff = await diffSpecs(oldPath, spec.source);
  const breaking = diff.changes.filter((change) => change.breaking).length;

  const repoPath = repoOverride ?? spec.repoPath;
  const runId = store.startRun({
    specId: spec.id,
    oldVersion: diff.oldVersion,
    newVersion: diff.newVersion,
    repoPath: repoPath ?? '(none)',
  });
  store.recordChanges(runId, diff.changes);

  let sites = 0;
  let applied = 0;
  let review = 0;

  if (repoPath !== undefined) {
    const scanned = scanProject(resolve(process.cwd(), repoPath), diff.changes);
    const run = planApiUpdate(diff.changes, scanned.sites);
    store.recordEdits(runId, run.edits);
    sites = scanned.sites.length;
    applied = run.pr.appliedCount;
    review = run.pr.reviewCount;
  }

  store.finishRun(runId, {
    status: 'success',
    breakingCount: breaking,
    siteCount: sites,
    appliedCount: applied,
    reviewCount: review,
  });

  // Move the baseline forward only after a successful run, so a crash means the
  // next check sees the change again rather than silently skipping it.
  store.saveSnapshot(spec.id, { version: diff.newVersion, content: current.text });

  return {
    spec: spec.name,
    status: 'changed',
    oldVersion: diff.oldVersion,
    newVersion: diff.newVersion,
    breaking,
    sites,
    applied,
    review,
  };
}

export async function runCheckCommand(argv: string[]): Promise<number> {
  let values: { repo?: string | undefined; json?: string | undefined };
  let positionals: string[];

  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { repo: { type: 'string' }, json: { type: 'string' } },
      allowPositionals: true,
    }));
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  const store = new Store();

  try {
    const name = positionals[0];
    const specs = name === undefined ? store.listSpecs() : [store.getSpec(name)].filter((spec) => spec !== undefined);

    if (specs.length === 0) {
      if (name !== undefined) {
        process.stderr.write(`not tracking ${name}\n`);
        return 2;
      }
      line('no specs tracked yet');
      line("add one with 'apishift track <name> --source <url>'");
      return 0;
    }

    const outcomes: CheckOutcome[] = [];
    for (const spec of specs) {
      try {
        outcomes.push(await checkOne(store, spec, values.repo));
      } catch (error: unknown) {
        outcomes.push({
          spec: spec.name,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    line(`checked ${outcomes.length} spec${outcomes.length === 1 ? '' : 's'}`);
    line();

    for (const outcome of outcomes) {
      switch (outcome.status) {
        case 'baseline':
          line(`  ${outcome.spec}  baseline taken at ${outcome.newVersion}, nothing to compare yet`);
          break;
        case 'unchanged':
          line(`  ${outcome.spec}  no change (${outcome.oldVersion})`);
          break;
        case 'changed':
          line(`  ${outcome.spec}  ${outcome.oldVersion} -> ${outcome.newVersion}`);
          line(`      ${outcome.breaking} breaking, ${outcome.sites} affected locations`);
          line(`      ${outcome.applied} patchable, ${outcome.review} need review`);
          break;
        case 'failed':
          line(`  ${outcome.spec}  failed: ${outcome.error}`);
          break;
      }
    }

    if (values.json !== undefined) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(values.json, `${JSON.stringify(outcomes, null, 2)}\n`, 'utf8');
      line();
      line(`wrote ${values.json}`);
    }

    const breakingFound = outcomes.some((outcome) => (outcome.breaking ?? 0) > 0);
    const anyFailed = outcomes.some((outcome) => outcome.status === 'failed');
    if (anyFailed) return 2;
    return breakingFound ? 1 : 0;
  } finally {
    store.close();
  }
}
