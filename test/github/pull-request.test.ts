/**
 * The GitHub flow against a fake Octokit. Asserts the call sequence and the
 * payloads, because the ordering is the part that matters: a tree built on the
 * wrong base, or a ref created before the commit, produces a broken branch.
 *
 * No test here touches the network.
 */

import { describe, expect, it } from 'vitest';
import type { GitHubConfig } from '../../src/github/config.js';
import { MissingConfigError, hasGitHubConfig, loadGitHubConfig } from '../../src/github/config.js';
import {
  BranchExistsError,
  NoChangesError,
  findApishiftPullRequests,
  openPullRequest,
  type GitHubApi,
} from '../../src/github/index.js';
import { branchNameFor } from '../../src/fixer/index.js';
import { makeChange } from '../../src/differ/changes.js';

const config: GitHubConfig = {
  token: 'test-token',
  owner: 'acme',
  repo: 'consumer-app',
  baseBranch: 'main',
};

interface Recorded {
  calls: string[];
  createdTree?: unknown;
  createdCommit?: unknown;
  createdRef?: unknown;
  createdPull?: unknown;
  blobContents: string[];
}

function fakeGitHub(): { api: GitHubApi; recorded: Recorded } {
  const recorded: Recorded = { calls: [], blobContents: [] };

  const api: GitHubApi = {
    git: {
      getRef: async (params) => {
        recorded.calls.push(`getRef:${params.ref}`);
        return { data: { object: { sha: 'base-sha' } } };
      },
      getCommit: async (params) => {
        recorded.calls.push(`getCommit:${params.commit_sha}`);
        return { data: { tree: { sha: 'base-tree-sha' } } };
      },
      createBlob: async (params) => {
        recorded.calls.push('createBlob');
        recorded.blobContents.push(Buffer.from(params.content, 'base64').toString('utf8'));
        return { data: { sha: `blob-${recorded.blobContents.length}` } };
      },
      createTree: async (params) => {
        recorded.calls.push('createTree');
        recorded.createdTree = params;
        return { data: { sha: 'tree-sha' } };
      },
      createCommit: async (params) => {
        recorded.calls.push('createCommit');
        recorded.createdCommit = params;
        return { data: { sha: 'commit-sha' } };
      },
      createRef: async (params) => {
        recorded.calls.push(`createRef:${params.ref}`);
        recorded.createdRef = params;
        return undefined;
      },
    },
    pulls: {
      list: async () => {
        recorded.calls.push('listPulls');
        return {
          data: [
            { number: 2, html_url: 'https://github.com/acme/consumer-app/pull/2', state: 'open', title: 'Update API usage', created_at: '2026-08-16T00:00:00Z', head: { ref: 'apishift/update-24bf69c' } },
            { number: 1, html_url: 'https://github.com/acme/consumer-app/pull/1', state: 'closed', title: 'Older run', created_at: '2026-08-15T00:00:00Z', head: { ref: 'apishift/update-aaaaaaa' } },
            { number: 3, html_url: 'https://github.com/acme/consumer-app/pull/3', state: 'open', title: 'Someone else', created_at: '2026-08-17T00:00:00Z', head: { ref: 'feature/unrelated' } },
          ],
        };
      },
      create: async (params) => {
        recorded.calls.push('createPull');
        recorded.createdPull = params;
        return { data: { html_url: 'https://github.com/acme/consumer-app/pull/7', number: 7 } };
      },
    },
  };

  return { api, recorded };
}

const input = {
  branch: 'apishift/update-2026-08-11',
  title: 'Update API usage',
  body: '## Spec change summary',
  commitMessage: 'fix: update API usage for renamed payments endpoints',
  files: [
    { path: 'src/payments.ts', contents: 'const a = 1;\n' },
    { path: 'src/client.ts', contents: 'const b = 2;\n' },
  ],
};

describe('openPullRequest', () => {
  it('builds the branch in an order that never leaves a partial ref', async () => {
    const { api, recorded } = fakeGitHub();
    await openPullRequest(api, config, input);

    expect(recorded.calls).toEqual([
      'getRef:heads/main',
      'getCommit:base-sha',
      'createBlob',
      'createBlob',
      'createTree',
      'createCommit',
      'createRef:refs/heads/apishift/update-2026-08-11',
      'createPull',
    ]);
  });

  it('commits every changed file in one commit', async () => {
    const { api, recorded } = fakeGitHub();
    await openPullRequest(api, config, input);

    expect(recorded.createdTree).toMatchObject({
      base_tree: 'base-tree-sha',
      tree: [
        { path: 'src/payments.ts', mode: '100644', type: 'blob', sha: 'blob-1' },
        { path: 'src/client.ts', mode: '100644', type: 'blob', sha: 'blob-2' },
      ],
    });
    expect(recorded.createdCommit).toMatchObject({ tree: 'tree-sha', parents: ['base-sha'] });
  });

  it('sends file contents intact through base64', async () => {
    const { api, recorded } = fakeGitHub();
    await openPullRequest(api, config, input);

    expect(recorded.blobContents).toEqual(['const a = 1;\n', 'const b = 2;\n']);
  });

  it('handles non ascii contents without corrupting them', async () => {
    const { api, recorded } = fakeGitHub();
    await openPullRequest(api, config, {
      ...input,
      files: [{ path: 'src/x.ts', contents: 'const label = "ok";\n' }],
    });

    expect(recorded.blobContents[0]).toBe('const label = "ok";\n');
  });

  it('opens the pull request against the configured base branch', async () => {
    const { api, recorded } = fakeGitHub();
    await openPullRequest(api, { ...config, baseBranch: 'develop' }, input);

    expect(recorded.createdPull).toMatchObject({
      base: 'develop',
      head: 'apishift/update-2026-08-11',
      title: 'Update API usage',
    });
  });

  it('returns the pull request url and number', async () => {
    const { api } = fakeGitHub();
    const result = await openPullRequest(api, config, input);

    expect(result).toEqual({
      url: 'https://github.com/acme/consumer-app/pull/7',
      number: 7,
      branch: 'apishift/update-2026-08-11',
      commitSha: 'commit-sha',
    });
  });

  it('explains a branch collision instead of surfacing a raw API error', async () => {
    const { api } = fakeGitHub();
    api.git.createRef = async (): Promise<unknown> => {
      throw new Error('Reference already exists');
    };

    await expect(openPullRequest(api, config, input)).rejects.toBeInstanceOf(BranchExistsError);
    await expect(openPullRequest(api, config, input)).rejects.toThrow(/already pushed/);
  });

  it('does not swallow an unrelated API failure', async () => {
    const { api } = fakeGitHub();
    api.git.createRef = async (): Promise<unknown> => {
      throw new Error('Bad credentials');
    };

    await expect(openPullRequest(api, config, input)).rejects.toThrow(/Bad credentials/);
  });

  it('refuses to open an empty pull request', async () => {
    const { api, recorded } = fakeGitHub();

    await expect(openPullRequest(api, config, { ...input, files: [] })).rejects.toBeInstanceOf(NoChangesError);
    expect(recorded.calls).toEqual([]);
  });
});

describe('findApishiftPullRequests', () => {
  it('returns only pull requests APIShift opened, newest first', async () => {
    const { api } = fakeGitHub();
    const found = await findApishiftPullRequests(api, config);

    expect(found.map((pull) => pull.number)).toEqual([2, 1]);
    expect(found[0]).toMatchObject({
      url: 'https://github.com/acme/consumer-app/pull/2',
      state: 'open',
      branch: 'apishift/update-24bf69c',
    });
  });

  it('ignores branches it did not create', async () => {
    const { api } = fakeGitHub();
    const found = await findApishiftPullRequests(api, config);

    expect(found.some((pull) => pull.branch === 'feature/unrelated')).toBe(false);
  });
});

describe('branchNameFor', () => {
  const changes = [
    makeChange({ kind: 'path.renamed', breaking: true, confidence: 'high', path: '/v1/charges', detail: 'x' }),
  ];

  it('is stable for the same change set, so a repeat run is recognisable', () => {
    expect(branchNameFor(changes)).toBe(branchNameFor(changes));
  });

  it('carries no date, so running tomorrow does not open a second pull request', () => {
    expect(branchNameFor(changes)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(branchNameFor(changes)).toMatch(/^apishift\/update-[0-9a-f]{7}$/);
  });

  it('differs when the changes differ', () => {
    const other = [
      makeChange({ kind: 'operation.removed', breaking: true, confidence: 'high', path: '/v1/refunds', detail: 'y' }),
    ];
    expect(branchNameFor(changes)).not.toBe(branchNameFor(other));
  });
});

describe('loadGitHubConfig', () => {
  const complete = {
    GITHUB_TOKEN: 'token',
    GITHUB_OWNER: 'acme',
    GITHUB_REPO: 'consumer-app',
  };

  it('reads a complete environment', () => {
    expect(loadGitHubConfig({ ...complete, GITHUB_BASE_BRANCH: 'develop' })).toEqual({
      token: 'token',
      owner: 'acme',
      repo: 'consumer-app',
      baseBranch: 'develop',
    });
  });

  it('defaults the base branch to main', () => {
    expect(loadGitHubConfig(complete).baseBranch).toBe('main');
  });

  it('names every missing variable at once', () => {
    let message = '';
    try {
      loadGitHubConfig({});
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : '';
      expect(error).toBeInstanceOf(MissingConfigError);
    }

    expect(message).toContain('GITHUB_TOKEN');
    expect(message).toContain('GITHUB_OWNER');
    expect(message).toContain('GITHUB_REPO');
  });

  it('treats blank values as missing', () => {
    expect(() => loadGitHubConfig({ ...complete, GITHUB_TOKEN: '   ' })).toThrow(MissingConfigError);
  });

  it('reports availability without throwing', () => {
    expect(hasGitHubConfig(complete)).toBe(true);
    expect(hasGitHubConfig({})).toBe(false);
  });
});
