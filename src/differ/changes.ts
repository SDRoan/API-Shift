/**
 * Change construction, identity, and ordering.
 *
 * Change ids are content derived rather than sequential, so the same spec pair
 * always produces the same ids. That is what lets `apishift diff` write a JSON
 * artifact that `apishift scan` reads back and joins against.
 */

import { createHash } from 'node:crypto';
import type { ApiChange, ChangeKind, ChangeTarget, Confidence, Direction, HttpMethod } from '../types.js';

export interface ChangeInput {
  kind: ChangeKind;
  breaking: boolean;
  confidence: Confidence;
  path: string;
  detail: string;
  method?: HttpMethod | undefined;
  operationId?: string | undefined;
  direction?: Direction | undefined;
  target?: ChangeTarget | undefined;
}

/** Short, stable, content derived id. Ten hex characters is plenty for one run. */
export function changeId(input: ChangeInput): string {
  const parts = [
    input.kind,
    input.method ?? '',
    input.path,
    input.target?.location ?? '',
    input.target?.from ?? '',
    input.target?.to ?? '',
    input.target?.fromType ?? '',
    input.target?.toType ?? '',
  ];
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10);
}

/**
 * Build an ApiChange. Optional keys are omitted rather than set to undefined so
 * the value serializes cleanly to JSON under exactOptionalPropertyTypes.
 */
export function makeChange(input: ChangeInput): ApiChange {
  return {
    id: changeId(input),
    kind: input.kind,
    breaking: input.breaking,
    confidence: input.confidence,
    path: input.path,
    detail: input.detail,
    ...(input.method !== undefined ? { method: input.method } : {}),
    ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
    ...(input.direction !== undefined ? { direction: input.direction } : {}),
    ...(input.target !== undefined ? { target: input.target } : {}),
  };
}

/** Breaking first, then stable alphabetical ordering so output is deterministic. */
export function compareChanges(a: ApiChange, b: ApiChange): number {
  if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
  return (
    a.path.localeCompare(b.path) ||
    (a.method ?? '').localeCompare(b.method ?? '') ||
    a.kind.localeCompare(b.kind) ||
    (a.target?.from ?? '').localeCompare(b.target?.from ?? '') ||
    a.id.localeCompare(b.id)
  );
}

export function sortChanges(changes: ApiChange[]): ApiChange[] {
  return [...changes].sort(compareChanges);
}
