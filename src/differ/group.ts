/**
 * Grouping identical changes that land on many endpoints.
 *
 * A vendor edits one shared schema and every endpoint referencing it reports
 * the change separately. Box adding a single enum value to a reused
 * `fields[].type` produced 20 of its 32 changes, which buried the other 12.
 *
 * Every one of those records is true and the scanner needs all of them, since
 * each endpoint has its own call sites. So nothing is discarded here. This is a
 * view over the same data for reports and the dashboard: one row per distinct
 * change, carrying the endpoints it touches.
 */

import type { ApiChange } from '../types.js';

export interface ChangeGroup {
  /** The first change in the group, used for everything shown in a summary. */
  representative: ApiChange;
  /** Every change in the group, including the representative. */
  changes: ApiChange[];
  /** Endpoints affected, formatted for display, in stable order. */
  endpoints: string[];
}

/** The leaf of a dotted pointer, so `entries[].fields[].type` becomes `type`. */
function leafOf(pointer: string | undefined): string | undefined {
  const leaf = pointer?.split('.').at(-1)?.replaceAll('[]', '');
  return leaf !== undefined && leaf.length > 0 ? leaf : undefined;
}

/**
 * Two changes are the same fact when they say the same thing about the same
 * field. The pointer is reduced to its leaf first, because the same shared
 * schema appears at different depths depending on the endpoint that wraps it:
 * `fields[].type` in one response and `entries[].fields[].type` in another.
 */
function groupKey(change: ApiChange): string {
  const from = leafOf(change.target?.from);
  const to = leafOf(change.target?.to);

  let detail = change.detail;
  if (change.target?.from !== undefined && from !== undefined) {
    detail = detail.split(change.target.from).join(from);
  }
  if (change.target?.to !== undefined && to !== undefined) {
    detail = detail.split(change.target.to).join(to);
  }

  return [
    change.kind,
    change.direction ?? '',
    change.breaking ? 'breaking' : 'safe',
    from ?? '',
    to ?? '',
    change.target?.fromType ?? '',
    change.target?.toType ?? '',
    detail,
  ].join('|');
}

export function endpointLabel(change: ApiChange): string {
  return change.method === undefined ? change.path : `${change.method.toUpperCase()} ${change.path}`;
}

/**
 * Collapse identical changes into one row each, preserving input order so the
 * breaking first ordering the differ produced still holds.
 */
export function groupChanges(changes: ApiChange[]): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();

  for (const change of changes) {
    const key = groupKey(change);
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, { representative: change, changes: [change], endpoints: [endpointLabel(change)] });
      continue;
    }

    existing.changes.push(change);
    const label = endpointLabel(change);
    if (!existing.endpoints.includes(label)) existing.endpoints.push(label);
  }

  return [...groups.values()];
}

/** How much shorter the grouped view is, for a "showing N of M" line. */
export function groupingSummary(changes: ApiChange[]): { groups: number; total: number } {
  return { groups: groupChanges(changes).length, total: changes.length };
}
