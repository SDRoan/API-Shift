/**
 * The diff walk. Pure: two spec models in, a sorted list of classified changes
 * out. No network, no clock, no filesystem.
 *
 * Every change records the OLD path, because the scanner searches code that
 * still calls the old contract. Renames carry the new name in `target.to`.
 */

import type { ApiChange, ChangeKind, Confidence, Direction, HttpMethod } from '../types.js';
import { lowestConfidence } from '../confidence.js';
import { makeChange, sortChanges } from './changes.js';
import { isTypeChangeBreaking } from './schema.js';
import type { FieldModel, OperationModel, ParamModel, SpecModel } from './model.js';
import { inferFieldRenames, inferOperationRenames, inferParamRenames } from './rename.js';

interface OperationContext {
  path: string;
  method: HttpMethod;
  operationId?: string | undefined;
  /** Ceiling for everything emitted here. A renamed path only ever inferred, so its children inherit that doubt. */
  confidence: Confidence;
}

const FIELD_KINDS = {
  request: {
    removed: 'request.field.removed',
    renamed: 'request.field.renamed',
    typeChanged: 'request.field.type.changed',
    addedRequired: 'request.field.added.required',
    becameRequired: 'request.field.became.required',
  },
  response: {
    removed: 'response.field.removed',
    renamed: 'response.field.renamed',
    typeChanged: 'response.field.type.changed',
  },
} as const satisfies Record<Direction, Partial<Record<string, ChangeKind>>>;

function byPointer(fields: FieldModel[]): Map<string, FieldModel> {
  return new Map(fields.map((field) => [field.pointer, field]));
}

function isDescendantPointer(child: string, parent: string): boolean {
  return child.startsWith(`${parent}.`) || child.startsWith(`${parent}[]`);
}

/**
 * Collapse a cascade into the one change that caused it.
 *
 * When a parent field is removed or changes type, every field nested underneath
 * it looks removed too. Reporting all of them is technically true and useless:
 * GitHub turning an event `payload` into a union produced 411 child removals for
 * one real change. The parent is the fact, the descendants are its shadow.
 */
function suppressCascades(changes: ApiChange[]): ApiChange[] {
  const shadowing = changes
    .filter((change) => change.kind.endsWith('.type.changed') || change.kind.endsWith('.field.removed'))
    .map((change) => change.target?.from)
    .filter((pointer): pointer is string => pointer !== undefined);

  if (shadowing.length === 0) return changes;

  const suppressed = new Map<string, number>();
  const kept = changes.filter((change) => {
    const pointer = change.target?.from;
    if (pointer === undefined) return true;

    // Attribute to the outermost ancestor, since the ones in between are
    // themselves being suppressed and would swallow the count.
    const parent = shadowing
      .filter((candidate) => candidate !== pointer && isDescendantPointer(pointer, candidate))
      .sort((a, b) => a.length - b.length)[0];
    if (parent === undefined) return true;

    suppressed.set(parent, (suppressed.get(parent) ?? 0) + 1);
    return false;
  });

  // Say so on the surviving parent, so the count is visible rather than lost.
  return kept.map((change) => {
    const hidden = change.target?.from === undefined ? 0 : suppressed.get(change.target.from) ?? 0;
    if (hidden === 0) return change;
    return { ...change, detail: `${change.detail}, along with ${hidden} nested fields below it` };
  });
}

function paramKey(param: ParamModel): string {
  return `${param.location}:${param.name}`;
}

function enumDelta(before: string[] | undefined, after: string[] | undefined): {
  removed: string[];
  added: string[];
} {
  const from = new Set(before ?? []);
  const to = new Set(after ?? []);
  return {
    removed: [...from].filter((value) => !to.has(value)),
    added: [...to].filter((value) => !from.has(value)),
  };
}

/**
 * Enum semantics depend on direction, and the two directions are opposites.
 * Removing a value a consumer may still send breaks requests. Adding a value a
 * consumer never handles breaks responses.
 */
function diffEnums(
  context: OperationContext,
  direction: Direction,
  location: 'path' | 'query' | 'header' | 'body' | 'response',
  name: string,
  before: string[] | undefined,
  after: string[] | undefined,
): ApiChange[] {
  if (before === undefined || after === undefined) return [];
  const { removed, added } = enumDelta(before, after);
  const changes: ApiChange[] = [];

  if (removed.length > 0) {
    changes.push(
      makeChange({
        kind: 'enum.value.removed',
        breaking: direction === 'request',
        confidence: context.confidence,
        direction,
        path: context.path,
        method: context.method,
        operationId: context.operationId,
        target: { location, from: name, to: name },
        detail:
          direction === 'request'
            ? `${name} no longer accepts ${removed.join(', ')}`
            : `${name} no longer returns ${removed.join(', ')}`,
      }),
    );
  }

  if (added.length > 0) {
    changes.push(
      makeChange({
        kind: 'enum.value.added',
        breaking: direction === 'response',
        confidence: context.confidence,
        direction,
        path: context.path,
        method: context.method,
        operationId: context.operationId,
        target: { location, from: name, to: name },
        detail:
          direction === 'response'
            ? `${name} can now return ${added.join(', ')}`
            : `${name} now also accepts ${added.join(', ')}`,
      }),
    );
  }

  return changes;
}

function diffParams(context: OperationContext, from: ParamModel[], to: ParamModel[]): ApiChange[] {
  const changes: ApiChange[] = [];
  const oldByKey = new Map(from.map((param) => [paramKey(param), param]));
  const newByKey = new Map(to.map((param) => [paramKey(param), param]));

  const removed = from.filter((param) => !newByKey.has(paramKey(param)));
  const added = to.filter((param) => !oldByKey.has(paramKey(param)));
  const renames = inferParamRenames(removed, added);
  const renamedFrom = new Set(renames.map((pair) => pair.from));
  const renamedTo = new Set(renames.map((pair) => pair.to));

  for (const pair of renames) {
    changes.push(
      makeChange({
        kind: 'param.renamed',
        breaking: true,
        confidence: lowestConfidence(context.confidence, pair.confidence),
        direction: 'request',
        path: context.path,
        method: context.method,
        operationId: context.operationId,
        target: { location: pair.from.location, from: pair.from.name, to: pair.to.name },
        detail: `${pair.from.location} parameter ${pair.from.name} renamed to ${pair.to.name}`,
      }),
    );
  }

  for (const param of removed) {
    if (renamedFrom.has(param)) continue;
    changes.push(
      makeChange({
        kind: 'param.removed',
        breaking: false,
        confidence: context.confidence,
        direction: 'request',
        path: context.path,
        method: context.method,
        operationId: context.operationId,
        target: { location: param.location, from: param.name },
        detail: `${param.location} parameter ${param.name} removed, the server now ignores it`,
      }),
    );
  }

  for (const param of added) {
    if (renamedTo.has(param) || !param.required) continue;
    changes.push(
      makeChange({
        kind: 'param.added.required',
        breaking: true,
        confidence: context.confidence,
        direction: 'request',
        path: context.path,
        method: context.method,
        operationId: context.operationId,
        target: { location: param.location, to: param.name, toType: param.type },
        detail: `new required ${param.location} parameter ${param.name} (${param.type})`,
      }),
    );
  }

  for (const [key, before] of oldByKey) {
    const after = newByKey.get(key);
    if (after === undefined) continue;

    if (before.type !== after.type) {
      changes.push(
        makeChange({
          kind: 'param.type.changed',
          breaking: isTypeChangeBreaking(before.type, after.type),
          confidence: context.confidence,
          direction: 'request',
          path: context.path,
          method: context.method,
          operationId: context.operationId,
          target: {
            location: before.location,
            from: before.name,
            to: after.name,
            fromType: before.type,
            toType: after.type,
          },
          detail: `${before.location} parameter ${before.name} changed from ${before.type} to ${after.type}`,
        }),
      );
    }

    if (!before.required && after.required) {
      changes.push(
        makeChange({
          kind: 'param.became.required',
          breaking: true,
          confidence: context.confidence,
          direction: 'request',
          path: context.path,
          method: context.method,
          operationId: context.operationId,
          target: { location: before.location, from: before.name, to: after.name },
          detail: `${before.location} parameter ${before.name} is now required`,
        }),
      );
    }

    changes.push(
      ...diffEnums(
        context,
        'request',
        before.location,
        before.name,
        before.enumValues,
        after.enumValues,
      ),
    );
  }

  return changes;
}

function diffFields(
  context: OperationContext,
  direction: Direction,
  from: FieldModel[],
  to: FieldModel[],
): ApiChange[] {
  const changes: ApiChange[] = [];
  const location = direction === 'request' ? 'body' : 'response';
  const oldByPointer = byPointer(from);
  const newByPointer = byPointer(to);

  const removed = from.filter((field) => !newByPointer.has(field.pointer));
  const added = to.filter((field) => !oldByPointer.has(field.pointer));
  const renames = inferFieldRenames(removed, added);
  const renamedFrom = new Set(renames.map((pair) => pair.from));
  const renamedTo = new Set(renames.map((pair) => pair.to));

  for (const pair of renames) {
    changes.push(
      makeChange({
        kind: FIELD_KINDS[direction].renamed,
        breaking: true,
        confidence: lowestConfidence(context.confidence, pair.confidence),
        direction,
        path: context.path,
        method: context.method,
        operationId: context.operationId,
        target: { location, from: pair.from.pointer, to: pair.to.pointer },
        detail: `${direction} field ${pair.from.pointer} renamed to ${pair.to.pointer}`,
      }),
    );
  }

  for (const field of removed) {
    if (renamedFrom.has(field)) continue;
    changes.push(
      makeChange({
        kind: FIELD_KINDS[direction].removed,
        // A dropped request field is ignored by the server. A dropped response
        // field breaks anyone reading it.
        breaking: direction === 'response' ? true : field.required,
        confidence: context.confidence,
        direction,
        path: context.path,
        method: context.method,
        operationId: context.operationId,
        target: { location, from: field.pointer, fromType: field.type },
        detail: `${direction} field ${field.pointer} removed`,
      }),
    );
  }

  if (direction === 'request') {
    for (const field of added) {
      if (renamedTo.has(field) || !field.required) continue;
      changes.push(
        makeChange({
          kind: FIELD_KINDS.request.addedRequired,
          breaking: true,
          confidence: context.confidence,
          direction,
          path: context.path,
          method: context.method,
          operationId: context.operationId,
          target: { location, to: field.pointer, toType: field.type },
          detail: `new required request field ${field.pointer} (${field.type})`,
        }),
      );
    }
  }

  for (const [pointer, before] of oldByPointer) {
    const after = newByPointer.get(pointer);
    if (after === undefined) continue;

    if (before.type !== after.type) {
      changes.push(
        makeChange({
          kind: FIELD_KINDS[direction].typeChanged,
          breaking: isTypeChangeBreaking(before.type, after.type),
          confidence: context.confidence,
          direction,
          path: context.path,
          method: context.method,
          operationId: context.operationId,
          target: {
            location,
            from: pointer,
            to: pointer,
            fromType: before.type,
            toType: after.type,
          },
          detail: `${direction} field ${pointer} changed from ${before.type} to ${after.type}`,
        }),
      );
    }

    if (direction === 'request' && !before.required && after.required) {
      changes.push(
        makeChange({
          kind: FIELD_KINDS.request.becameRequired,
          breaking: true,
          confidence: context.confidence,
          direction,
          path: context.path,
          method: context.method,
          operationId: context.operationId,
          target: { location, from: pointer, to: pointer },
          detail: `request field ${pointer} is now required`,
        }),
      );
    }

    changes.push(
      ...diffEnums(context, direction, location, pointer, before.enumValues, after.enumValues),
    );
  }

  return suppressCascades(changes);
}

/** Only success statuses matter. A dropped 404 does not break calling code. */
function diffStatuses(context: OperationContext, from: string[], to: string[]): ApiChange[] {
  const after = new Set(to);
  return from
    .filter((status) => status.startsWith('2') && !after.has(status))
    .map((status) =>
      makeChange({
        kind: 'response.status.removed',
        breaking: true,
        confidence: context.confidence,
        direction: 'response',
        path: context.path,
        method: context.method,
        operationId: context.operationId,
        target: { location: 'response', from: status },
        detail: `success response ${status} removed`,
      }),
    );
}

/** Compare one operation against its counterpart, renamed or not. */
function diffOperation(
  from: OperationModel,
  to: OperationModel,
  confidence: Confidence,
): ApiChange[] {
  const context: OperationContext = {
    path: from.path,
    method: from.method,
    operationId: from.operationId,
    confidence,
  };

  return [
    ...diffParams(context, from.params, to.params),
    ...diffFields(context, 'request', from.requestFields, to.requestFields),
    ...diffFields(context, 'response', from.responseFields, to.responseFields),
    ...diffStatuses(context, from.responseStatuses, to.responseStatuses),
  ];
}

/**
 * Group operation level rename pairs into one change per path move. A path with
 * GET and POST that both moved is one URL rewrite, not two.
 */
function pathRenameChanges(pairs: { from: OperationModel; to: OperationModel; confidence: Confidence }[]): ApiChange[] {
  const groups = new Map<string, { from: OperationModel; to: OperationModel; confidence: Confidence }[]>();

  for (const pair of pairs) {
    if (pair.from.path === pair.to.path) continue;
    const key = `${pair.from.path} -> ${pair.to.path}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(pair);
    groups.set(key, bucket);
  }

  return [...groups.values()].map((bucket) => {
    const first = bucket[0] as { from: OperationModel; to: OperationModel; confidence: Confidence };
    const confidence = lowestConfidence(...bucket.map((pair) => pair.confidence));
    const single = bucket.length === 1;

    return makeChange({
      kind: 'path.renamed',
      breaking: true,
      confidence,
      path: first.from.path,
      method: single ? first.from.method : undefined,
      operationId: single ? first.from.operationId : undefined,
      target: { location: 'path', from: first.from.path, to: first.to.path },
      detail: `path ${first.from.path} renamed to ${first.to.path}`,
    });
  });
}

export function diffModels(oldModel: SpecModel, newModel: SpecModel): ApiChange[] {
  const changes: ApiChange[] = [];

  const removed: OperationModel[] = [];
  const added: OperationModel[] = [];

  for (const [key, operation] of oldModel.operations) {
    const counterpart = newModel.operations.get(key);
    if (counterpart === undefined) removed.push(operation);
    else changes.push(...diffOperation(operation, counterpart, 'high'));
  }

  for (const [key, operation] of newModel.operations) {
    if (!oldModel.operations.has(key)) added.push(operation);
  }

  const renames = inferOperationRenames(removed, added);
  const renamedFrom = new Set(renames.map((pair) => pair.from));
  const renamedTo = new Set(renames.map((pair) => pair.to));

  changes.push(...pathRenameChanges(renames));

  // A renamed endpoint can also have changed its fields. Compare it too, with
  // the rename's confidence as the ceiling.
  for (const pair of renames) {
    changes.push(...diffOperation(pair.from, pair.to, pair.confidence));
  }

  for (const operation of removed) {
    if (renamedFrom.has(operation)) continue;
    changes.push(
      makeChange({
        kind: 'operation.removed',
        breaking: true,
        confidence: 'high',
        path: operation.path,
        method: operation.method,
        operationId: operation.operationId,
        detail: `${operation.method.toUpperCase()} ${operation.path} removed`,
      }),
    );
  }

  for (const operation of added) {
    if (renamedTo.has(operation)) continue;
    changes.push(
      makeChange({
        kind: 'operation.added',
        breaking: false,
        confidence: 'high',
        path: operation.path,
        method: operation.method,
        operationId: operation.operationId,
        detail: `${operation.method.toUpperCase()} ${operation.path} added`,
      }),
    );
  }

  return sortChanges(changes);
}
