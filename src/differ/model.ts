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
  /** Marked for removal by the vendor. A warning rather than a break. */
  deprecated: boolean;
  /** Security requirement names, resolved from the operation or the document. */
  security: string[];
  /** True when the operation declares its own security rather than inheriting. */
  hasOwnSecurity: boolean;
  /** Media types the request body accepts. */
  requestContentTypes: string[];
  /** Media types the success response produces. */
  responseContentTypes: string[];
}

export interface SpecModel {
  operations: Map<string, OperationModel>;
  /** Base URLs, in declaration order. */
  servers: string[];
  /** Document level security requirement names. */
  security: string[];
  /** Scheme name to a comparable description of how it authenticates. */
  securitySchemes: Map<string, string>;
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

/**
 * The schema a caller actually works with.
 *
 * JSON is preferred, but an API that only speaks form encoding or XML still has
 * a schema worth diffing. Ignoring those operations entirely meant a form based
 * API reported no field changes at all.
 */
function payloadSchemaOf(
  content: OpenAPIV3.RequestBodyObject['content'] | undefined,
): OpenAPIV3.SchemaObject | undefined {
  if (content === undefined) return undefined;

  const mediaType =
    content['application/json'] ??
    Object.entries(content).find(([type]) => type.includes('json'))?.[1] ??
    Object.entries(content).sort(([a], [b]) => a.localeCompare(b))[0]?.[1];

  return asSchema(mediaType?.schema);
}

function requestFieldsOf(operation: OpenAPIV3.OperationObject): FieldModel[] {
  const requestBody = operation.requestBody as OpenAPIV3.RequestBodyObject | undefined;
  if (requestBody === undefined) return [];

  const fields: FieldModel[] = [];
  flattenSchema(payloadSchemaOf(requestBody.content), '', 0, new Set(), fields);
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
  flattenSchema(payloadSchemaOf(found[1].content), '', 0, new Set(), fields);
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

/** Requirement names, for example ["apiKey", "oauth2"]. */
function securityNames(
  requirements: OpenAPIV3.SecurityRequirementObject[] | undefined,
): string[] {
  if (requirements === undefined) return [];
  return [...new Set(requirements.flatMap((requirement) => Object.keys(requirement)))].sort();
}

/**
 * A comparable description of a security scheme. Comparing the whole object
 * would report cosmetic edits, so this keeps only what a caller has to act on.
 */
function describeScheme(scheme: OpenAPIV3.SecuritySchemeObject): string {
  switch (scheme.type) {
    case 'apiKey':
      return `apiKey in ${scheme.in} named ${scheme.name}`;
    case 'http':
      return `http ${scheme.scheme}`;
    case 'oauth2':
      return `oauth2 flows ${Object.keys(scheme.flows ?? {}).sort().join(', ')}`;
    case 'openIdConnect':
      return `openIdConnect ${scheme.openIdConnectUrl}`;
    default:
      return 'unknown scheme';
  }
}

function contentTypesOf(content: OpenAPIV3.RequestBodyObject['content'] | undefined): string[] {
  return content === undefined ? [] : Object.keys(content).sort();
}

/** Build the comparable model for one dereferenced document. */
export function buildSpecModel(document: OpenAPIV3.Document): SpecModel {
  const operations = new Map<string, OperationModel>();
  const documentSecurity = securityNames(document.security);

  const securitySchemes = new Map<string, string>();
  for (const [name, raw] of Object.entries(document.components?.securitySchemes ?? {})) {
    const scheme = raw as OpenAPIV3.SecuritySchemeObject | undefined;
    if (scheme !== undefined && 'type' in scheme) securitySchemes.set(name, describeScheme(scheme));
  }

  for (const [path, rawItem] of Object.entries(document.paths ?? {})) {
    const item = rawItem as OpenAPIV3.PathItemObject | undefined;
    if (item === undefined) continue;

    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;

      const requestBody = operation.requestBody as OpenAPIV3.RequestBodyObject | undefined;
      const success = successResponse(operation);

      operations.set(operationKey(method, path), {
        key: operationKey(method, path),
        path,
        method,
        operationId: operation.operationId,
        params: paramsOf(operation, item.parameters),
        requestFields: requestFieldsOf(operation),
        responseFields: responseFieldsOf(operation),
        responseStatuses: Object.keys(operation.responses ?? {}).sort(),
        deprecated: operation.deprecated === true,
        // An operation with its own security overrides the document level one.
        security: operation.security !== undefined ? securityNames(operation.security) : documentSecurity,
        hasOwnSecurity: operation.security !== undefined,
        requestContentTypes: contentTypesOf(requestBody?.content),
        responseContentTypes: contentTypesOf(success?.[1].content),
      });
    }
  }

  return {
    operations,
    servers: (document.servers ?? []).map((server) => server.url),
    security: documentSecurity,
    securitySchemes,
  };
}
