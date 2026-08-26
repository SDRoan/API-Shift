/**
 * Rename inference.
 *
 * OpenAPI diffs report a removal and an addition, never a rename. Renames are
 * the highest value change kind, because they are exactly what a deterministic
 * codemod can fix. So they get real inference rather than a guess.
 *
 * Two rules, in order of strength:
 *   1. Strong evidence (matching operationId, or a single unambiguous candidate
 *      with an identical schema) produces a high confidence pair.
 *   2. Weaker evidence (equal schemas plus a name or path resemblance) produces
 *      a medium confidence pair, which never auto commits.
 *
 * Pairing is one to one and greedy by descending score. Anything unpaired stays
 * a plain removal, since a false rename is worse than a missed one.
 */

import type { Confidence } from '../types.js';
import type { FieldModel, OperationModel, ParamModel } from './model.js';
import { schemasEquivalent } from './schema.js';
import { namesRelated, pathSimilarity } from './text.js';

/** Below this, two paths are not the same endpoint under a new name. */
export const PATH_SIMILARITY_FLOOR = 0.5;

/** Below this, two operations do not carry the same payload under a new path. */
export const OPERATION_RESEMBLANCE_FLOOR = 0.6;

export interface Pair<T> {
  from: T;
  to: T;
  confidence: Confidence;
}

interface Candidate<T> {
  from: T;
  to: T;
  confidence: Confidence;
  score: number;
}

/** Take candidates strongest first, never reusing either side. */
function pairGreedily<T>(candidates: Candidate<T>[]): Pair<T>[] {
  const usedFrom = new Set<T>();
  const usedTo = new Set<T>();
  const pairs: Pair<T>[] = [];

  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    if (usedFrom.has(candidate.from) || usedTo.has(candidate.to)) continue;
    usedFrom.add(candidate.from);
    usedTo.add(candidate.to);
    pairs.push({ from: candidate.from, to: candidate.to, confidence: candidate.confidence });
  }

  return pairs;
}

/** Jaccard overlap of two field pointer sets. Two empty payloads count as a match. */
function fieldOverlap(a: FieldModel[], b: FieldModel[]): number {
  const left = new Set(a.map((field) => field.pointer));
  const right = new Set(b.map((field) => field.pointer));
  if (left.size === 0 && right.size === 0) return 1;

  const shared = [...left].filter((pointer) => right.has(pointer)).length;
  const union = new Set([...left, ...right]).size;
  return shared / union;
}

/**
 * How much two operations look like the same endpoint, by payload shape.
 *
 * This compares field names rather than field types on purpose. A vendor often
 * renames a path and changes a field in the same release, and requiring
 * identical schemas would throw away the rename, which is the part a codemod can
 * actually fix.
 */
function operationResemblance(from: OperationModel, to: OperationModel): number {
  return (
    (fieldOverlap(from.requestFields, to.requestFields) +
      fieldOverlap(from.responseFields, to.responseFields)) /
    2
  );
}

/**
 * Pair removed operations with added ones. Method must always match, since a
 * path that changed verb is a different change entirely.
 */
export function inferOperationRenames(
  removed: OperationModel[],
  added: OperationModel[],
): Pair<OperationModel>[] {
  const candidates: Candidate<OperationModel>[] = [];

  for (const from of removed) {
    for (const to of added) {
      if (from.method !== to.method) continue;

      const sharedId =
        from.operationId !== undefined &&
        from.operationId.length > 0 &&
        from.operationId === to.operationId;

      const closeness = pathSimilarity(from.path, to.path);

      if (sharedId) {
        candidates.push({ from, to, confidence: 'high', score: 2 + closeness });
        continue;
      }

      const resemblance = operationResemblance(from, to);
      if (closeness >= PATH_SIMILARITY_FLOOR && resemblance >= OPERATION_RESEMBLANCE_FLOOR) {
        candidates.push({ from, to, confidence: 'medium', score: closeness + resemblance });
      }
    }
  }

  return pairGreedily(candidates);
}

/**
 * Pair removed fields with added fields. Only fields at the same object level
 * are considered, so a rename inside `card` never pairs with one at the root.
 */
export function inferFieldRenames(removed: FieldModel[], added: FieldModel[]): Pair<FieldModel>[] {
  const candidates: Candidate<FieldModel>[] = [];

  for (const from of removed) {
    for (const to of added) {
      if (from.parent !== to.parent) continue;
      if (!schemasEquivalent(from.schema, to.schema)) continue;

      // Only fields that could plausibly be this one compete for the pairing. A
      // schema that also gained an unrelated field of another type should not
      // downgrade an otherwise obvious rename.
      const siblingsRemoved = removed.filter(
        (field) => field.parent === from.parent && schemasEquivalent(field.schema, to.schema),
      );
      const siblingsAdded = added.filter(
        (field) => field.parent === to.parent && schemasEquivalent(field.schema, from.schema),
      );
      const unambiguous = siblingsRemoved.length === 1 && siblingsAdded.length === 1;

      if (unambiguous) {
        candidates.push({ from, to, confidence: 'high', score: 2 });
        continue;
      }

      if (namesRelated(from.name, to.name)) {
        candidates.push({ from, to, confidence: 'medium', score: 1 });
      }
    }
  }

  return pairGreedily(candidates);
}

/** Same idea for parameters, which must also stay in the same location. */
export function inferParamRenames(removed: ParamModel[], added: ParamModel[]): Pair<ParamModel>[] {
  const candidates: Candidate<ParamModel>[] = [];

  for (const from of removed) {
    for (const to of added) {
      if (from.location !== to.location) continue;
      if (from.type !== to.type) continue;

      const siblingsRemoved = removed.filter(
        (param) => param.location === from.location && param.type === to.type,
      );
      const siblingsAdded = added.filter(
        (param) => param.location === to.location && param.type === from.type,
      );
      const unambiguous = siblingsRemoved.length === 1 && siblingsAdded.length === 1;

      if (unambiguous) {
        candidates.push({ from, to, confidence: 'high', score: 2 });
        continue;
      }

      if (namesRelated(from.name, to.name)) {
        candidates.push({ from, to, confidence: 'medium', score: 1 });
      }
    }
  }

  return pairGreedily(candidates);
}
