/**
 * Contract level changes: base URL, authentication, deprecation, and media
 * types.
 *
 * These were blind spots. A vendor moving its host or adding an auth
 * requirement breaks every caller, and neither moves a path or a field, so a
 * purely schema focused diff reports nothing at all.
 */

import { describe, expect, it } from 'vitest';
import type { OpenAPIV3 } from 'openapi-types';
import { changesOf, doc, jsonBody, object, ofKind, onlyOfKind } from './helpers.js';

const ok = { '200': { description: 'ok' } };
const operation = { get: { operationId: 'listCharges', responses: ok } };

const withServers = (urls: string[]): OpenAPIV3.Document => ({
  ...doc({ '/v1/charges': operation }),
  servers: urls.map((url) => ({ url })),
});

describe('base URL', () => {
  it('flags the primary server moving, which is a total outage', async () => {
    const change = onlyOfKind(
      await changesOf(withServers(['https://api.acme.test']), withServers(['https://api.acme.dev'])),
      'server.url.changed',
    );

    expect(change.breaking).toBe(true);
    expect(change.target).toMatchObject({
      location: 'server',
      from: 'https://api.acme.test',
      to: 'https://api.acme.dev',
    });
  });

  it('flags a removed alternate server', async () => {
    const before = withServers(['https://api.acme.test', 'https://eu.acme.test']);
    const after = withServers(['https://api.acme.test']);

    expect(onlyOfKind(await changesOf(before, after), 'server.removed').breaking).toBe(true);
  });

  it('treats a new alternate server as safe', async () => {
    const before = withServers(['https://api.acme.test']);
    const after = withServers(['https://api.acme.test', 'https://eu.acme.test']);

    expect(onlyOfKind(await changesOf(before, after), 'server.added').breaking).toBe(false);
  });

  it('says nothing when the servers did not move', async () => {
    const spec = withServers(['https://api.acme.test']);
    expect(await changesOf(spec, spec)).toEqual([]);
  });
});

describe('authentication', () => {
  const withSecurity = (
    security: OpenAPIV3.SecurityRequirementObject[],
    schemes: Record<string, OpenAPIV3.SecuritySchemeObject>,
  ): OpenAPIV3.Document => ({
    ...doc({ '/v1/charges': operation }),
    security,
    components: { securitySchemes: schemes },
  });

  const apiKey: OpenAPIV3.SecuritySchemeObject = { type: 'apiKey', in: 'header', name: 'X-Api-Key' };
  const bearer: OpenAPIV3.SecuritySchemeObject = { type: 'http', scheme: 'bearer' };

  it('flags a new requirement, since existing callers are now rejected', async () => {
    const before = withSecurity([], { apiKey });
    const after = withSecurity([{ apiKey: [] }], { apiKey });

    const change = onlyOfKind(await changesOf(before, after), 'security.added');
    expect(change.breaking).toBe(true);
    expect(change.detail).toContain('existing callers will be rejected');
  });

  it('treats a dropped requirement as safe', async () => {
    const before = withSecurity([{ apiKey: [] }], { apiKey });
    const after = withSecurity([], { apiKey });

    expect(onlyOfKind(await changesOf(before, after), 'security.removed').breaking).toBe(false);
  });

  it('flags a scheme that changes how it authenticates', async () => {
    const before = withSecurity([{ auth: [] }], { auth: apiKey });
    const after = withSecurity([{ auth: [] }], { auth: bearer });

    const change = onlyOfKind(await changesOf(before, after), 'security.scheme.changed');
    expect(change.breaking).toBe(true);
    expect(change.target).toMatchObject({ fromType: 'apiKey in header named X-Api-Key', toType: 'http bearer' });
  });

  it('ignores a cosmetic edit that does not change how you authenticate', async () => {
    const before = withSecurity([{ auth: [] }], { auth: { ...apiKey, description: 'old wording' } });
    const after = withSecurity([{ auth: [] }], { auth: { ...apiKey, description: 'new wording' } });

    expect(await changesOf(before, after)).toEqual([]);
  });

  it('flags an operation that gains its own requirement', async () => {
    const before = doc({ '/v1/charges': { get: { operationId: 'listCharges', responses: ok } } });
    const after = doc({
      '/v1/charges': { get: { operationId: 'listCharges', security: [{ apiKey: [] }], responses: ok } },
    });

    expect(onlyOfKind(await changesOf(before, after), 'security.added').breaking).toBe(true);
  });
});

describe('deprecation', () => {
  it('reports a newly deprecated operation as a warning, not a break', async () => {
    const before = doc({ '/v1/charges': { get: { operationId: 'listCharges', responses: ok } } });
    const after = doc({
      '/v1/charges': { get: { operationId: 'listCharges', deprecated: true, responses: ok } },
    });

    const change = onlyOfKind(await changesOf(before, after), 'operation.deprecated');
    expect(change.breaking).toBe(false);
    expect(change.detail).toContain('deprecated');
  });

  it('does not repeat the warning once it is already deprecated', async () => {
    const spec = doc({
      '/v1/charges': { get: { operationId: 'listCharges', deprecated: true, responses: ok } },
    });

    expect(await changesOf(spec, spec)).toEqual([]);
  });
});

describe('media types', () => {
  const withContent = (types: string[]): OpenAPIV3.Document =>
    doc({
      '/v1/charges': {
        post: {
          operationId: 'createCharge',
          requestBody: {
            required: true,
            content: Object.fromEntries(
              types.map((type) => [type, { schema: object({ amount: { type: 'integer' } }) }]),
            ),
          },
          responses: ok,
        },
      },
    });

  it('flags losing a media type a caller may be using', async () => {
    const change = onlyOfKind(
      await changesOf(withContent(['application/json', 'application/xml']), withContent(['application/json'])),
      'content.type.removed',
    );

    expect(change.breaking).toBe(true);
    expect(change.target?.from).toBe('application/xml');
  });

  it('treats a newly accepted media type as safe', async () => {
    const change = onlyOfKind(
      await changesOf(withContent(['application/json']), withContent(['application/json', 'application/xml'])),
      'content.type.added',
    );

    expect(change.breaking).toBe(false);
  });

  it('diffs fields in a form encoded body rather than ignoring the operation', async () => {
    // Previously only JSON payloads were walked, so a form based API reported
    // no field changes at all.
    const form = (properties: Record<string, OpenAPIV3.SchemaObject>): OpenAPIV3.Document =>
      doc({
        '/v1/charges': {
          post: {
            operationId: 'createCharge',
            requestBody: {
              required: true,
              content: { 'application/x-www-form-urlencoded': { schema: object(properties) } },
            },
            responses: ok,
          },
        },
      });

    const change = onlyOfKind(
      await changesOf(form({ amount: { type: 'integer' } }), form({ amount_cents: { type: 'integer' } })),
      'request.field.renamed',
    );

    expect(change.target).toMatchObject({ from: 'amount', to: 'amount_cents' });
  });

  it('still prefers JSON when several media types are offered', async () => {
    const mixed = (jsonProps: Record<string, OpenAPIV3.SchemaObject>): OpenAPIV3.Document =>
      doc({
        '/v1/charges': {
          post: {
            operationId: 'createCharge',
            requestBody: {
              required: true,
              content: {
                'application/xml': { schema: object({ ignored: { type: 'string' } }) },
                'application/json': { schema: object(jsonProps) },
              },
            },
            responses: ok,
          },
        },
      });

    const changes = await changesOf(mixed({ amount: { type: 'integer' } }), mixed({ amount: { type: 'string' } }));
    expect(ofKind(changes, 'request.field.type.changed')).toHaveLength(1);
  });
});

describe('union members', () => {
  it('says which member appeared instead of just that the count moved', async () => {
    const union = (members: OpenAPIV3.SchemaObject[]): OpenAPIV3.Document =>
      doc({
        '/v1/charges': {
          post: {
            operationId: 'createCharge',
            requestBody: jsonBody(object({ source: { oneOf: members } })),
            responses: ok,
          },
        },
      });

    const change = onlyOfKind(
      await changesOf(
        union([{ type: 'string' }, { type: 'integer' }]),
        union([{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }]),
      ),
      'request.field.type.changed',
    );

    expect(change.target?.fromType).toBe('oneOf<2: integer|string>');
    expect(change.target?.toType).toBe('oneOf<3: boolean|integer|string>');
  });
});
