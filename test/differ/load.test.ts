import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { SpecLoadError, loadSpec } from '../../src/differ/load.js';

const demoSpec = (name: string): string =>
  fileURLToPath(new URL(`../../demo/specs/${name}`, import.meta.url));

describe('loadSpec', () => {
  it('reads a YAML spec from disk', async () => {
    const spec = await loadSpec(demoSpec('v1.yaml'));

    expect(spec.title).toBe('Acme Payments API');
    expect(spec.version).toBe('1.0.0');
    expect(Object.keys(spec.document.paths)).toContain('/v1/charges');
  });

  it('dereferences $ref so the diff never has to chase one', async () => {
    const spec = await loadSpec(demoSpec('v1.yaml'));
    const schema = spec.document.paths['/v1/charges/{chargeId}']?.get?.responses['200'];

    expect(JSON.stringify(schema)).not.toContain('$ref');
    expect(JSON.stringify(schema)).toContain('currency');
  });

  it('accepts an already parsed document, which is what tests use', async () => {
    const spec = await loadSpec({
      openapi: '3.0.3',
      info: { title: 'Inline', version: '9.9.9' },
      paths: {},
    });

    expect(spec.source).toBe('inline document');
    expect(spec.version).toBe('9.9.9');
  });

  it('does not mutate a document it was handed', async () => {
    const document = {
      openapi: '3.0.3',
      info: { title: 'Inline', version: '1.0.0' },
      paths: {},
    };
    const snapshot = JSON.stringify(document);

    await loadSpec(document);
    expect(JSON.stringify(document)).toBe(snapshot);
  });

  it('rejects Swagger 2.0 with a clear message', async () => {
    await expect(
      loadSpec({ swagger: '2.0', info: { title: 'Old', version: '1.0.0' }, paths: {} } as never),
    ).rejects.toThrow(/only OpenAPI 3/);
  });

  it('wraps a missing file in SpecLoadError', async () => {
    await expect(loadSpec('./does-not-exist.yaml')).rejects.toBeInstanceOf(SpecLoadError);
  });
});
