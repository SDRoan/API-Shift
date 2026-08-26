/**
 * URL matching in isolation. This is the primitive every other strategy sits on,
 * so the negative cases carry most of the weight.
 */

import { describe, expect, it } from 'vitest';
import { Node, Project, SyntaxKind } from 'ts-morph';
import {
  INTERPOLATION,
  literalPrefixOf,
  matchSpecPath,
  rewritePath,
  urlShapeOf,
  type UrlShape,
} from '../../src/scanner/url.js';

/** Parse an expression and hand back its node, so tests read like real code. */
function expression(code: string): Node {
  const file = new Project({ useInMemoryFileSystem: true }).createSourceFile('t.ts', `const x = ${code};`);
  const declaration = file.getFirstDescendantByKindOrThrow(SyntaxKind.VariableDeclaration);
  const initializer = declaration.getInitializer();
  if (initializer === undefined) throw new Error('no initializer');
  return initializer;
}

const shapeOf = (code: string): UrlShape => {
  const shape = urlShapeOf(expression(code));
  if (shape === undefined) throw new Error(`no shape for ${code}`);
  return shape;
};

describe('urlShapeOf', () => {
  it('reads a plain string literal', () => {
    expect(shapeOf(`'/v1/charges'`)).toEqual({ text: '/v1/charges', dynamic: false });
  });

  it('reads a template with no substitutions', () => {
    expect(shapeOf('`/v1/charges`')).toEqual({ text: '/v1/charges', dynamic: false });
  });

  it('collapses interpolations to a sentinel', () => {
    const shape = shapeOf('`${API_BASE}/v1/charges/${chargeId}`');
    expect(shape.dynamic).toBe(true);
    expect(shape.text).toBe(`${INTERPOLATION}/v1/charges/${INTERPOLATION}`);
  });

  it('reads string concatenation', () => {
    expect(shapeOf(`API_BASE + '/v1/charges'`).text).toBe(`${INTERPOLATION}/v1/charges`);
  });

  it('refuses to guess at a bare identifier', () => {
    expect(urlShapeOf(expression('someUrl'))).toBeUndefined();
  });

  it('refuses a call expression', () => {
    expect(urlShapeOf(expression('buildUrl()'))).toBeUndefined();
  });
});

describe('literalPrefixOf', () => {
  it('returns the whole path when it has no parameters', () => {
    expect(literalPrefixOf('/v1/charges')).toBe('/v1/charges');
  });

  it('stops at the first parameter', () => {
    expect(literalPrefixOf('/v1/charges/{chargeId}')).toBe('/v1/charges');
    expect(literalPrefixOf('/v1/{account}/charges')).toBe('/v1');
    expect(literalPrefixOf('/{account}/charges')).toBe('/');
  });
});

describe('matchSpecPath', () => {
  it('matches a plain literal', () => {
    expect(matchSpecPath(shapeOf(`'/v1/charges'`), '/v1/charges')).toBeDefined();
  });

  it('matches through an interpolated base URL', () => {
    expect(matchSpecPath(shapeOf('`${API_BASE}/v1/charges`'), '/v1/charges')).toBeDefined();
  });

  it('matches through a literal origin', () => {
    expect(matchSpecPath(shapeOf(`'https://api.acme.test/v1/charges'`), '/v1/charges')).toBeDefined();
  });

  it('lets an interpolation fill a path parameter', () => {
    expect(matchSpecPath(shapeOf('`${API_BASE}/v1/charges/${id}`'), '/v1/charges/{chargeId}')).toBeDefined();
  });

  it('lets a concrete value fill a path parameter', () => {
    expect(matchSpecPath(shapeOf(`'/v1/charges/ch_123'`), '/v1/charges/{chargeId}')).toBeDefined();
  });

  it('ignores the query string', () => {
    expect(matchSpecPath(shapeOf(`'/v1/charges?limit=10'`), '/v1/charges')).toBeDefined();
  });

  it('tolerates a proxy prefix', () => {
    expect(matchSpecPath(shapeOf(`'/api/proxy/v1/charges'`), '/v1/charges')).toBeDefined();
  });

  it('does not match a collection URL against an item path', () => {
    expect(matchSpecPath(shapeOf(`'/v1/charges'`), '/v1/charges/{chargeId}')).toBeUndefined();
  });

  it('does not match an item URL against a collection path', () => {
    expect(matchSpecPath(shapeOf(`'/v1/charges/ch_123'`), '/v1/charges')).toBeUndefined();
  });

  it('does not match a different resource', () => {
    expect(matchSpecPath(shapeOf(`'/v1/refunds'`), '/v1/charges')).toBeUndefined();
  });

  it('does not match on a partial segment', () => {
    expect(matchSpecPath(shapeOf(`'/v1/charges_archive'`), '/v1/charges')).toBeUndefined();
  });

  it('refuses when an interpolation covers a literal segment we cannot confirm', () => {
    expect(matchSpecPath(shapeOf('`/v1/${resource}`'), '/v1/charges')).toBeUndefined();
  });
});

describe('rewritePath', () => {
  it('rewrites the literal prefix inside a plain literal', () => {
    expect(rewritePath('/v1/charges', '/v1/charges', '/v1/payments')).toBe('/v1/payments');
  });

  it('rewrites inside a template, leaving interpolations alone', () => {
    expect(rewritePath('${API_BASE}/v1/charges/${id}', '/v1/charges/{chargeId}', '/v1/payments/{chargeId}')).toBe(
      '${API_BASE}/v1/payments/${id}',
    );
  });

  it('rewrites only the first occurrence, which is the path', () => {
    expect(rewritePath('/v1/charges?from=/v1/charges', '/v1/charges', '/v1/payments')).toBe(
      '/v1/payments?from=/v1/charges',
    );
  });

  it('declines when the parameter structure changed', () => {
    expect(rewritePath('/v1/charges/x', '/v1/charges/{id}', '/v1/payments/{id}/detail')).toBeUndefined();
  });

  it('declines when nothing actually moved', () => {
    expect(rewritePath('/v1/charges', '/v1/charges', '/v1/charges')).toBeUndefined();
  });
});
