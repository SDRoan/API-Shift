/**
 * Turning scanned sites into proposed edits, and routing each one by confidence.
 *
 * The routing rule is the whole point of the project, so it lives in exactly one
 * place: `lowestConfidence` from src/confidence.ts, applied to three independent
 * signals. Only `high` is committed. Because a drafted edit is `low` by policy,
 * it can never reach `high`, which makes the split structural rather than a
 * check somebody has to remember to write.
 */

import { createHash } from 'node:crypto';
import type { ApiChange, Confidence, ProposedEdit } from '../types.js';
import { isAutoApplicable, lowestConfidence } from '../confidence.js';
import type { ScannedSite } from '../scanner/index.js';

export interface AgentPrPreview {
  title: string;
  branch: string;
  filesChanged: number;
  appliedCount: number;
  reviewCount: number;
  body: string;
}

/** A ProposedEdit whose site still carries the offsets needed to apply it. */
export interface PlannedEdit extends ProposedEdit {
  site: ScannedSite;
}

export interface AgentRun {
  sites: ScannedSite[];
  edits: PlannedEdit[];
  pr: AgentPrPreview;
}

/**
 * How much the edit strategy itself can be trusted.
 *
 * A deterministic codemod is high by construction, because it is a tested AST
 * transform. Anything else is low, including every drafted suggestion.
 */
function strategyConfidence(site: ScannedSite): Confidence {
  return site.codemod !== undefined ? 'high' : 'low';
}

function changeById(changes: ApiChange[]): Map<string, ApiChange> {
  return new Map(changes.map((change) => [change.id, change]));
}

/**
 * Branch name, derived from the changes rather than only the date.
 *
 * A date alone collides the second time you run in one day, which fails with an
 * opaque "Reference already exists" from the API. Deriving a short digest from
 * the change ids means the same spec bump always maps to the same branch, so a
 * repeat run is recognisably a repeat rather than a new mystery branch.
 */
export function branchNameFor(changes: ApiChange[]): string {
  const digest = createHash('sha1')
    .update([...changes.map((change) => change.id)].sort().join('|'))
    .digest('hex')
    .slice(0, 7);

  // No date. The same spec bump should always resolve to the same branch, so a
  // repeat run is recognised as a repeat and the dashboard can correlate a run
  // with the pull request it produced.
  return `apishift/update-${digest}`;
}

export function planApiUpdate(changes: ApiChange[], sites: ScannedSite[]): AgentRun {
  const changesById = changeById(changes);

  const edits = sites.map((site): PlannedEdit => {
    const change = changesById.get(site.changeId);
    const confidence = lowestConfidence(
      change?.confidence ?? 'low',
      site.confidence,
      strategyConfidence(site),
    );

    return {
      changeId: site.changeId,
      site,
      strategy: site.codemod ?? 'review-note',
      confidence,
      action: isAutoApplicable(confidence) ? 'apply' : 'review',
      before: site.snippet,
      ...(site.replacement !== undefined ? { after: site.replacement } : {}),
      reasoning: site.reason,
    };
  });

  const applied = edits.filter((edit) => edit.action === 'apply');
  const review = edits.filter((edit) => edit.action === 'review');
  const filesChanged = new Set(applied.map((edit) => edit.site.file)).size;

  const body = [
    '## Spec change summary',
    '',
    `${changes.filter((change) => change.breaking).length} breaking changes across ${changes.length} total.`,
    `Found ${sites.length} affected locations in the codebase.`,
    '',
    '## Patched automatically (high confidence)',
    '',
    ...(applied.length === 0
      ? ['Nothing met the bar for an automatic edit.']
      : applied.map((edit) => `- \`${edit.site.file}:${edit.site.line}\` ${edit.before} -> ${edit.after ?? ''}`)),
    '',
    '## Needs human review (low confidence)',
    '',
    ...(review.length === 0
      ? ['Nothing left for review.']
      : review.map((edit) => `- [ ] \`${edit.site.file}:${edit.site.line}\` ${edit.reasoning}`)),
  ].join('\n');

  return {
    sites,
    edits,
    pr: {
      title: `Update API usage for ${changes.filter((change) => change.breaking).length} breaking changes`,
      branch: branchNameFor(changes),
      filesChanged,
      appliedCount: applied.length,
      reviewCount: review.length,
      body,
    },
  };
}
