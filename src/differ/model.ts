/**
 * Normalizes a dereferenced OpenAPI document into a flat operation model.
 *
 * The diff walk never touches the raw document. It compares two of these models,
 * which keeps the walk readable and keeps spec quirks (allOf, nested objects,
 * arrays, content types) contained in one file.
 */

import type { OpenAPIV3 } from 'openapi-types';
import type { HttpMethod } from '../types.js';
import { MAX_SCHEMA_DEPTH, asSchema, enumValues, resolveAllOf, typeName } from './schema.js';

export const HTTP_METHODS: readonly HttpMethod[] = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
];

export type ParamLocation = 'path' | 'query' | 'header';

export interface ParamModel {
  name: string;
  location: ParamLocation;
  required: boolean;
  type: string;
  enumValues?: string[] | undefined;
  schema: OpenAPIV3.SchemaObject | undefined;
}

export interface FieldModel {
  /** Dot path within the payload, for example card.number or items[].sku. */
  pointer: string;
  /** The leaf name, which is what a rename actually changes. */
  name: string;
  /** Parent pointer, used to only pair renames within the same object level. */
  parent: string;
  required: boolean;
  type: string;
  enumValues?: string[] | undefined;
  schema: OpenAPIV3.SchemaObject | undefined;
}

export interface OperationModel {
  key: string;
  path: string;
  method: HttpMethod;
  operationId?: string | undefined;
  params: ParamModel[];
  requestFields: FieldModel[];
  responseFields: FieldModel[];
  responseStatuses: string[];
}

export interface SpecModel {
  operations: Map<string, OperationModel>;
}

export function operationKey(method: HttpMethod, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function isParamLocation(value: string): value is ParamLocation {
  return value === 'path' || value === 'query' || value === 'header';
}

/**
 * Walk an object schema into a flat list of leaf and branch fields. Both are
 * kept, since a rename can happen at any level. Arrays contribute a `[]` segment
 * so a codemod can tell `items.sku` from `items[].sku`.
 */
function flattenSchema(
  schema: OpenAPIV3.SchemaObject | undefined,
  parent: string,
  depth: number,
  seen: Set<object>,
  out: FieldModel[],
): void {
  if (schema === undefined || depth > MAX_SCHEMA_DEPTH) return;
  if (seen.has(schema)) return;

  const resolved = resolveAllOf(schema);
  const nextSeen = new Set(seen).add(schema);

  if (typeName(resolved).startsWith('array<')) {
    const items = asSchema('items' in resolved ? resolved.items : undefined);
    flattenSchema(items, `${parent}[]`, depth + 1, nextSeen, out);
    return;
  }

  const properties = resolved.properties ?? {};
  const required = new Set(resolved.required ?? []);

  for (const [name, rawChild] of Object.entries(properties)) {
    const child = asSchema(rawChild);
    const pointer = parent === '' ? name : `${parent}.${name}`;
    out.push({
      pointer,
      name,
      parent,
      required: required.has(name),
      type: typeName(child),
      enumValues: enumValues(child),
      schema: child,
    });
    flattenSchema(child, pointer, depth + 1, nextSeen, out);
  }
}

function jsonSchemaOf(content: OpenAPIV3.RequestBodyObject['content'] | undefined): OpenAPIV3.SchemaObject | undefined {
  if (content === undefined) return undefined;
  const mediaType =
    content['application/json'] ??
    Object.entries(content).find(([type]) => type.includes('json'))?.[1];
  return asSchema(mediaType?.schema);
}

function requestFieldsOf(operation: OpenAPIV3.OperationObject): FieldModel[] {
  const requestBody = operation.requestBody as OpenAPIV3.RequestBodyObject | undefined;
  if (requestBody === undefined) return [];

  const fields: FieldModel[] = [];
  flattenSchema(jsonSchemaOf(requestBody.content), '', 0, new Set(), fields);
  return fields;
}

/**
 * Response shape comes from the lowest 2xx response. A consumer reads the
 * success payload, so that is the one whose changes break code.
 */
function successResponse(
  operation: OpenAPIV3.OperationObject,
): [string, OpenAPIV3.ResponseObject] | undefined {
  const entries = Object.entries(operation.responses ?? {})
    .filter(([status]) => status.startsWith('2'))
    .sort(([a], [b]) => a.localeCompare(b));

  const first = entries[0];
  if (first === undefined) return undefined;
  const response = first[1] as OpenAPIV3.ResponseObject | undefined;
  if (response === undefined) return undefined;
  return [first[0], response];
}

function responseFieldsOf(operation: OpenAPIV3.OperationObject): FieldModel[] {
  const found = successResponse(operation);
  if (found === undefined) return [];
  const fields: FieldModel[] = [];
  flattenSchema(jsonSchemaOf(found[1].content), '', 0, new Set(), fields);
  return fields;
}

function paramsOf(
  operation: OpenAPIV3.OperationObject,
  pathLevel: OpenAPIV3.PathItemObject['parameters'],
): ParamModel[] {
  const all = [...(pathLevel ?? []), ...(operation.parameters ?? [])];
  const byKey = new Map<string, ParamModel>();

  for (const raw of all) {
    const param = raw as OpenAPIV3.ParameterObject | undefined;
    if (param === undefined || typeof param.name !== 'string') continue;
    if (!isParamLocation(param.in)) continue;

    const schema = asSchema(param.schema);
    // Operation level parameters override path level ones with the same name.
    byKey.set(`${param.in}:${param.name}`, {
      name: param.name,
      location: param.in,
      required: param.required === true,
      type: typeName(schema),
      enumValues: enumValues(schema),
      schema,
    });
  }

  return [...byKey.values()];
}

/** Build the comparable model for one dereferenced document. */
export function buildSpecModel(document: OpenAPIV3.Document): SpecModel {
  const operations = new Map<string, OperationModel>();

  for (const [path, rawItem] of Object.entries(document.paths ?? {})) {
    const item = rawItem as OpenAPIV3.PathItemObject | undefined;
    if (item === undefined) continue;

    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;

      operations.set(operationKey(method, path), {
        key: operationKey(method, path),
        path,
        method,
        operationId: operation.operationId,
        params: paramsOf(operation, item.parameters),
        requestFields: requestFieldsOf(operation),
        responseFields: responseFieldsOf(operation),
        responseStatuses: Object.keys(operation.responses ?? {}).sort(),
      });
    }
  }

  return { operations };
}
