import { describe, expect, it } from 'vitest';
import type { ApiChange } from '../../src/types.js';
import { changeId, makeChange, sortChanges } from '../../src/differ/changes.js';
import { lowestConfidence, isAutoApplicable } from '../../src/confidence.js';
import { changesOf, doc, jsonBody, object } from './helpers.js';

const base = {
  kind: 'request.field.renamed',
  breaking: true,
  confidence: 'high',
  path: '/v1/charges',
  method: 'post',
  detail: 'amount renamed to amount_cents',
  target: { location: 'body', from: 'amount', to: 'amount_cents' },
} as const;

describe('changeId', () => {
  it('is stable for the same change', () => {
    expect(changeId(base)).toBe(changeId({ ...base }));
  });

  it('ignores the human readable detail, which is presentation only', () => {
    expect(changeId({ ...base, detail: 'worded differently' })).toBe(changeId(base));
  });

  it('separates changes that differ in target', () => {
    expect(changeId({ ...base, target: { ...base.target, to: 'amount_minor' } })).not.toBe(changeId(base));
  });

  it('separates changes that differ in path or method', () => {
    expect(changeId({ ...base, path: '/v1/refunds' })).not.toBe(changeId(base));
    expect(changeId({ ...base, method: 'put' })).not.toBe(changeId(base));
  });
});

describe('makeChange', () => {
  it('omits absent optional keys rather than setting them to undefined', () => {
    const change = makeChange({
      kind: 'operation.removed',
      breaking: true,
      confidence: 'high',
      path: '/v1/charges',
      detail: 'removed',
    });

    expect(Object.keys(change).sort()).toEqual(['breaking', 'confidence', 'detail', 'id', 'kind', 'path']);
    expect(JSON.parse(JSON.stringify(change))).toEqual(change);
  });
});

describe('sortChanges', () => {
  it('leads with breaking changes', () => {
    const safe = makeChange({ ...base, kind: 'operation.added', breaking: false });
    const breaking = makeChange(base);

    expect(sortChanges([safe, breaking]).map((change) => change.breaking)).toEqual([true, false]);
  });

  it('is deterministic regardless of input order', () => {
    const changes: ApiChange[] = [
      makeChange({ ...base, path: '/v1/refunds' }),
      makeChange({ ...base, kind: 'operation.added', breaking: false }),
      makeChange(base),
    ];

    const forward = sortChanges(changes).map((change) => change.id);
    const backward = sortChanges([...changes].reverse()).map((change) => change.id);
    expect(forward).toEqual(backward);
  });
});

describe('diff output stability', () => {
  it('produces identical ids across runs of the same spec pair', async () => {
    const before = doc({
      '/v1/charges': { post: { operationId: 'createCharge', requestBody: jsonBody(object({ amount: { type: 'integer' } })), responses: { '200': { description: 'ok' } } } },
    });
    const after = doc({
      '/v1/charges': { post: { operationId: 'createCharge', requestBody: jsonBody(object({ amount_cents: { type: 'integer' } })), responses: { '200': { description: 'ok' } } } },
    });

    const first = await changesOf(before, after);
    const second = await changesOf(before, after);
    expect(first).toEqual(second);
  });
});

describe('confidence model', () => {
  it('takes the weakest link', () => {
    expect(lowestConfidence('high', 'high')).toBe('high');
    expect(lowestConfidence('high', 'medium', 'high')).toBe('medium');
    expect(lowestConfidence('high', 'medium', 'low')).toBe('low');
  });

  it('defaults to high when given nothing to weaken it', () => {
    expect(lowestConfidence()).toBe('high');
  });

  it('only auto applies at high', () => {
    expect(isAutoApplicable('high')).toBe(true);
    expect(isAutoApplicable('medium')).toBe(false);
    expect(isAutoApplicable('low')).toBe(false);
  });
});
