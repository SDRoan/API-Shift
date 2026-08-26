/**
 * Applying edits to file contents.
 *
 * Every site carries absolute character offsets, so applying an edit is a splice
 * rather than another AST pass. Edits are applied back to front within a file,
 * which keeps earlier offsets valid as later text changes length.
 *
 * Two rules protect the output:
 *   1. Only high confidence edits are ever applied. That is checked here as well
 *      as at routing time, because this function writes to a real repo.
 *   2. Two edits that overlap are both dropped to review. If the scanner found
 *      two changes touching the same span, a human should decide, not us.
 */

import type { Confidence } from '../types.js';
import { isAutoApplicable } from '../confidence.js';
import type { PlannedEdit } from './index.js';

export interface SkippedEdit {
  edit: PlannedEdit;
  reason: string;
}

export interface ApplyResult {
  /** Absolute file path to its new contents. Only files that actually changed. */
  files: Map<string, string>;
  applied: PlannedEdit[];
  skipped: SkippedEdit[];
}

/** Reads a file's current contents. Injected so the pure path stays testable. */
export type ReadFile = (absolutePath: string) => string;

function overlaps(a: PlannedEdit, b: PlannedEdit): boolean {
  if (a.site.absoluteFile !== b.site.absoluteFile) return false;
  return a.site.start < b.site.end && b.site.start < a.site.end;
}

/**
 * Group edits by file, dropping any that cannot be applied safely. Returns the
 * new contents for each file that changed, plus everything that was skipped and
 * why, so the pull request body can report it honestly.
 */
export function applyEdits(edits: PlannedEdit[], readFile: ReadFile): ApplyResult {
  const applicable: PlannedEdit[] = [];
  const skipped: SkippedEdit[] = [];

  for (const edit of edits) {
    if (edit.action !== 'apply' || !isAutoApplicable(edit.confidence)) {
      skipped.push({ edit, reason: 'needs human review' });
      continue;
    }
    if (edit.after === undefined) {
      skipped.push({ edit, reason: 'no replacement text' });
      continue;
    }
    applicable.push(edit);
  }

  // Drop every member of an overlapping pair, not just the later one. If two
  // changes want the same span, neither is safe on its own.
  const conflicted = new Set<PlannedEdit>();
  for (const [index, edit] of applicable.entries()) {
    for (const other of applicable.slice(index + 1)) {
      if (overlaps(edit, other)) {
        conflicted.add(edit);
        conflicted.add(other);
      }
    }
  }

  const safe: PlannedEdit[] = [];
  for (const edit of applicable) {
    if (conflicted.has(edit)) {
      skipped.push({ edit, reason: 'overlaps another edit at the same location' });
      continue;
    }
    safe.push(edit);
  }

  const byFile = new Map<string, PlannedEdit[]>();
  for (const edit of safe) {
    const file = edit.site.absoluteFile;
    byFile.set(file, [...(byFile.get(file) ?? []), edit]);
  }

  const files = new Map<string, string>();
  const applied: PlannedEdit[] = [];

  for (const [absolutePath, fileEdits] of byFile) {
    const original = readFile(absolutePath);
    let contents = original;

    // Back to front, so each splice leaves earlier offsets untouched.
    const ordered = [...fileEdits].sort((a, b) => b.site.start - a.site.start);

    for (const edit of ordered) {
      const { start, end } = edit.site;
      const current = contents.slice(start, end);

      // The offsets came from the same source text we are editing. If they do
      // not still line up, the file moved underneath us and we stop.
      if (current !== edit.site.text) {
        skipped.push({
          edit,
          reason: `source no longer matches at offset ${start}, expected ${JSON.stringify(edit.site.text)}`,
        });
        continue;
      }

      contents = contents.slice(0, start) + (edit.after ?? '') + contents.slice(end);
      applied.push(edit);
    }

    if (contents !== original) files.set(absolutePath, contents);
  }

  return { files, applied, skipped };
}

/** Confidence levels present in a set of edits, for reporting. */
export function confidenceBreakdown(edits: PlannedEdit[]): Record<Confidence, number> {
  const counts: Record<Confidence, number> = { high: 0, medium: 0, low: 0 };
  for (const edit of edits) counts[edit.confidence] += 1;
  return counts;
}
