/**
 * Edit application. Pure, so it is tested against in memory file contents with
 * no repo and no filesystem.
 */

import { describe, expect, it } from 'vitest';
import type { Confidence } from '../../src/types.js';
import type { ScannedSite } from '../../src/scanner/index.js';
import type { PlannedEdit } from '../../src/fixer/index.js';
import { applyEdits } from '../../src/fixer/apply.js';

const FILE = '/repo/src/payments.ts';

function site(start: number, end: number, text: string, overrides: Partial<ScannedSite> = {}): ScannedSite {
  return {
    changeId: 'c1',
    file: 'src/payments.ts',
    absoluteFile: FILE,
    line: 1,
    column: start + 1,
    start,
    end,
    text,
    strategy: 'url.literal',
    confidence: 'high',
    snippet: text,
    reason: 'test',
    ...overrides,
  };
}

function edit(
  scanned: ScannedSite,
  after: string | undefined,
  confidence: Confidence = 'high',
  codemod: string | undefined = 'rename-path',
): PlannedEdit {
  return {
    changeId: scanned.changeId,
    site: scanned,
    strategy: codemod ?? 'review-note',
    confidence,
    action: confidence === 'high' && after !== undefined ? 'apply' : 'review',
    before: scanned.text,
    ...(after !== undefined ? { after } : {}),
    reasoning: 'test',
  };
}

const source = `fetch('/v1/charges', { body: amount });`;
const reader = (): string => source;

describe('applyEdits', () => {
  it('applies a single edit', () => {
    const target = site(6, 19, `'/v1/charges'`);
    const result = applyEdits([edit(target, `'/v1/payments'`)], reader);

    expect(result.files.get(FILE)).toBe(`fetch('/v1/payments', { body: amount });`);
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('applies several edits in one file without corrupting offsets', () => {
    const url = site(6, 19, `'/v1/charges'`);
    const field = site(29, 35, 'amount', { changeId: 'c2' });

    const result = applyEdits(
      [edit(url, `'/v1/payments'`), edit(field, 'amount_cents', 'high', 'rename-request-field')],
      reader,
    );

    // The later edit is applied first, so the earlier offsets stay valid.
    expect(result.files.get(FILE)).toBe(`fetch('/v1/payments', { body: amount_cents });`);
    expect(result.applied).toHaveLength(2);
  });

  it('never applies a review edit', () => {
    const target = site(6, 19, `'/v1/charges'`);
    const result = applyEdits([edit(target, `'/v1/payments'`, 'low', undefined)], reader);

    expect(result.files.size).toBe(0);
    expect(result.skipped[0]?.reason).toBe('needs human review');
  });

  it('never applies a medium confidence edit, even with replacement text', () => {
    const target = site(6, 19, `'/v1/charges'`);
    const result = applyEdits([edit(target, `'/v1/payments'`, 'medium')], reader);

    expect(result.files.size).toBe(0);
    expect(result.skipped).toHaveLength(1);
  });

  it('skips an edit marked apply that carries no replacement text', () => {
    const target = site(6, 19, `'/v1/charges'`);
    // An inconsistent edit, which this guard exists to catch.
    const malformed: PlannedEdit = { ...edit(target, undefined), action: 'apply' };

    const result = applyEdits([malformed], reader);
    expect(result.skipped[0]?.reason).toBe('no replacement text');
  });

  it('drops both edits when two overlap, rather than picking a winner', () => {
    const outer = site(6, 19, `'/v1/charges'`);
    const inner = site(7, 18, '/v1/charges', { changeId: 'c2' });

    const result = applyEdits([edit(outer, `'/v1/payments'`), edit(inner, '/v1/refunds')], reader);

    expect(result.files.size).toBe(0);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every((entry) => entry.reason.includes('overlaps'))).toBe(true);
  });

  it('allows two adjacent edits that merely touch', () => {
    const first = site(0, 5, 'fetch');
    const second = site(5, 6, '(', { changeId: 'c2' });

    const result = applyEdits([edit(first, 'request'), edit(second, '(')], reader);
    expect(result.applied).toHaveLength(2);
  });

  it('refuses to splice when the source moved underneath it', () => {
    const stale = site(6, 19, `'/v1/refunds'`);
    const result = applyEdits([edit(stale, `'/v1/payments'`)], reader);

    expect(result.files.size).toBe(0);
    expect(result.skipped[0]?.reason).toContain('source no longer matches');
  });

  it('reports no file when an edit changes nothing', () => {
    const target = site(6, 19, `'/v1/charges'`);
    const result = applyEdits([edit(target, `'/v1/charges'`)], reader);

    expect(result.files.size).toBe(0);
  });

  it('separates edits across files', () => {
    const other = '/repo/src/other.ts';
    const a = site(6, 19, `'/v1/charges'`);
    const b = site(6, 19, `'/v1/charges'`, { absoluteFile: other, file: 'src/other.ts', changeId: 'c2' });

    const result = applyEdits([edit(a, `'/v1/payments'`), edit(b, `'/v1/payments'`)], reader);

    expect([...result.files.keys()].sort()).toEqual([other, FILE].sort());
  });
});
