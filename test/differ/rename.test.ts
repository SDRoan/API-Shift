/**
 * Rename inference in isolation. The negative cases matter more than the
 * positive ones here: a false rename makes a codemod rewrite correct code.
 */

import { describe, expect, it } from 'vitest';
import type { FieldModel, OperationModel, ParamModel } from '../../src/differ/model.js';
import {
  inferFieldRenames,
  inferOperationRenames,
  inferParamRenames,
} from '../../src/differ/rename.js';

function operation(partial: Partial<OperationModel> & { path: string }): OperationModel {
  return {
    key: `POST ${partial.path}`,
    method: 'post',
    params: [],
    requestFields: [],
    responseFields: [],
    responseStatuses: ['200'],
    ...partial,
  };
}

function field(name: string, type = 'string', parent = ''): FieldModel {
  return {
    pointer: parent === '' ? name : `${parent}.${name}`,
    name,
    parent,
    required: false,
    type,
    schema: { type: type as 'string' },
  };
}

function param(name: string, type = 'string'): ParamModel {
  return {
    name,
    location: 'query',
    required: false,
    type,
    schema: { type: type as 'string' },
  };
}

describe('inferOperationRenames', () => {
  it('pairs on a shared operationId', () => {
    const pairs = inferOperationRenames(
      [operation({ path: '/v1/charges', operationId: 'createCharge' })],
      [operation({ path: '/v1/payments', operationId: 'createCharge' })],
    );

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.confidence).toBe('high');
  });

  it('ignores an empty operationId rather than pairing everything that lacks one', () => {
    const pairs = inferOperationRenames(
      [operation({ path: '/v1/aaaa', operationId: '' })],
      [operation({ path: '/v1/zzzzzzzzzzzz', operationId: '' })],
    );

    expect(pairs).toHaveLength(0);
  });

  it('pairs one to one, never reusing a side', () => {
    const pairs = inferOperationRenames(
      [
        operation({ path: '/v1/charges', operationId: 'createCharge' }),
        operation({ path: '/v1/refunds', operationId: 'createRefund' }),
      ],
      [
        operation({ path: '/v1/payments', operationId: 'createCharge' }),
        operation({ path: '/v1/reversals', operationId: 'createRefund' }),
      ],
    );

    expect(pairs).toHaveLength(2);
    expect(new Set(pairs.map((pair) => pair.to.path)).size).toBe(2);
  });

  it('prefers the operationId match over a closer looking path', () => {
    const pairs = inferOperationRenames(
      [operation({ path: '/v1/charges', operationId: 'createCharge' })],
      [
        operation({ path: '/v1/chargez', operationId: 'somethingElse' }),
        operation({ path: '/v1/payments', operationId: 'createCharge' }),
      ],
    );

    expect(pairs[0]?.to.path).toBe('/v1/payments');
  });

  it('refuses to pair paths that are too dissimilar', () => {
    const pairs = inferOperationRenames(
      [operation({ path: '/v1/charges' })],
      [operation({ path: '/v1/subscription_schedules' })],
    );

    expect(pairs).toHaveLength(0);
  });

  it('refuses to pair operations whose payloads barely overlap', () => {
    const pairs = inferOperationRenames(
      [operation({ path: '/v1/charges', requestFields: [field('amount'), field('currency')] })],
      [operation({ path: '/v1/charge', requestFields: [field('token'), field('nonce')] })],
    );

    expect(pairs).toHaveLength(0);
  });

  it('still pairs when a field type changed alongside the rename', () => {
    const pairs = inferOperationRenames(
      [operation({ path: '/v1/charges', requestFields: [field('amount', 'string')] })],
      [operation({ path: '/v1/charge', requestFields: [field('amount', 'integer')] })],
    );

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.confidence).toBe('medium');
  });
});

describe('inferFieldRenames', () => {
  it('pairs a single unambiguous candidate with high confidence', () => {
    const pairs = inferFieldRenames([field('amount', 'integer')], [field('amount_cents', 'integer')]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.confidence).toBe('high');
  });

  it('drops to medium when several candidates of the same type compete', () => {
    const pairs = inferFieldRenames(
      [field('amount', 'integer'), field('fee', 'integer')],
      [field('amount_cents', 'integer'), field('fee_cents', 'integer')],
    );

    expect(pairs).toHaveLength(2);
    expect(pairs.every((pair) => pair.confidence === 'medium')).toBe(true);
    expect(pairs.find((pair) => pair.from.name === 'amount')?.to.name).toBe('amount_cents');
  });

  it('ignores a candidate of a different type', () => {
    expect(inferFieldRenames([field('amount', 'integer')], [field('amount_cents', 'string')])).toHaveLength(0);
  });

  it('does not pair across object levels', () => {
    expect(inferFieldRenames([field('amount', 'integer')], [field('amount', 'integer', 'card')])).toHaveLength(0);
  });

  it('does not pair names that are merely the same type', () => {
    const pairs = inferFieldRenames(
      [field('amount', 'integer'), field('quantity', 'integer')],
      [field('tax', 'integer'), field('discount', 'integer')],
    );

    expect(pairs).toHaveLength(0);
  });
});

describe('inferParamRenames', () => {
  it('pairs an unambiguous parameter rename', () => {
    const pairs = inferParamRenames([param('starting_after')], [param('startingAfter')]);
    expect(pairs[0]?.confidence).toBe('high');
  });

  it('does not pair across locations', () => {
    const header: ParamModel = { ...param('token'), location: 'header' };
    expect(inferParamRenames([param('token')], [header])).toHaveLength(0);
  });
});
