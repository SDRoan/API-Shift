/**
 * The confidence model, in one place.
 *
 * Confidence is the minimum of three independent signals: how sure the differ is
 * about what changed, how sure the scanner is that a line calls that endpoint,
 * and how sure the fixer is that its edit is correct. A chain is as weak as its
 * weakest link, so the combinator is a minimum and never an average.
 *
 * Only `high` is ever committed to a branch. Because an LLM drafted edit is
 * `low` by policy, it can never reach `high`. That is structural rather than a
 * check somebody could forget to write.
 */

import type { Confidence } from './types.js';

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** The weakest link in a chain of signals. */
export function lowestConfidence(...levels: Confidence[]): Confidence {
  let lowest: Confidence = 'high';
  for (const level of levels) {
    if (RANK[level] < RANK[lowest]) lowest = level;
  }
  return lowest;
}

/** Whether an edit at this confidence may be committed to the pull request branch. */
export function isAutoApplicable(level: Confidence): boolean {
  return level === 'high';
}

/** Descending order, so reports lead with what we are most sure about. */
export function compareConfidence(a: Confidence, b: Confidence): number {
  return RANK[b] - RANK[a];
}
