/**
 * Public surface of the differ.
 *
 * diffSpecs is the whole module in one call: two sources in, a serializable
 * SpecDiff out. Everything below it is pure and separately testable.
 */

import type { OpenAPI } from 'openapi-types';
import type { SpecDiff } from '../types.js';
import { diffModels } from './diff.js';
import { loadSpec } from './load.js';
import type { LoadedSpec } from './load.js';
import { buildSpecModel } from './model.js';

export { loadSpec, SpecLoadError } from './load.js';
export type { LoadedSpec } from './load.js';
export { diffModels } from './diff.js';
export { buildSpecModel } from './model.js';
export { formatDiffReport } from './report.js';
export { compareChanges, sortChanges } from './changes.js';

export interface DiffOptions {
  /** Injected in tests so snapshots do not move. Defaults to now. */
  now?: () => Date;
}

export function diffLoadedSpecs(
  before: LoadedSpec,
  after: LoadedSpec,
  options: DiffOptions = {},
): SpecDiff {
  const now = options.now ?? ((): Date => new Date());

  return {
    oldVersion: before.version,
    newVersion: after.version,
    oldSource: before.source,
    newSource: after.source,
    oldTitle: before.title,
    newTitle: after.title,
    ...(before.primaryServer !== undefined ? { oldServer: before.primaryServer } : {}),
    ...(after.primaryServer !== undefined ? { newServer: after.primaryServer } : {}),
    generatedAt: now().toISOString(),
    changes: diffModels(buildSpecModel(before.document), buildSpecModel(after.document)),
  };
}

/** Load two specs and diff them. Sources may be file paths, URLs, or documents. */
export async function diffSpecs(
  oldSource: string | OpenAPI.Document,
  newSource: string | OpenAPI.Document,
  options: DiffOptions = {},
): Promise<SpecDiff> {
  const [before, after] = await Promise.all([loadSpec(oldSource), loadSpec(newSource)]);
  return diffLoadedSpecs(before, after, options);
}
