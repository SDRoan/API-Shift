/**
 * Human readable rendering of a diff. Pure, so it can be asserted in tests and
 * reused later for the pull request body.
 */

import type { ApiChange, SpecDiff } from '../types.js';

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

function renderGroup(changes: ApiChange[], indent = '  '): string[] {
  const groups = new Map<string, ApiChange[]>();
  for (const change of changes) {
    const heading = groupHeading(change);
    groups.set(heading, [...(groups.get(heading) ?? []), change]);
  }

  const lines: string[] = [];
  for (const [heading, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${indent}${heading}`);
    for (const change of group) {
      lines.push(`${indent}  ${change.kind}  [${change.confidence}]`);
      lines.push(`${indent}    ${describe(change)}`);
    }
    lines.push('');
  }
  return lines;
}

export function formatDiffReport(diff: SpecDiff, options: { breakingOnly?: boolean } = {}): string {
  const breaking = diff.changes.filter((change) => change.breaking);
  const safe = options.breakingOnly === true ? [] : diff.changes.filter((change) => !change.breaking);

  const lines: string[] = [
    'APIShift diff',
    `  old  ${diff.oldSource} (${diff.oldVersion})`,
    `  new  ${diff.newSource} (${diff.newVersion})`,
    '',
    `  ${breaking.length} breaking, ${diff.changes.length - breaking.length} non breaking`,
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
