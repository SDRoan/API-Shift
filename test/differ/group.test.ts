/**
 * Grouping changes that share one underlying edit.
 *
 * Nothing may be discarded here. The scanner needs every per endpoint record to
 * find call sites, so this is a view over the same data, not a filter.
 */

import { describe, expect, it } from 'vitest';
import { makeChange } from '../../src/differ/changes.js';
import { endpointLabel, groupChanges, groupingSummary } from '../../src/differ/group.js';
import type { ApiChange } from '../../src/types.js';

const enumAdded = (path: string, pointer: string): ApiChange =>
  makeChange({
    kind: 'enum.value.added',
    breaking: true,
    confidence: 'high',
    direction: 'response',
    path,
    method: 'get',
    target: { location: 'response', from: pointer, to: pointer },
    detail: `${pointer} can now return taxonomy`,
  });

describe('groupChanges', () => {
  it('collapses one shared schema edit reported across many endpoints', () => {
    // Box added a single enum value to a reused fields[].type and it appeared
    // on seven endpoints.
    const changes = [
      enumAdded('/metadata_templates', 'entries[].fields[].type'),
      enumAdded('/metadata_templates/enterprise', 'fields[].type'),
      enumAdded('/metadata_templates/global', 'fields[].type'),
    ];

    const groups = groupChanges(changes);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.endpoints).toHaveLength(3);
    expect(groups[0]?.changes).toHaveLength(3);
  });

  it('matches the same field at different depths, since the wrapper differs per endpoint', () => {
    const groups = groupChanges([
      enumAdded('/a', 'fields[].type'),
      enumAdded('/b', 'entries[].fields[].type'),
    ]);

    expect(groups).toHaveLength(1);
  });

  it('keeps genuinely different changes apart', () => {
    const groups = groupChanges([
      enumAdded('/a', 'fields[].type'),
      makeChange({
        kind: 'enum.value.added',
        breaking: true,
        confidence: 'high',
        direction: 'response',
        path: '/b',
        method: 'get',
        target: { location: 'response', from: 'status', to: 'status' },
        detail: 'status can now return error',
      }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it('does not merge a breaking change with a safe one', () => {
    const breaking = enumAdded('/a', 'fields[].type');
    const safe = { ...breaking, breaking: false };

    expect(groupChanges([breaking, safe])).toHaveLength(2);
  });

  it('does not merge across direction', () => {
    const response = enumAdded('/a', 'type');
    const request: ApiChange = { ...response, direction: 'request' };

    expect(groupChanges([response, request])).toHaveLength(2);
  });

  it('loses nothing, so every input change is still reachable', () => {
    const changes = [
      enumAdded('/a', 'fields[].type'),
      enumAdded('/b', 'fields[].type'),
      enumAdded('/c', 'status'),
    ];

    const total = groupChanges(changes).reduce((sum, group) => sum + group.changes.length, 0);
    expect(total).toBe(changes.length);
  });

  it('does not list the same endpoint twice within a group', () => {
    const groups = groupChanges([enumAdded('/a', 'fields[].type'), enumAdded('/a', 'fields[].type')]);
    expect(groups[0]?.endpoints).toEqual(['GET /a']);
  });

  it('preserves input order, so breaking changes still come first', () => {
    const safe = { ...enumAdded('/z', 'status'), breaking: false };
    const groups = groupChanges([enumAdded('/a', 'fields[].type'), safe]);

    expect(groups[0]?.representative.breaking).toBe(true);
  });

  it('handles an empty diff', () => {
    expect(groupChanges([])).toEqual([]);
  });
});

describe('endpointLabel', () => {
  it('includes the method when there is one', () => {
    expect(endpointLabel(enumAdded('/v1/charges', 'amount'))).toBe('GET /v1/charges');
  });

  it('falls back to the path for a change that spans methods', () => {
    const change = makeChange({
      kind: 'path.renamed',
      breaking: true,
      confidence: 'high',
      path: '/v1/charges',
      detail: 'renamed',
    });

    expect(endpointLabel(change)).toBe('/v1/charges');
  });
});

describe('groupingSummary', () => {
  it('reports how much shorter the grouped view is', () => {
    const changes = [enumAdded('/a', 'fields[].type'), enumAdded('/b', 'fields[].type')];
    expect(groupingSummary(changes)).toEqual({ groups: 1, total: 2 });
  });
});
