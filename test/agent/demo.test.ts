/**
 * The whole loop over the demo app, stopping short of the network.
 *
 * This is the scenario the pull request demo is built around, so it asserts the
 * contrast the demo is meant to show: mechanical changes become committed edits,
 * ambiguous ones become review items.
 */

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diffSpecs } from '../../src/differ/index.js';
import { planApiUpdate } from '../../src/fixer/index.js';
import { scanCodebase } from '../../src/scanner/index.js';
import type { ProposedEdit } from '../../src/types.js';

const specPath = (name: string): string => fileURLToPath(new URL(`../../demo/specs/${name}`, import.meta.url));
const demoRepo = (): string => fileURLToPath(new URL('../../demo/consumer-app', import.meta.url));

async function runDemo(): Promise<ReturnType<typeof planApiUpdate>> {
  const diff = await diffSpecs(specPath('v1.yaml'), specPath('v2.yaml'));
  const sites = await scanCodebase(demoRepo(), diff.changes);
  return planApiUpdate(diff.changes, sites);
}

const hasEdit = (edits: ProposedEdit[], before: string, after: string): boolean =>
  edits.some((edit) => edit.before === before && edit.after === after);

describe('API update agent demo', () => {
  it('commits the mechanical path rename', async () => {
    const { edits } = await runDemo();
    const applied = edits.filter((edit) => edit.action === 'apply');

    expect(hasEdit(applied, '`${API_BASE}/v1/charges`', '`${API_BASE}/v1/payments`')).toBe(true);
    expect(
      hasEdit(applied, '`${API_BASE}/v1/charges/${chargeId}`', '`${API_BASE}/v1/payments/${chargeId}`'),
    ).toBe(true);
  });

  it('expands the shorthand request field rather than corrupting it', async () => {
    const { edits } = await runDemo();
    const applied = edits.filter((edit) => edit.action === 'apply');

    expect(hasEdit(applied, 'amount', 'amount_cents: amount')).toBe(true);
  });

  it('renames the response field on the interface and at every reader', async () => {
    const { edits } = await runDemo();
    const renames = edits.filter((edit) => edit.strategy === 'rename-response-field');

    // The Charge interface, the read inside loadCharge, and the read inside
    // renderChargeBadge, which the call never flows into.
    expect(renames.length).toBeGreaterThanOrEqual(3);
    expect(renames.every((edit) => edit.action === 'apply')).toBe(true);
    expect(renames.some((edit) => edit.site.strategy === 'response.type')).toBe(true);
    expect(renames.some((edit) => edit.site.line === 37)).toBe(true);
  });

  it('leaves the ambiguous changes for a human, with no replacement text', async () => {
    const { edits } = await runDemo();
    const review = edits.filter((edit) => edit.action === 'review');

    // currency changed type, status gained an enum value, and a new required
    // header appeared. None of those have a safe mechanical fix.
    expect(review.some((edit) => edit.before === 'currency')).toBe(true);
    expect(review.some((edit) => edit.before === 'status')).toBe(true);
    expect(review.some((edit) => edit.reasoning.includes('Idempotency-Key'))).toBe(true);
    expect(review.every((edit) => edit.after === undefined)).toBe(true);
  });

  it('never routes a non codemod edit into the commit', async () => {
    const { edits } = await runDemo();

    for (const edit of edits) {
      if (edit.action === 'apply') expect(edit.strategy).not.toBe('review-note');
      if (edit.strategy === 'review-note') expect(edit.action).toBe('review');
    }
  });

  it('produces a PR body with both sections', async () => {
    const { pr } = await runDemo();

    expect(pr.filesChanged).toBe(1);
    expect(pr.appliedCount).toBeGreaterThan(0);
    expect(pr.reviewCount).toBeGreaterThan(0);
    expect(pr.body).toContain('## Patched automatically (high confidence)');
    expect(pr.body).toContain('## Needs human review (low confidence)');
  });
});
