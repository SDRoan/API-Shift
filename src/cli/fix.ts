/**
 * The `apishift fix` command: diff, scan, plan, apply, and optionally open a
 * pull request.
 *
 * Dry run is the default. Nothing is written to disk and nothing reaches GitHub
 * unless the flags ask for it, because the destructive path should always be the
 * one you typed on purpose.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { diffSpecs } from '../differ/index.js';
import { scanProject } from '../scanner/index.js';
import { planApiUpdate } from '../fixer/index.js';
import { applyEdits } from '../fixer/apply.js';
import { loadGitHubConfig, hasGitHubConfig } from '../github/config.js';
import { createGitHubApi, openPullRequest } from '../github/index.js';

const USAGE = `usage: apishift fix <repo> --old <spec> --new <spec> [options]

  <repo>       path to the codebase to patch

required:
  --old <spec>   previous OpenAPI spec, file path or URL
  --new <spec>   new OpenAPI spec, file path or URL

options:
  --write        write the high confidence edits to disk
  --open-pr      commit the edits to a branch and open a pull request, implies --write
  --branch <name>  override the generated branch name
  --json <file>  write the full run result as JSON

Without --write or --open-pr this is a dry run that only prints what it would do.

exit codes:
  0  ran successfully
  1  nothing to change, or a pull request was requested with nothing to commit
  2  bad usage, a spec that failed to load, or missing GitHub configuration
`;

interface FixOptions {
  old?: string | undefined;
  new?: string | undefined;
  write?: boolean | undefined;
  'open-pr'?: boolean | undefined;
  branch?: string | undefined;
  json?: string | undefined;
}

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export async function runFixCommand(argv: string[]): Promise<number> {
  let values: FixOptions;
  let positionals: string[];

  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        old: { type: 'string' },
        new: { type: 'string' },
        write: { type: 'boolean' },
        'open-pr': { type: 'boolean' },
        branch: { type: 'string' },
        json: { type: 'string' },
      },
      allowPositionals: true,
    }));
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  const repoPath = positionals[0];
  if (repoPath === undefined || values.old === undefined || values.new === undefined) {
    process.stderr.write(`fix needs a repo, --old, and --new\n\n${USAGE}`);
    return 2;
  }

  const openPr = values['open-pr'] === true;
  // Opening a pull request deliberately does NOT touch the working tree. The
  // patched contents are computed in memory and pushed to a branch, so running
  // the demo twice behaves the same both times and nobody is surprised by a
  // dirty checkout. --write is the separate, explicit opt in for local edits.
  const write = values.write === true;
  const root = resolve(process.cwd(), repoPath);

  // Fail before doing any work if a pull request was asked for but cannot happen.
  if (openPr && !hasGitHubConfig()) {
    process.stderr.write(
      'cannot open a pull request without GitHub configuration\n' +
        'copy .env.example to .env, fill it in, then run with node --env-file=.env\n',
    );
    return 2;
  }

  let diff;
  try {
    diff = await diffSpecs(values.old, values.new);
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const breaking = diff.changes.filter((change) => change.breaking);
  const { sites } = scanProject(root, diff.changes);
  const run = planApiUpdate(diff.changes, sites);

  line('APIShift fix');
  line(`  specs  ${values.old} -> ${values.new} (${diff.oldVersion} -> ${diff.newVersion})`);
  line(`  repo   ${relative(process.cwd(), root) || '.'}`);
  line();
  line(`  ${breaking.length} breaking changes, ${sites.length} affected locations`);
  line(`  ${run.pr.appliedCount} to patch automatically, ${run.pr.reviewCount} for review`);
  line();

  const result = applyEdits(run.edits, (path) => readFileSync(path, 'utf8'));

  if (result.applied.length > 0) {
    line('PATCHED');
    for (const edit of result.applied) {
      line(`  ${edit.site.file}:${edit.site.line}  ${edit.before} -> ${edit.after ?? ''}`);
    }
    line();
  }

  const review = run.edits.filter((edit) => edit.action === 'review');
  if (review.length > 0) {
    line('NEEDS REVIEW');
    for (const edit of review) {
      line(`  ${edit.site.file}:${edit.site.line}  ${edit.reasoning}`);
    }
    line();
  }

  if (values.json !== undefined) {
    writeFileSync(values.json, `${JSON.stringify({ diff, sites, edits: run.edits, pr: run.pr }, null, 2)}\n`, 'utf8');
    line(`wrote ${values.json}`);
  }

  if (result.files.size === 0) {
    line('no files to change');
    return 1;
  }

  if (write) {
    for (const [path, contents] of result.files) {
      writeFileSync(path, contents, 'utf8');
    }
    line(`wrote ${result.files.size} file(s) to disk`);
  }

  if (!openPr) {
    if (!write) {
      line(
        `dry run, ${result.files.size} file(s) would change. pass --write to apply locally, --open-pr to open a pull request`,
      );
    }
    return 0;
  }

  const config = loadGitHubConfig();
  const api = await createGitHubApi(config);
  const branch = values.branch ?? run.pr.branch;

  try {
    const pull = await openPullRequest(api, config, {
      branch,
      title: run.pr.title,
      body: run.pr.body,
      commitMessage: `fix: update API usage for ${breaking.length} breaking spec changes`,
      files: [...result.files].map(([path, contents]) => ({
        path: relative(root, path).split('\\').join('/'),
        contents,
      })),
    });

    line();
    line(`opened ${pull.url}`);
    return 0;
  } catch (error: unknown) {
    // An expected failure, for example a branch that already exists, should read
    // as a message rather than a crash.
    process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
