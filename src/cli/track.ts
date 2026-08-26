/**
 * Managing the set of specs APIShift watches.
 */

import { parseArgs } from 'node:util';
import { Store } from '../store/index.js';

const USAGE = `usage: apishift track <name> --source <url-or-path> [--repo <path>]
       apishift untrack <name>
       apishift list

  <name>      short name for the API, for example stripe or github
  --source    the spec URL or file path to watch
  --repo      default codebase to scan when this spec changes

Tracked specs are stored locally in SQLite. Run 'apishift check' to see whether
any of them have shipped a new version.
`;

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function runTrackCommand(argv: string[]): number {
  let values: { source?: string | undefined; repo?: string | undefined };
  let positionals: string[];

  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { source: { type: 'string' }, repo: { type: 'string' } },
      allowPositionals: true,
    }));
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  const name = positionals[0];
  if (name === undefined || values.source === undefined) {
    process.stderr.write(`track needs a name and --source\n\n${USAGE}`);
    return 2;
  }

  const store = new Store();
  try {
    const spec = store.trackSpec({ name, source: values.source, repoPath: values.repo });
    line(`tracking ${spec.name}`);
    line(`  source ${spec.source}`);
    if (spec.repoPath !== undefined) line(`  repo   ${spec.repoPath}`);
    line();
    line(`run 'apishift check ${spec.name}' to take the first snapshot`);
    return 0;
  } finally {
    store.close();
  }
}

export function runUntrackCommand(argv: string[]): number {
  const name = argv[0];
  if (name === undefined) {
    process.stderr.write(`untrack needs a name\n\n${USAGE}`);
    return 2;
  }

  const store = new Store();
  try {
    if (!store.untrackSpec(name)) {
      process.stderr.write(`not tracking ${name}\n`);
      return 1;
    }
    line(`stopped tracking ${name}`);
    return 0;
  } finally {
    store.close();
  }
}

export function runListCommand(): number {
  const store = new Store();
  try {
    const specs = store.listSpecs();
    if (specs.length === 0) {
      line('no specs tracked yet');
      line("add one with 'apishift track <name> --source <url>'");
      return 0;
    }

    line(`${specs.length} tracked spec${specs.length === 1 ? '' : 's'}`);
    line();
    for (const spec of specs) {
      line(`  ${spec.name}`);
      line(`    source   ${spec.source}`);
      line(`    version  ${spec.lastSeenVersion ?? 'not checked yet'}`);
      line(`    checked  ${spec.lastCheckedAt ?? 'never'}`);
      if (spec.repoPath !== undefined) line(`    repo     ${spec.repoPath}`);
      line();
    }
    return 0;
  } finally {
    store.close();
  }
}

export function runHistoryCommand(argv: string[]): number {
  const limit = Number.parseInt(argv[0] ?? '10', 10);
  const store = new Store();

  try {
    const runs = store.listRuns(Number.isNaN(limit) ? 10 : limit);
    if (runs.length === 0) {
      line('no runs recorded yet');
      return 0;
    }

    line(`last ${runs.length} run${runs.length === 1 ? '' : 's'}`);
    line();
    for (const run of runs) {
      const name = run.specName ?? 'ad hoc';
      line(`  #${run.id}  ${name}  ${run.oldVersion} -> ${run.newVersion}  [${run.status}]`);
      line(`      ${run.breakingCount} breaking, ${run.siteCount} sites, ${run.appliedCount} patched, ${run.reviewCount} to review`);
      if (run.prUrl !== undefined) line(`      ${run.prUrl}`);
      if (run.error !== undefined) line(`      error: ${run.error}`);
      line(`      ${run.startedAt}`);
      line();
    }
    return 0;
  } finally {
    store.close();
  }
}
