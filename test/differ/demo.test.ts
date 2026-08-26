/**
 * The demo spec pair, asserted end to end. This is the scenario the pull request
 * demo is built around, so it is worth pinning: two mechanical changes that a
 * codemod will handle, and two ambiguous ones that will need a human.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { ApiChange } from '../../src/types.js';
import { diffSpecs, formatDiffReport } from '../../src/differ/index.js';

const specPath = (name: string): string =>
  fileURLToPath(new URL(`../../demo/specs/${name}`, import.meta.url));

const find = (changes: ApiChange[], kind: string, from: string): ApiChange | undefined =>
  changes.find((change) => change.kind === kind && change.target?.from === from);

describe('demo spec pair', () => {
  it('classifies the payments API move from 1.0.0 to 2.0.0', async () => {
    const diff = await diffSpecs(specPath('v1.yaml'), specPath('v2.yaml'));
    const { changes } = diff;

    expect(diff.oldVersion).toBe('1.0.0');
    expect(diff.newVersion).toBe('2.0.0');

    // Mechanical, and the reason a deterministic codemod exists.
    const pathRename = find(changes, 'path.renamed', '/v1/charges');
    expect(pathRename?.target?.to).toBe('/v1/payments');
    expect(pathRename?.confidence).toBe('high');
    expect(pathRename?.method).toBeUndefined();

    const requestRename = find(changes, 'request.field.renamed', 'amount');
    expect(requestRename?.target?.to).toBe('amount_cents');
    expect(requestRename?.confidence).toBe('high');

    const responseRename = find(changes, 'response.field.renamed', 'amount');
    expect(responseRename?.confidence).toBe('high');

    // Ambiguous, and the reason the LLM drafting path exists.
    const typeChange = find(changes, 'response.field.type.changed', 'currency');
    expect(typeChange?.target).toMatchObject({ fromType: 'string', toType: 'integer' });
    expect(typeChange?.breaking).toBe(true);

    const newHeader = changes.find((change) => change.kind === 'param.added.required');
    expect(newHeader?.target?.to).toBe('Idempotency-Key');

    // A response enum that gained a value breaks an exhaustive switch.
    const enumAdded = changes.find((change) => change.kind === 'enum.value.added');
    expect(enumAdded?.breaking).toBe(true);
    expect(enumAdded?.detail).toContain('refunded');
  });

  it('keeps the untouched endpoint out of the report', async () => {
    const { changes } = await diffSpecs(specPath('v1.yaml'), specPath('v2.yaml'));
    expect(changes.filter((change) => change.path === '/v1/refunds')).toEqual([]);
  });

  it('reports the new endpoint as non breaking', async () => {
    const { changes } = await diffSpecs(specPath('v1.yaml'), specPath('v2.yaml'));
    const added = changes.find((change) => change.kind === 'operation.added');

    expect(added?.path).toBe('/v1/payment_methods');
    expect(added?.breaking).toBe(false);
  });

  it('renders a report that leads with breaking changes', async () => {
    const diff = await diffSpecs(specPath('v1.yaml'), specPath('v2.yaml'));
    const report = formatDiffReport(diff);

    expect(report).toContain('/v1/charges -> /v1/payments');
    expect(report.indexOf('BREAKING')).toBeLessThan(report.indexOf('NON BREAKING'));
  });

  it('hides non breaking changes when asked', async () => {
    const diff = await diffSpecs(specPath('v1.yaml'), specPath('v2.yaml'));
    expect(formatDiffReport(diff, { breakingOnly: true })).not.toContain('NON BREAKING');
  });

  it('serializes to JSON and back without loss, which is what scan will read', async () => {
    const diff = await diffSpecs(specPath('v1.yaml'), specPath('v2.yaml'));
    expect(JSON.parse(JSON.stringify(diff))).toEqual(diff);
  });
});

describe('empty report', () => {
  it('says so plainly when nothing changed', async () => {
    const diff = await diffSpecs(specPath('v1.yaml'), specPath('v1.yaml'));
    expect(formatDiffReport(diff)).toContain('no differences found');
  });
});
