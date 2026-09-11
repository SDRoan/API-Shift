import { describe, expect, it } from 'vitest';
import type { OpenAPIV3 } from 'openapi-types';
import {
  enumValues,
  isTypeChangeBreaking,
  resolveAllOf,
  schemasEquivalent,
  splitTypeName,
  typeName,
} from '../../src/differ/schema.js';

describe('typeName', () => {
  it('names primitives', () => {
    expect(typeName({ type: 'string' })).toBe('string');
    expect(typeName({ type: 'integer' })).toBe('integer');
    expect(typeName({ type: 'boolean' })).toBe('boolean');
  });

  it('includes format, since a format change is a real contract change', () => {
    expect(typeName({ type: 'string', format: 'date-time' })).toBe('string:date-time');
  });

  it('names arrays by their item type', () => {
    expect(typeName({ type: 'array', items: { type: 'string' } })).toBe('array<string>');
  });

  it('treats a property bag with no declared type as an object', () => {
    expect(typeName({ properties: { id: { type: 'string' } } })).toBe('object');
  });

  it('returns unknown for a missing or unresolved schema', () => {
    expect(typeName(undefined)).toBe('unknown');
    expect(typeName({ $ref: '#/components/schemas/Thing' })).toBe('unknown');
  });

  it('names union members rather than just counting them', () => {
    // oneOf<3> to oneOf<4> tells you nothing. Naming members says what appeared.
    expect(typeName({ oneOf: [{ type: 'string' }, { type: 'integer' }] })).toBe('oneOf<2: integer|string>');
    expect(typeName({ anyOf: [{ type: 'string' }] })).toBe('anyOf<1: string>');
  });

  it('survives a union nested inside a union, however deep', () => {
    // Naming members means recursing into them. Cloudflare's 2164 path spec
    // overflowed the stack here, since nothing capped the descent.
    let nested: OpenAPIV3.SchemaObject = { type: 'string' };
    for (let level = 0; level < 200; level += 1) {
      nested = { oneOf: [{ type: 'array', items: nested } as OpenAPIV3.SchemaObject] };
    }

    expect(() => typeName(nested)).not.toThrow();
    expect(typeName(nested)).toMatch(/^oneOf</);
  });

  it('falls back to a count when a union is too wide to read', () => {
    // Twenty distinct member names would spell out past any readable length.
    const wide: OpenAPIV3.SchemaObject = {
      oneOf: Array.from({ length: 20 }, (_, index) => ({ type: 'string', format: 'fmt' + index }) as OpenAPIV3.SchemaObject),
    };
    expect(typeName(wide)).toBe('oneOf<20>');
  });
});

describe('resolveAllOf', () => {
  it('merges member properties and required sets', () => {
    const merged = resolveAllOf({
      allOf: [
        { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        { type: 'object', properties: { amount: { type: 'integer' } }, required: ['amount'] },
      ],
    });

    expect(Object.keys(merged.properties ?? {}).sort()).toEqual(['amount', 'id']);
    expect([...(merged.required ?? [])].sort()).toEqual(['amount', 'id']);
    expect(merged.allOf).toBeUndefined();
  });

  it('leaves a schema without allOf untouched', () => {
    const schema: OpenAPIV3.SchemaObject = { type: 'string' };
    expect(resolveAllOf(schema)).toBe(schema);
  });
});

describe('enumValues', () => {
  it('returns sorted string values', () => {
    expect(enumValues({ type: 'string', enum: ['pending', 'failed'] })).toEqual([
      'failed',
      'pending',
    ]);
  });

  it('returns undefined when there is no enum', () => {
    expect(enumValues({ type: 'string' })).toBeUndefined();
  });
});

describe('schemasEquivalent', () => {
  it('matches identical primitives', () => {
    expect(schemasEquivalent({ type: 'integer' }, { type: 'integer' })).toBe(true);
  });

  it('separates different types', () => {
    expect(schemasEquivalent({ type: 'integer' }, { type: 'string' })).toBe(false);
  });

  it('separates different enums of the same type', () => {
    expect(
      schemasEquivalent({ type: 'string', enum: ['a'] }, { type: 'string', enum: ['b'] }),
    ).toBe(false);
  });

  it('compares nested object shapes', () => {
    const left: OpenAPIV3.SchemaObject = {
      type: 'object',
      properties: { card: { type: 'object', properties: { last4: { type: 'string' } } } },
    };
    const right: OpenAPIV3.SchemaObject = {
      type: 'object',
      properties: { card: { type: 'object', properties: { last4: { type: 'string' } } } },
    };
    const different: OpenAPIV3.SchemaObject = {
      type: 'object',
      properties: { card: { type: 'object', properties: { last4: { type: 'integer' } } } },
    };

    expect(schemasEquivalent(left, right)).toBe(true);
    expect(schemasEquivalent(left, different)).toBe(false);
  });

  it('compares array item types', () => {
    expect(
      schemasEquivalent(
        { type: 'array', items: { type: 'string' } },
        { type: 'array', items: { type: 'string' } },
      ),
    ).toBe(true);
    expect(
      schemasEquivalent(
        { type: 'array', items: { type: 'string' } },
        { type: 'array', items: { type: 'integer' } },
      ),
    ).toBe(false);
  });

  it('separates schemas whose required sets differ', () => {
    expect(
      schemasEquivalent(
        { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        { type: 'object', properties: { id: { type: 'string' } } },
      ),
    ).toBe(false);
  });

  it('terminates on a self referencing schema', () => {
    const cyclic: OpenAPIV3.SchemaObject = { type: 'object', properties: {} };
    cyclic.properties = { self: cyclic };
    expect(schemasEquivalent(cyclic, cyclic)).toBe(true);
  });
});

describe('isTypeChangeBreaking', () => {
  it('breaks when the base type actually moves', () => {
    expect(isTypeChangeBreaking('string', 'integer')).toBe(true);
    expect(isTypeChangeBreaking('object', 'oneOf<15>')).toBe(true);
    expect(isTypeChangeBreaking('array<string>', 'array<integer>')).toBe(true);
  });

  it('does not break when a numeric format is merely annotated', () => {
    // Twilio added format: int64 to an already integer parameter and produced
    // 61 false breaking changes. Both are `number` in JavaScript.
    expect(isTypeChangeBreaking('integer', 'integer:int64')).toBe(false);
    expect(isTypeChangeBreaking('integer:int64', 'integer')).toBe(false);
    expect(isTypeChangeBreaking('number', 'number:double')).toBe(false);
  });

  it('still breaks when a declared numeric width changes', () => {
    // int32 to int64 can exceed the safe integer range in JavaScript.
    expect(isTypeChangeBreaking('integer:int32', 'integer:int64')).toBe(true);
    expect(isTypeChangeBreaking('number:float', 'number:double')).toBe(true);
  });

  it('breaks when a string format changes, since parsing changes', () => {
    expect(isTypeChangeBreaking('string', 'string:date-time')).toBe(true);
    expect(isTypeChangeBreaking('string:date', 'string:date-time')).toBe(true);
    expect(isTypeChangeBreaking('string:uuid', 'string')).toBe(true);
  });

  it('does not break when nothing changed', () => {
    expect(isTypeChangeBreaking('integer:int64', 'integer:int64')).toBe(false);
    expect(isTypeChangeBreaking('string', 'string')).toBe(false);
  });
});

describe('splitTypeName', () => {
  it('separates a base type from its format', () => {
    expect(splitTypeName('string:date-time')).toEqual({ base: 'string', format: 'date-time' });
    expect(splitTypeName('integer')).toEqual({ base: 'integer', format: undefined });
  });
});
