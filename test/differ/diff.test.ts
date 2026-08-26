/**
 * One fixture pair per change kind. Each pair differs in exactly one way, so a
 * failure names the rule that broke.
 */

import { describe, expect, it } from 'vitest';
import type { OpenAPIV3 } from 'openapi-types';
import { changesOf, doc, jsonBody, jsonResponse, kinds, object, ofKind, onlyOfKind } from './helpers.js';

const okResponse = { '200': { description: 'ok' } };

describe('no differences', () => {
  it('reports nothing for two identical specs', async () => {
    const spec = doc({ '/v1/charges': { get: { operationId: 'listCharges', responses: okResponse } } });
    expect(await changesOf(spec, spec)).toEqual([]);
  });
});

describe('operations', () => {
  it('flags a removed operation as breaking', async () => {
    const before = doc({ '/v1/charges': { get: { operationId: 'listCharges', responses: okResponse } } });
    const after = doc({});

    const change = onlyOfKind(await changesOf(before, after), 'operation.removed');
    expect(change.breaking).toBe(true);
    expect(change.path).toBe('/v1/charges');
    expect(change.method).toBe('get');
  });

  it('treats a new operation as non breaking', async () => {
    const before = doc({});
    const after = doc({ '/v1/refunds': { post: { operationId: 'createRefund', responses: okResponse } } });

    const change = onlyOfKind(await changesOf(before, after), 'operation.added');
    expect(change.breaking).toBe(false);
  });

  it('flags a removed success status', async () => {
    const before = doc({
      '/v1/charges': { get: { responses: { '200': { description: 'ok' }, '202': { description: 'queued' } } } },
    });
    const after = doc({ '/v1/charges': { get: { responses: okResponse } } });

    const change = onlyOfKind(await changesOf(before, after), 'response.status.removed');
    expect(change.breaking).toBe(true);
    expect(change.target?.from).toBe('202');
  });

  it('ignores a removed error status, which does not break calling code', async () => {
    const before = doc({
      '/v1/charges': { get: { responses: { '200': { description: 'ok' }, '404': { description: 'missing' } } } },
    });
    const after = doc({ '/v1/charges': { get: { responses: okResponse } } });

    expect(await changesOf(before, after)).toEqual([]);
  });
});

describe('path renames', () => {
  it('pairs on a shared operationId with high confidence', async () => {
    const before = doc({ '/v1/charges': { post: { operationId: 'createCharge', responses: okResponse } } });
    const after = doc({ '/v1/payments': { post: { operationId: 'createCharge', responses: okResponse } } });

    const changes = await changesOf(before, after);
    const change = onlyOfKind(changes, 'path.renamed');
    expect(change.confidence).toBe('high');
    expect(change.breaking).toBe(true);
    expect(change.target).toMatchObject({ location: 'path', from: '/v1/charges', to: '/v1/payments' });
    expect(kinds(changes)).not.toContain('operation.removed');
  });

  it('pairs on schema and name resemblance with medium confidence', async () => {
    const body = jsonBody(object({ amount: { type: 'integer' } }, ['amount']));
    const before = doc({ '/v1/charges': { post: { requestBody: body, responses: okResponse } } });
    const after = doc({ '/v1/charge': { post: { requestBody: body, responses: okResponse } } });

    expect(onlyOfKind(await changesOf(before, after), 'path.renamed').confidence).toBe('medium');
  });

  it('collapses a path move that covers several methods into one change', async () => {
    const before = doc({
      '/v1/charges': {
        get: { operationId: 'listCharges', responses: okResponse },
        post: { operationId: 'createCharge', responses: okResponse },
      },
    });
    const after = doc({
      '/v1/payments': {
        get: { operationId: 'listCharges', responses: okResponse },
        post: { operationId: 'createCharge', responses: okResponse },
      },
    });

    const change = onlyOfKind(await changesOf(before, after), 'path.renamed');
    // No single method owns the rewrite, so the change carries none.
    expect(change.method).toBeUndefined();
  });

  it('does not invent a rename between unrelated paths', async () => {
    const before = doc({ '/v1/charges': { post: { responses: okResponse } } });
    const after = doc({ '/v1/subscription_schedules': { post: { responses: okResponse } } });

    const changes = await changesOf(before, after);
    expect(kinds(changes).sort()).toEqual(['operation.added', 'operation.removed']);
  });

  it('does not pair across methods', async () => {
    const before = doc({ '/v1/charges': { get: { operationId: 'listCharges', responses: okResponse } } });
    const after = doc({ '/v1/payments': { post: { operationId: 'listCharges', responses: okResponse } } });

    expect(ofKind(await changesOf(before, after), 'path.renamed')).toHaveLength(0);
  });

  it('still reports field changes inside a renamed path, capped at the rename confidence', async () => {
    const before = doc({
      '/v1/charges': {
        post: {
          requestBody: jsonBody(object({ amount: { type: 'integer' } })),
          responses: okResponse,
        },
      },
    });
    const after = doc({
      '/v1/charge': {
        post: {
          requestBody: jsonBody(object({ amount: { type: 'string' } })),
          responses: okResponse,
        },
      },
    });

    const changes = await changesOf(before, after);
    const rename = onlyOfKind(changes, 'path.renamed');
    const typeChange = onlyOfKind(changes, 'request.field.type.changed');
    expect(rename.confidence).toBe('medium');
    // A change found underneath an inferred rename cannot be more certain than the rename.
    expect(typeChange.confidence).toBe('medium');
    expect(typeChange.path).toBe('/v1/charges');
  });
});

describe('parameters', () => {
  const withParams = (parameters: OpenAPIV3.ParameterObject[]): ReturnType<typeof doc> =>
    doc({ '/v1/charges': { get: { operationId: 'listCharges', parameters, responses: okResponse } } });

  it('treats a removed parameter as non breaking', async () => {
    const before = withParams([{ name: 'limit', in: 'query', schema: { type: 'integer' } }]);
    const after = withParams([]);

    const change = onlyOfKind(await changesOf(before, after), 'param.removed');
    expect(change.breaking).toBe(false);
    expect(change.direction).toBe('request');
  });

  it('flags a new required parameter as breaking', async () => {
    const before = withParams([]);
    const after = withParams([
      { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } },
    ]);

    const change = onlyOfKind(await changesOf(before, after), 'param.added.required');
    expect(change.breaking).toBe(true);
    expect(change.target).toMatchObject({ location: 'header', to: 'Idempotency-Key' });
  });

  it('ignores a new optional parameter', async () => {
    const before = withParams([]);
    const after = withParams([{ name: 'expand', in: 'query', schema: { type: 'string' } }]);

    expect(await changesOf(before, after)).toEqual([]);
  });

  it('detects a renamed parameter', async () => {
    const before = withParams([{ name: 'starting_after', in: 'query', schema: { type: 'string' } }]);
    const after = withParams([{ name: 'startingAfter', in: 'query', schema: { type: 'string' } }]);

    const change = onlyOfKind(await changesOf(before, after), 'param.renamed');
    expect(change.confidence).toBe('high');
    expect(change.target).toMatchObject({ from: 'starting_after', to: 'startingAfter' });
  });

  it('detects a parameter type change', async () => {
    const before = withParams([{ name: 'limit', in: 'query', schema: { type: 'integer' } }]);
    const after = withParams([{ name: 'limit', in: 'query', schema: { type: 'string' } }]);

    const change = onlyOfKind(await changesOf(before, after), 'param.type.changed');
    expect(change.target).toMatchObject({ fromType: 'integer', toType: 'string' });
  });

  it('detects an optional parameter becoming required', async () => {
    const before = withParams([{ name: 'limit', in: 'query', schema: { type: 'integer' } }]);
    const after = withParams([
      { name: 'limit', in: 'query', required: true, schema: { type: 'integer' } },
    ]);

    expect(onlyOfKind(await changesOf(before, after), 'param.became.required').breaking).toBe(true);
  });

  it('merges path level parameters into every operation', async () => {
    const before = doc({
      '/v1/charges': {
        parameters: [{ name: 'account', in: 'header', schema: { type: 'string' } }],
        get: { operationId: 'listCharges', responses: okResponse },
      },
    });
    const after = doc({
      '/v1/charges': { get: { operationId: 'listCharges', responses: okResponse } },
    });

    expect(onlyOfKind(await changesOf(before, after), 'param.removed').target?.from).toBe('account');
  });
});

describe('request fields', () => {
  const withBody = (schema: Parameters<typeof jsonBody>[0]): ReturnType<typeof doc> =>
    doc({ '/v1/charges': { post: { operationId: 'createCharge', requestBody: jsonBody(schema), responses: okResponse } } });

  it('detects a renamed field', async () => {
    const before = withBody(object({ amount: { type: 'integer' } }, ['amount']));
    const after = withBody(object({ amount_cents: { type: 'integer' } }, ['amount_cents']));

    const change = onlyOfKind(await changesOf(before, after), 'request.field.renamed');
    expect(change.confidence).toBe('high');
    expect(change.direction).toBe('request');
    expect(change.target).toMatchObject({ location: 'body', from: 'amount', to: 'amount_cents' });
  });

  it('treats a removed optional field as non breaking, since the server ignores it', async () => {
    const before = withBody(object({ amount: { type: 'integer' }, note: { type: 'string' } }));
    const after = withBody(object({ amount: { type: 'integer' } }));

    expect(onlyOfKind(await changesOf(before, after), 'request.field.removed').breaking).toBe(false);
  });

  it('treats a removed required field as breaking', async () => {
    const before = withBody(object({ amount: { type: 'integer' }, note: { type: 'string' } }, ['note']));
    const after = withBody(object({ amount: { type: 'integer' } }));

    expect(onlyOfKind(await changesOf(before, after), 'request.field.removed').breaking).toBe(true);
  });

  it('flags a new required field', async () => {
    const before = withBody(object({ amount: { type: 'integer' } }));
    const after = withBody(object({ amount: { type: 'integer' }, idempotency_key: { type: 'string' } }, ['idempotency_key']));

    const change = onlyOfKind(await changesOf(before, after), 'request.field.added.required');
    expect(change.breaking).toBe(true);
    expect(change.target?.to).toBe('idempotency_key');
  });

  it('ignores a new optional field', async () => {
    const before = withBody(object({ amount: { type: 'integer' } }));
    const after = withBody(object({ amount: { type: 'integer' }, note: { type: 'string' } }));

    expect(await changesOf(before, after)).toEqual([]);
  });

  it('detects an existing field becoming required', async () => {
    const before = withBody(object({ amount: { type: 'integer' } }));
    const after = withBody(object({ amount: { type: 'integer' } }, ['amount']));

    expect(onlyOfKind(await changesOf(before, after), 'request.field.became.required').breaking).toBe(true);
  });

  it('detects a field type change', async () => {
    const before = withBody(object({ amount: { type: 'string' } }));
    const after = withBody(object({ amount: { type: 'integer' } }));

    const change = onlyOfKind(await changesOf(before, after), 'request.field.type.changed');
    expect(change.target).toMatchObject({ from: 'amount', fromType: 'string', toType: 'integer' });
  });

  it('reports nested fields by dot path', async () => {
    const before = withBody(object({ card: object({ number: { type: 'string' } }) }));
    const after = withBody(object({ card: object({ pan: { type: 'string' } }) }));

    expect(onlyOfKind(await changesOf(before, after), 'request.field.renamed').target).toMatchObject({
      from: 'card.number',
      to: 'card.pan',
    });
  });

  it('does not pair a rename across object levels', async () => {
    const before = withBody(object({ amount: { type: 'integer' }, card: object({}) }));
    const after = withBody(object({ card: object({ amount_cents: { type: 'integer' } }) }));

    const changes = await changesOf(before, after);
    expect(ofKind(changes, 'request.field.renamed')).toHaveLength(0);
    expect(ofKind(changes, 'request.field.removed')).toHaveLength(1);
  });
});

describe('response fields', () => {
  const withResponse = (schema: Parameters<typeof jsonResponse>[0]): ReturnType<typeof doc> =>
    doc({ '/v1/charges': { get: { operationId: 'listCharges', responses: jsonResponse(schema) } } });

  it('detects a renamed field', async () => {
    const before = withResponse(object({ amount: { type: 'integer' } }));
    const after = withResponse(object({ amount_cents: { type: 'integer' } }));

    const change = onlyOfKind(await changesOf(before, after), 'response.field.renamed');
    expect(change.direction).toBe('response');
    expect(change.target).toMatchObject({ location: 'response', from: 'amount', to: 'amount_cents' });
  });

  it('treats any removed field as breaking, because a consumer reads it today', async () => {
    const before = withResponse(object({ id: { type: 'string' }, note: { type: 'string' } }));
    const after = withResponse(object({ id: { type: 'string' } }));

    expect(onlyOfKind(await changesOf(before, after), 'response.field.removed').breaking).toBe(true);
  });

  it('ignores a new field', async () => {
    const before = withResponse(object({ id: { type: 'string' } }));
    const after = withResponse(object({ id: { type: 'string' }, receipt_url: { type: 'string' } }));

    expect(await changesOf(before, after)).toEqual([]);
  });

  it('detects a field type change', async () => {
    const before = withResponse(object({ currency: { type: 'string' } }));
    const after = withResponse(object({ currency: { type: 'integer' } }));

    const change = onlyOfKind(await changesOf(before, after), 'response.field.type.changed');
    expect(change.breaking).toBe(true);
    expect(change.target).toMatchObject({ fromType: 'string', toType: 'integer' });
  });

  it('marks array items with a bracket segment', async () => {
    const items = (property: string): Parameters<typeof jsonResponse>[0] =>
      object({ data: { type: 'array', items: object({ [property]: { type: 'integer' } }) } });

    const change = onlyOfKind(
      await changesOf(withResponse(items('amount')), withResponse(items('amount_cents'))),
      'response.field.renamed',
    );
    expect(change.target).toMatchObject({ from: 'data[].amount', to: 'data[].amount_cents' });
  });

  it('collapses a cascade into the parent change that caused it', async () => {
    // A parent whose type changes makes every field under it look removed. The
    // parent is the fact, the descendants are its shadow.
    const before = withResponse(
      object({ payload: object({ action: { type: 'string' }, id: { type: 'integer' } }) }),
    );
    const after = withResponse(
      object({ payload: { oneOf: [{ type: 'string' }, { type: 'integer' }] } }),
    );

    const changes = await changesOf(before, after);
    expect(kinds(changes)).toEqual(['response.field.type.changed']);
    expect(changes[0]?.target?.from).toBe('payload');
    expect(changes[0]?.detail).toContain('2 nested fields below it');
  });

  it('collapses descendants of a removed parent too', async () => {
    const before = withResponse(object({ card: object({ last4: { type: 'string' } }), id: { type: 'string' } }));
    const after = withResponse(object({ id: { type: 'string' } }));

    const changes = await changesOf(before, after);
    expect(kinds(changes)).toEqual(['response.field.removed']);
    expect(changes[0]?.target?.from).toBe('card');
  });

  it('still reports a nested change when its parent did not change', async () => {
    const before = withResponse(object({ card: object({ last4: { type: 'string' } }) }));
    const after = withResponse(object({ card: object({ last_four: { type: 'string' } }) }));

    expect(onlyOfKind(await changesOf(before, after), 'response.field.renamed').target).toMatchObject({
      from: 'card.last4',
      to: 'card.last_four',
    });
  });

  it('keeps a rename high confidence when an unrelated field was also added', async () => {
    const before = withResponse(object({ amount: { type: 'integer' } }));
    const after = withResponse(object({ amount_cents: { type: 'integer' }, receipt_url: { type: 'string' } }));

    expect(onlyOfKind(await changesOf(before, after), 'response.field.renamed').confidence).toBe('high');
  });
});

describe('enum values, where direction flips the meaning', () => {
  const requestEnum = (values: string[]): ReturnType<typeof doc> =>
    doc({
      '/v1/charges': {
        post: {
          operationId: 'createCharge',
          requestBody: jsonBody(object({ currency: { type: 'string', enum: values } })),
          responses: okResponse,
        },
      },
    });

  const responseEnum = (values: string[]): ReturnType<typeof doc> =>
    doc({
      '/v1/charges': {
        get: {
          operationId: 'listCharges',
          responses: jsonResponse(object({ status: { type: 'string', enum: values } })),
        },
      },
    });

  it('breaks on a request value removed, because a consumer may still send it', async () => {
    const change = onlyOfKind(
      await changesOf(requestEnum(['usd', 'eur']), requestEnum(['usd'])),
      'enum.value.removed',
    );
    expect(change.breaking).toBe(true);
    expect(change.direction).toBe('request');
  });

  it('does not break on a request value added', async () => {
    const change = onlyOfKind(
      await changesOf(requestEnum(['usd']), requestEnum(['usd', 'eur'])),
      'enum.value.added',
    );
    expect(change.breaking).toBe(false);
  });

  it('breaks on a response value added, because a consumer may not handle it', async () => {
    const change = onlyOfKind(
      await changesOf(responseEnum(['pending']), responseEnum(['pending', 'refunded'])),
      'enum.value.added',
    );
    expect(change.breaking).toBe(true);
    expect(change.direction).toBe('response');
  });

  it('does not break on a response value removed', async () => {
    const change = onlyOfKind(
      await changesOf(responseEnum(['pending', 'refunded']), responseEnum(['pending'])),
      'enum.value.removed',
    );
    expect(change.breaking).toBe(false);
  });
});
