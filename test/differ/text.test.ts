import { describe, expect, it } from 'vitest';
import {
  levenshtein,
  namesRelated,
  normalizeName,
  pathSimilarity,
  similarity,
} from '../../src/differ/text.js';

describe('levenshtein', () => {
  it('is zero for identical strings', () => {
    expect(levenshtein('amount', 'amount')).toBe(0);
  });

  it('counts single edits', () => {
    expect(levenshtein('amount', 'amounts')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('falls back to length when one side is empty', () => {
    expect(levenshtein('', 'charge')).toBe(6);
    expect(levenshtein('charge', '')).toBe(6);
  });

  it('is symmetric', () => {
    expect(levenshtein('charges', 'payments')).toBe(levenshtein('payments', 'charges'));
  });
});

describe('similarity', () => {
  it('reports 1 for identical strings and 1 for two empty strings', () => {
    expect(similarity('a', 'a')).toBe(1);
    expect(similarity('', '')).toBe(1);
  });

  it('drops as strings diverge', () => {
    expect(similarity('amount', 'amount_cents')).toBeGreaterThan(0.4);
    expect(similarity('amount', 'zzzzzz')).toBeLessThan(0.2);
  });
});

describe('normalizeName', () => {
  it('collapses casing and separators', () => {
    expect(normalizeName('userId')).toBe('userid');
    expect(normalizeName('user_id')).toBe('userid');
    expect(normalizeName('USER-ID')).toBe('userid');
  });
});

describe('namesRelated', () => {
  it('accepts a casing change', () => {
    expect(namesRelated('userId', 'user_id')).toBe(true);
  });

  it('accepts a unit suffix', () => {
    expect(namesRelated('amount', 'amount_cents')).toBe(true);
    expect(namesRelated('duration', 'durationMs')).toBe(true);
  });

  it('accepts a prefix qualifier', () => {
    expect(namesRelated('id', 'charge_id')).toBe(true);
  });

  it('accepts a small spelling edit', () => {
    expect(namesRelated('recipient', 'receipient')).toBe(true);
  });

  it('rejects unrelated names', () => {
    expect(namesRelated('amount', 'currency')).toBe(false);
    expect(namesRelated('source', 'destination')).toBe(false);
  });

  it('rejects a suffix that is too long to be a unit', () => {
    expect(namesRelated('amount', 'amountOfSomethingElseEntirely')).toBe(false);
  });

  it('rejects empty names', () => {
    expect(namesRelated('', 'amount')).toBe(false);
  });
});

describe('pathSimilarity', () => {
  it('ignores template parameter names', () => {
    expect(pathSimilarity('/v1/charges/{id}', '/v1/charges/{chargeId}')).toBe(1);
  });

  it('still separates unrelated paths', () => {
    expect(pathSimilarity('/v1/charges', '/v1/webhooks')).toBeLessThan(0.5);
  });
});
