/**
 * Human readable rendering of a diff. Pure, so it can be asserted in tests and
 * reused later for the pull request body.
 */

import type { ApiChange, SpecDiff } from '../types.js';
import { looksLikeDifferentApis } from '../specs/vendor.js';
import { groupChanges } from './group.js';

function groupHeading(change: ApiChange): string {
  return change.method === undefined
    ? change.path
    : `${change.method.toUpperCase()} ${change.path}`;
}

function describe(change: ApiChange): string {
  const target = change.target;
  if (target?.from !== undefined && target.to !== undefined && target.from !== target.to) {
    return `${target.from} -> ${target.to}`;
  }
  if (target?.fromType !== undefined && target.toType !== undefined) {
    return `${target.from ?? ''} ${target.fromType} -> ${target.toType}`.trim();
  }
  return change.detail;
}

/** How many endpoints to name before summarising the rest. */
const MAX_LISTED_ENDPOINTS = 4;

/**
 * One entry per distinct change rather than per endpoint.
 *
 * A vendor editing one shared schema produces a record for every endpoint that
 * references it, so Box adding a single enum value appeared seven times. The
 * records are all real and the scanner needs them, but a reader wants the fact
 * once with the endpoints it touches.
 */
function renderGroup(changes: ApiChange[], indent = '  '): string[] {
  const lines: string[] = [];

  for (const group of groupChanges(changes)) {
    const change = group.representative;
    const shared = group.endpoints.length > 1;

    lines.push(`${indent}${shared ? `${group.endpoints.length} endpoints` : groupHeading(change)}`);
    lines.push(`${indent}  ${change.kind}  [${change.confidence}]`);
    lines.push(`${indent}    ${describe(change)}`);

    if (shared) {
      for (const endpoint of group.endpoints.slice(0, MAX_LISTED_ENDPOINTS)) {
        lines.push(`${indent}      ${endpoint}`);
      }
      const rest = group.endpoints.length - MAX_LISTED_ENDPOINTS;
      if (rest > 0) lines.push(`${indent}      and ${rest} more`);
    }

    lines.push('');
  }

  return lines;
}

export function formatDiffReport(diff: SpecDiff, options: { breakingOnly?: boolean } = {}): string {
  const breaking = diff.changes.filter((change) => change.breaking);
  const safe = options.breakingOnly === true ? [] : diff.changes.filter((change) => !change.breaking);

  const lines: string[] = [
    `APIShift diff: ${diff.newTitle}`,
    `  old  ${diff.oldSource} (${diff.oldVersion})`,
    `  new  ${diff.newSource} (${diff.newVersion})`,
    '',
    ...(looksLikeDifferentApis(diff.oldTitle, diff.newTitle)
      ? [
          `  WARNING: these look like different APIs, "${diff.oldTitle}" against "${diff.newTitle}"`,
          '',
        ]
      : []),
    `  ${breaking.length} breaking, ${diff.changes.length - breaking.length} non breaking`,
    ...(groupChanges(diff.changes).length < diff.changes.length
      ? [`  ${groupChanges(diff.changes).length} distinct changes, some shared across endpoints`]
      : []),
    '',
  ];

  if (diff.changes.length === 0) {
    lines.push('  no differences found', '');
    return lines.join('\n');
  }

  if (breaking.length > 0) {
    lines.push(`BREAKING (${breaking.length})`, '');
    lines.push(...renderGroup(breaking));
  }

  if (safe.length > 0) {
    lines.push(`NON BREAKING (${safe.length})`, '');
    lines.push(...renderGroup(safe));
  }

  return lines.join('\n');
}
