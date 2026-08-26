/**
 * Scanner configuration.
 *
 * A typo here would otherwise degrade into finding nothing, which reads exactly
 * like "your code is fine". So the parser validates rather than trusts.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { EMPTY_CONFIG, ScannerConfigError, loadScannerConfig, parseScannerConfig } from '../../src/scanner/config.js';
import { scanProject } from '../../src/scanner/index.js';
import { makeChange } from '../../src/differ/changes.js';

const WRAPPED = fileURLToPath(new URL('../fixtures/wrapped', import.meta.url));
const PLAIN = fileURLToPath(new URL('../fixtures/consumer', import.meta.url));

describe('parseScannerConfig', () => {
  it('reads a wrapper declaration', () => {
    const config = parseScannerConfig(
      { baseUrl: 'https://api.acme.test', requestFunctions: [{ name: 'request', methodArgument: 0, urlArgument: 1, bodyArgument: 2 }] },
      'test',
    );

    expect(config.baseUrl).toBe('https://api.acme.test');
    expect(config.requestFunctions[0]).toEqual({
      name: 'request',
      urlArgument: 1,
      bodyArgument: 2,
      methodArgument: 0,
    });
  });

  it('defaults to no wrappers, since the file is optional', () => {
    expect(parseScannerConfig({}, 'test').requestFunctions).toEqual([]);
  });

  it('rejects a config that is not an object', () => {
    expect(() => parseScannerConfig([], 'test')).toThrow(ScannerConfigError);
  });

  it('rejects a wrapper with no name', () => {
    expect(() => parseScannerConfig({ requestFunctions: [{ urlArgument: 0 }] }, 'test')).toThrow(/name/);
  });

  it('rejects a url argument that is not an index', () => {
    expect(() => parseScannerConfig({ requestFunctions: [{ name: 'x', urlArgument: -1 }] }, 'test')).toThrow(/urlArgument/);
    expect(() => parseScannerConfig({ requestFunctions: [{ name: 'x', urlArgument: 'first' }] }, 'test')).toThrow(/urlArgument/);
  });

  it('rejects a baseUrl that is not a string', () => {
    expect(() => parseScannerConfig({ baseUrl: 42 }, 'test')).toThrow(/baseUrl/);
  });
});

describe('loadScannerConfig', () => {
  it('reads the file from a repo root', () => {
    expect(loadScannerConfig(WRAPPED).requestFunctions).toHaveLength(1);
  });

  it('treats an absent file as defaults rather than an error', () => {
    expect(loadScannerConfig(PLAIN)).toEqual(EMPTY_CONFIG);
  });
});

describe('scanning a wrapped client', () => {
  const pathRename = makeChange({
    kind: 'path.renamed',
    breaking: true,
    confidence: 'high',
    path: '/v1/charges',
    target: { location: 'path', from: '/v1/charges', to: '/v1/payments' },
    detail: 'renamed',
  });

  it('finds a call through a declared wrapper', () => {
    // The path sits in the second argument of a function APIShift has never
    // heard of, so nothing matches without the config.
    const sites = scanProject(WRAPPED, [pathRename]).sites;

    expect(sites.length).toBeGreaterThan(0);
    expect(sites.some((site) => site.replacement === `'/v1/payments'`)).toBe(true);
  });

  it('renames the payload field through the wrapper body argument', () => {
    const fieldRename = makeChange({
      kind: 'request.field.renamed',
      breaking: true,
      confidence: 'high',
      path: '/v1/charges',
      method: 'post',
      direction: 'request',
      target: { location: 'body', from: 'amount', to: 'amount_cents' },
      detail: 'renamed',
    });

    const sites = scanProject(WRAPPED, [fieldRename]).sites;
    expect(sites.some((site) => site.replacement === 'amount_cents: amount')).toBe(true);
  });

  it('reaches the response type through a returned wrapper', () => {
    // `return request(...)` binds nothing, but Promise<Charge> still names the
    // payload, which is all a rename needs.
    const responseRename = makeChange({
      kind: 'response.field.renamed',
      breaking: true,
      confidence: 'high',
      path: '/v1/charges/{chargeId}',
      method: 'get',
      direction: 'response',
      target: { location: 'response', from: 'amount', to: 'amount_cents' },
      detail: 'renamed',
    });

    const sites = scanProject(WRAPPED, [responseRename]).sites;
    expect(sites.some((site) => site.strategy === 'response.type')).toBe(true);
    expect(sites.every((site) => site.replacement === 'amount_cents')).toBe(true);
  });

  it('does not report the same source span twice for two changes', () => {
    // Two endpoints sharing a response type land on the same property.
    const currency = (path: string): ReturnType<typeof makeChange> =>
      makeChange({
        kind: 'response.field.type.changed',
        breaking: true,
        confidence: 'high',
        path,
        method: 'get',
        direction: 'response',
        target: { location: 'response', from: 'currency', to: 'currency', fromType: 'string', toType: 'integer' },
        detail: 'response field currency changed from string to integer',
      });

    const sites = scanProject(WRAPPED, [currency('/v1/charges'), currency('/v1/charges/{chargeId}')]).sites;
    const spans = sites.map((site) => `${site.absoluteFile}:${site.start}`);

    expect(new Set(spans).size).toBe(spans.length);
  });
});
