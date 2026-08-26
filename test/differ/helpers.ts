/**
 * Fixture builders. Specs are written inline rather than kept as files, so each
 * test shows exactly the one difference it is about.
 */

import type { OpenAPIV3 } from 'openapi-types';
import type { ApiChange, ChangeKind } from '../../src/types.js';
import { diffSpecs } from '../../src/differ/index.js';

export type Schema = OpenAPIV3.SchemaObject;

export function doc(paths: OpenAPIV3.PathsObject, version = '1.0.0'): OpenAPIV3.Document {
  return {
    openapi: '3.0.3',
    info: { title: 'Test API', version },
    paths,
  };
}

export function jsonBody(schema: Schema, required = true): OpenAPIV3.RequestBodyObject {
  return { required, content: { 'application/json': { schema } } };
}

export function jsonResponse(schema: Schema, status = '200'): OpenAPIV3.ResponsesObject {
  return {
    [status]: { description: 'ok', content: { 'application/json': { schema } } },
  };
}

export function object(properties: Record<string, Schema>, required: string[] = []): Schema {
  return required.length > 0 ? { type: 'object', properties, required } : { type: 'object', properties };
}

/** Diff two inline documents. */
export async function changesOf(
  before: OpenAPIV3.Document,
  after: OpenAPIV3.Document,
): Promise<ApiChange[]> {
  const diff = await diffSpecs(before, after, { now: () => new Date('2026-01-01T00:00:00.000Z') });
  return diff.changes;
}

export function ofKind(changes: ApiChange[], kind: ChangeKind): ApiChange[] {
  return changes.filter((change) => change.kind === kind);
}

/** The single change of a kind. Throws when there is not exactly one, which keeps assertions honest. */
export function onlyOfKind(changes: ApiChange[], kind: ChangeKind): ApiChange {
  const matches = ofKind(changes, kind);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${kind}, found ${matches.length} in [${changes.map((c) => c.kind).join(', ')}]`,
    );
  }
  return matches[0] as ApiChange;
}

export function kinds(changes: ApiChange[]): ChangeKind[] {
  return changes.map((change) => change.kind);
}
