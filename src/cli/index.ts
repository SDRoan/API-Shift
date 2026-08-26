#!/usr/bin/env node
/**
 * APIShift command line entry point.
 *
 * Argument parsing uses Node's built in util.parseArgs, so the CLI adds no
 * dependency of its own.
 */

import { runDiffCommand } from './diff.js';
import { runFixCommand } from './fix.js';
import { runCheckCommand } from './check.js';
import { runHistoryCommand, runListCommand, runTrackCommand, runUntrackCommand } from './track.js';

const USAGE = `apishift - Dependabot for API changes

usage: apishift <command> [options]

watching:
  track <name> --source <url>   watch an API spec for new versions
  untrack <name>                stop watching it
  list                          show watched specs and last seen versions
  check [name]                  fetch, detect a new version, and analyse it
  history [limit]               show past runs

one off:
  diff <old> <new>              diff two OpenAPI specs and classify the changes
  fix <repo> --old --new        patch call sites, optionally open a pull request
  help                          show this message

run 'apishift <command> --help' for command options
`;

function notImplemented(command: string, phase: number): number {
  process.stderr.write(`${command} lands in phase ${phase} and is not implemented yet\n`);
  return 2;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'diff':
      return runDiffCommand(rest);
    case 'track':
      return runTrackCommand(rest);
    case 'untrack':
      return runUntrackCommand(rest);
    case 'list':
      return runListCommand();
    case 'check':
      return runCheckCommand(rest);
    case 'history':
      return runHistoryCommand(rest);
    case 'scan':
      return notImplemented('scan', 2);
    case 'fix':
      return runFixCommand(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    case '--version':
    case '-v':
      process.stdout.write('0.1.0\n');
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Stacks are for debugging, not for users. APISHIFT_DEBUG brings them back.
    const showStack = process.env['APISHIFT_DEBUG'] === '1';
    const detail =
      error instanceof Error ? (showStack ? error.stack ?? error.message : error.message) : String(error);

    process.stderr.write(`${detail}\n`);
    process.exitCode = 1;
  });
