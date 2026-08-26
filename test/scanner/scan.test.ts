/**
 * The scanner against a fixture repo. Positive cases prove each strategy fires,
 * and the near miss cases prove it stays quiet, which is the property the old
 * string matching scanner could not hold.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { ApiChange, ChangeKind } from '../../src/types.js';
import { makeChange } from '../../src/differ/changes.js';
import { scanProject, type ScannedSite } from '../../src/scanner/index.js';

const REPO = fileURLToPath(new URL('../fixtures/consumer', import.meta.url));

function change(overrides: Partial<Parameters<typeof makeChange>[0]> & { kind: ChangeKind }): ApiChange {
  return makeChange({
    breaking: true,
    confidence: 'high',
    path: '/v1/charges',
    detail: 'test change',
    ...overrides,
  });
}

const scan = (...changes: ApiChange[]): ScannedSite[] => scanProject(REPO, changes).sites;

const linesOf = (sites: ScannedSite[]): number[] => [...new Set(sites.map((site) => site.line))].sort((a, b) => a - b);

const pathRename = change({
  kind: 'path.renamed',
  target: { location: 'path', from: '/v1/charges', to: '/v1/payments' },
});

describe('path renames', () => {
  const sites = scan(pathRename);

  it('finds the plain literal, the template, the axios call, and the config object', () => {
    expect(sites.length).toBeGreaterThanOrEqual(4);
    expect(sites.every((site) => site.codemod === 'rename-path')).toBe(true);
  });

  it('rewrites a plain string literal', () => {
    const site = sites.find((candidate) => candidate.snippet === `'/v1/charges'`);
    expect(site?.replacement).toBe(`'/v1/payments'`);
    expect(site?.strategy).toBe('url.literal');
  });

  it('rewrites a template while leaving its interpolations alone', () => {
    const site = sites.find((candidate) => candidate.snippet.includes('${API_BASE}/v1/charges`'));
    expect(site?.replacement).toBe('`${API_BASE}/v1/payments`');
    expect(site?.strategy).toBe('url.template');
  });

  it('ignores a path that only looks similar', () => {
    expect(sites.some((site) => site.snippet.includes('charges_archive'))).toBe(false);
  });

  it('ignores a URL it cannot read', () => {
    expect(sites.some((site) => site.snippet === 'url')).toBe(false);
  });

  it('ignores an unrelated endpoint', () => {
    expect(sites.some((site) => site.snippet.includes('refunds'))).toBe(false);
  });

  it('matches an item path only against an item URL', () => {
    const itemRename = change({
      kind: 'path.renamed',
      path: '/v1/charges/{chargeId}',
      target: { location: 'path', from: '/v1/charges/{chargeId}', to: '/v1/payments/{chargeId}' },
    });

    const itemSites = scan(itemRename);
    expect(itemSites).toHaveLength(1);
    expect(itemSites[0]?.replacement).toBe('`${API_BASE}/v1/payments/${chargeId}`');
  });
});

describe('request field renames', () => {
  const fieldRename = change({
    kind: 'request.field.renamed',
    method: 'post',
    direction: 'request',
    target: { location: 'body', from: 'amount', to: 'amount_cents' },
  });

  const sites = scan(fieldRename);

  it('expands a shorthand property, since the local variable keeps its name', () => {
    const shorthand = sites.find((site) => site.replacement === 'amount_cents: amount');
    expect(shorthand).toBeDefined();
    expect(shorthand?.strategy).toBe('request.payload');
  });

  it('does not touch the payload of an unrelated endpoint', () => {
    const refundLine = 68;
    expect(linesOf(sites)).not.toContain(refundLine);
  });

  it('only fires on calls whose method matches', () => {
    const getOnly = change({
      kind: 'request.field.renamed',
      method: 'get',
      direction: 'request',
      target: { location: 'body', from: 'amount', to: 'amount_cents' },
    });

    expect(scan(getOnly)).toHaveLength(0);
  });
});

describe('response field renames', () => {
  const responseRename = change({
    kind: 'response.field.renamed',
    method: 'get',
    direction: 'response',
    path: '/v1/charges/{chargeId}',
    target: { location: 'response', from: 'amount', to: 'amount_cents' },
  });

  const sites = scan(responseRename);

  it('renames the property on the declared interface', () => {
    const declaration = sites.find((site) => site.strategy === 'response.type');
    expect(declaration).toBeDefined();
    expect(declaration?.replacement).toBe('amount_cents');
    expect(declaration?.confidence).toBe('high');
  });

  it('reaches a reader the call never flows into, through the type', () => {
    // describeCharge reads charge.amount, and never calls fetch itself.
    const readers = sites.filter((site) => site.strategy === 'response.member');
    expect(readers.length).toBeGreaterThanOrEqual(1);
    expect(readers.every((site) => site.replacement === 'amount_cents')).toBe(true);
  });

  it('does not rename an unrelated property of the same name', () => {
    expect(sites.every((site) => site.snippet === 'amount')).toBe(true);
  });
});

describe('review only changes', () => {
  it('anchors a new required parameter at the call, with no replacement', () => {
    const sites = scan(
      change({
        kind: 'param.added.required',
        method: 'post',
        direction: 'request',
        target: { location: 'header', to: 'Idempotency-Key' },
      }),
    );

    expect(sites.length).toBeGreaterThan(0);
    expect(sites.every((site) => site.replacement === undefined)).toBe(true);
    expect(sites.every((site) => site.codemod === undefined)).toBe(true);
  });

  it('anchors a response type change at the declared property', () => {
    const sites = scan(
      change({
        kind: 'response.field.type.changed',
        method: 'get',
        direction: 'response',
        path: '/v1/charges/{chargeId}',
        target: { location: 'response', from: 'currency', to: 'currency', fromType: 'string', toType: 'integer' },
      }),
    );

    expect(sites.some((site) => site.strategy === 'response.type' && site.snippet === 'currency')).toBe(true);
    expect(sites.every((site) => site.replacement === undefined)).toBe(true);
  });
});

describe('scan hygiene', () => {
  it('skips non breaking changes entirely', () => {
    expect(scan(change({ kind: 'operation.added', breaking: false }))).toHaveLength(0);
  });

  it('never returns two sites covering the same span for one change', () => {
    const sites = scan(pathRename);
    const keys = sites.map((site) => `${site.absoluteFile}:${site.start}:${site.end}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('reports repo relative paths', () => {
    expect(scan(pathRename).every((site) => site.file.startsWith('src/'))).toBe(true);
  });

  it('is deterministic across runs', () => {
    expect(scan(pathRename)).toEqual(scan(pathRename));
  });
});
