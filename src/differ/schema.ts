/**
 * Schema helpers. The differ never compares raw schema objects directly, it goes
 * through typeName and schemasEquivalent so that behaviour stays in one place
 * and stays testable.
 */

import type { OpenAPIV3 } from 'openapi-types';

export type MaybeSchema = OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined;

/** How deep schema walks go. Guards against very large or self referencing specs. */
export const MAX_SCHEMA_DEPTH = 6;

export function isReference(schema: MaybeSchema): schema is OpenAPIV3.ReferenceObject {
  return typeof schema === 'object' && schema !== null && '$ref' in schema;
}

/** Narrow to a concrete schema, treating unresolved references as unknown. */
export function asSchema(schema: MaybeSchema): OpenAPIV3.SchemaObject | undefined {
  if (schema === undefined || isReference(schema)) return undefined;
  return schema;
}

/**
 * Flatten a single level of allOf, which real specs use constantly for
 * composition. oneOf and anyOf are deliberately not flattened, since picking one
 * branch would be a guess. They surface as their own type name instead.
 */
export function resolveAllOf(schema: OpenAPIV3.SchemaObject): OpenAPIV3.SchemaObject {
  if (!Array.isArray(schema.allOf) || schema.allOf.length === 0) return schema;

  const merged: OpenAPIV3.SchemaObject = { ...schema };
  delete merged.allOf;
  merged.properties = { ...(schema.properties ?? {}) };
  merged.required = [...(schema.required ?? [])];

  for (const member of schema.allOf) {
    const part = asSchema(member);
    if (part === undefined) continue;
    const resolved = resolveAllOf(part);
    const inheritedType = merged.type ?? resolved.type;
    if (inheritedType !== undefined) merged.type = inheritedType;
    merged.properties = { ...resolved.properties, ...merged.properties };
    merged.required = [...new Set([...(resolved.required ?? []), ...(merged.required ?? [])])];
  }

  if (merged.required?.length === 0) delete merged.required;
  if (Object.keys(merged.properties ?? {}).length === 0) delete merged.properties;
  return merged;
}

/** Above this many characters a spelled out union stops being readable. */
const MAX_UNION_LABEL = 60;

function unionName(keyword: string, members: MaybeSchema[]): string {
  // The member count always stays in the name. Distinct names alone would hide
  // a real change: PagerDuty widening a union from three object variants to
  // four collapses to the single name 'object', so without the count the change
  // disappears entirely.
  const distinct = [...new Set(members.map((member) => typeName(member)))].sort();
  const label = distinct.join('|');
  return label.length <= MAX_UNION_LABEL
    ? `${keyword}<${members.length}: ${label}>`
    : `${keyword}<${members.length}>`;
}

/**
 * A stable, comparable name for a schema's type. Format is included because
 * string:date-time to string is a real contract change a consumer can trip on.
 */
export function typeName(schema: MaybeSchema): string {
  const concrete = asSchema(schema);
  if (concrete === undefined) return 'unknown';

  const resolved = resolveAllOf(concrete);

  // Naming the members turns "oneOf<3> to oneOf<4>" into a change you can read.
  // Very wide unions fall back to a count, since the full list stops being
  // legible in a report.
  if (Array.isArray(resolved.oneOf)) return unionName('oneOf', resolved.oneOf);
  if (Array.isArray(resolved.anyOf)) return unionName('anyOf', resolved.anyOf);

  // OpenAPI 3.1 allows a type array, for example ['string', 'null'].
  const rawType: unknown = resolved.type;
  if (Array.isArray(rawType)) return [...(rawType as string[])].sort().join('|');

  if (rawType === 'array') {
    const items = 'items' in resolved ? resolved.items : undefined;
    return `array<${typeName(items)}>`;
  }

  if (rawType === undefined) return resolved.properties !== undefined ? 'object' : 'unknown';

  return resolved.format !== undefined ? `${String(rawType)}:${resolved.format}` : String(rawType);
}

/**
 * Numeric formats are width annotations. Every one of them is a `number` in
 * JavaScript, so annotating an integer changes nothing a consumer can act on.
 */
const NUMERIC_FORMATS = new Set(['int32', 'int64', 'float', 'double']);

/** Split a type name back into its base type and its format annotation. */
export function splitTypeName(name: string): { base: string; format: string | undefined } {
  const separator = name.indexOf(':');
  if (separator === -1) return { base: name, format: undefined };

  // A colon inside a composite label belongs to a member, not to this type.
  // oneOf<string:date-time|integer> must not split into base 'oneOf<string'.
  const bracket = name.indexOf('<');
  if (bracket !== -1 && bracket < separator) return { base: name, format: undefined };

  return { base: name.slice(0, separator), format: name.slice(separator + 1) };
}

/**
 * Does a change of type actually break a consumer?
 *
 * The base type moving always does. A format annotation appearing or
 * disappearing usually does not, and getting that wrong is expensive: Twilio
 * annotating one parameter with `format: int64` produced 61 false breaking
 * changes in a single release, which drowned the 12 real ones.
 *
 * The distinction is what the consumer has to do about it:
 *   integer -> integer:int64        no code change is possible, both are number
 *   integer:int32 -> integer:int64  flagged, values can now exceed safe range
 *   string -> string:date-time      flagged, the value must now be parsed
 */
export function isTypeChangeBreaking(fromType: string, toType: string): boolean {
  const from = splitTypeName(fromType);
  const to = splitTypeName(toType);

  if (from.base !== to.base) return true;

  const numericOrAbsent = (format: string | undefined): boolean =>
    format === undefined || NUMERIC_FORMATS.has(format);

  if (numericOrAbsent(from.format) && numericOrAbsent(to.format)) {
    // Only a move between two declared numeric widths can affect precision.
    return from.format !== undefined && to.format !== undefined && from.format !== to.format;
  }

  // A string format tells a consumer how to parse the value, so it matters.
  return true;
}

/** Enum values as sorted strings, or undefined when the schema has no enum. */
export function enumValues(schema: MaybeSchema): string[] | undefined {
  const concrete = asSchema(schema);
  if (concrete === undefined) return undefined;
  const resolved = resolveAllOf(concrete);
  if (!Array.isArray(resolved.enum)) return undefined;
  return resolved.enum.map((value) => String(value)).sort();
}

function sameStringSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

/**
 * Structural equality, used by rename inference to decide that a removed field
 * and an added field describe the same thing. Two schemas are equivalent when
 * their type, enum, required set, and property shape all match.
 */
export function schemasEquivalent(a: MaybeSchema, b: MaybeSchema, depth = 0): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return true;

  const left = asSchema(a);
  const right = asSchema(b);
  if (left === undefined || right === undefined) return left === right;
  if (left === right) return true;

  if (typeName(left) !== typeName(right)) return false;
  if (!sameStringSet(enumValues(left), enumValues(right))) return false;

  const resolvedLeft = resolveAllOf(left);
  const resolvedRight = resolveAllOf(right);
  if (!sameStringSet(resolvedLeft.required, resolvedRight.required)) return false;

  if (typeName(left).startsWith('array<')) {
    const leftItems = 'items' in resolvedLeft ? resolvedLeft.items : undefined;
    const rightItems = 'items' in resolvedRight ? resolvedRight.items : undefined;
    return schemasEquivalent(leftItems, rightItems, depth + 1);
  }

  const leftProps = resolvedLeft.properties ?? {};
  const rightProps = resolvedRight.properties ?? {};
  const leftKeys = Object.keys(leftProps).sort();
  const rightKeys = Object.keys(rightProps).sort();
  if (!sameStringSet(leftKeys, rightKeys)) return false;

  return leftKeys.every((key) => schemasEquivalent(leftProps[key], rightProps[key], depth + 1));
}
