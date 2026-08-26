import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { diffSpecs, formatDiffReport } from '../differ/index.js';

const USAGE = `usage: apishift diff <old-spec> <new-spec> [options]

  <old-spec>  file path or URL of the previous OpenAPI spec
  <new-spec>  file path or URL of the new OpenAPI spec

options:
  --json <file>     write the diff artifact for apishift scan to read
  --breaking-only   hide non breaking changes from the report
  --exit-zero       always exit 0, even when breaking changes are found

exit codes:
  0  no breaking changes
  1  breaking changes found, unless --exit-zero
  2  bad usage or a spec that failed to load
`;

export async function runDiffCommand(argv: string[]): Promise<number> {
  let values: { json?: string | undefined; 'breaking-only'?: boolean | undefined; 'exit-zero'?: boolean | undefined };
  let positionals: string[];

  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        json: { type: 'string' },
        'breaking-only': { type: 'boolean' },
        'exit-zero': { type: 'boolean' },
      },
      allowPositionals: true,
    }));
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  const [oldSource, newSource, ...extra] = positionals;
  if (oldSource === undefined || newSource === undefined) {
    process.stderr.write(`diff needs two specs\n\n${USAGE}`);
    return 2;
  }
  if (extra.length > 0) {
    process.stderr.write(`unexpected argument: ${extra[0]}\n\n${USAGE}`);
    return 2;
  }

  let diff;
  try {
    diff = await diffSpecs(oldSource, newSource);
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  process.stdout.write(
    formatDiffReport(diff, { breakingOnly: values['breaking-only'] === true }),
  );

  if (values.json !== undefined) {
    await writeFile(values.json, `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
    process.stdout.write(`wrote ${values.json}\n`);
  }

  const breakingCount = diff.changes.filter((change) => change.breaking).length;
  if (breakingCount > 0 && values['exit-zero'] !== true) return 1;
  return 0;
}
