/**
 * Branch, commit, and pull request creation.
 *
 * The commit is built with the Git Data API rather than a sequence of Contents
 * API calls, so every changed file lands in one atomic commit. A partially
 * written branch would be worse than no branch at all.
 *
 * The Octokit surface actually used is narrow, and it is declared here as an
 * interface so tests can pass a fake. No test opens a real pull request.
 */

import type { GitHubConfig } from './config.js';

export interface GitHubApi {
  git: {
    getRef: (params: { owner: string; repo: string; ref: string }) => Promise<{ data: { object: { sha: string } } }>;
    getCommit: (params: { owner: string; repo: string; commit_sha: string }) => Promise<{ data: { tree: { sha: string } } }>;
    createBlob: (params: { owner: string; repo: string; content: string; encoding: string }) => Promise<{ data: { sha: string } }>;
    createTree: (params: {
      owner: string;
      repo: string;
      base_tree: string;
      tree: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }>;
    }) => Promise<{ data: { sha: string } }>;
    createCommit: (params: {
      owner: string;
      repo: string;
      message: string;
      tree: string;
      parents: string[];
    }) => Promise<{ data: { sha: string } }>;
    createRef: (params: { owner: string; repo: string; ref: string; sha: string }) => Promise<unknown>;
  };
  pulls: {
    list: (params: {
      owner: string;
      repo: string;
      state: 'all';
      per_page: number;
    }) => Promise<{
      data: Array<{
        number: number;
        html_url: string;
        state: string;
        title: string;
        created_at: string;
        head: { ref: string };
      }>;
    }>;
    create: (params: {
      owner: string;
      repo: string;
      title: string;
      head: string;
      base: string;
      body: string;
    }) => Promise<{ data: { html_url: string; number: number } }>;
  };
}

export interface ChangedFile {
  /** Repo relative path, forward slashes, no leading slash. */
  path: string;
  contents: string;
}

export interface OpenPullRequestInput {
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
  files: ChangedFile[];
}

export interface OpenPullRequestResult {
  url: string;
  number: number;
  branch: string;
  commitSha: string;
}

export class NoChangesError extends Error {
  constructor() {
    super('nothing to commit, no high confidence edits were applied');
    this.name = 'NoChangesError';
  }
}

export class BranchExistsError extends Error {
  constructor(branch: string) {
    super(
      `branch ${branch} already exists, which means this exact set of changes was already pushed\n` +
        'delete the branch, or pass --branch to use a different name',
    );
    this.name = 'BranchExistsError';
  }
}

function isAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Reference already exists');
}

/**
 * Create a branch off the base, commit every changed file to it at once, and
 * open a pull request.
 */
export async function openPullRequest(
  api: GitHubApi,
  config: GitHubConfig,
  input: OpenPullRequestInput,
): Promise<OpenPullRequestResult> {
  if (input.files.length === 0) throw new NoChangesError();

  const { owner, repo, baseBranch } = config;

  const base = await api.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
  const baseSha = base.data.object.sha;

  const baseCommit = await api.git.getCommit({ owner, repo, commit_sha: baseSha });

  const blobs = await Promise.all(
    input.files.map(async (file) => {
      const blob = await api.git.createBlob({
        owner,
        repo,
        content: Buffer.from(file.contents, 'utf8').toString('base64'),
        encoding: 'base64',
      });
      return { path: file.path, mode: '100644' as const, type: 'blob' as const, sha: blob.data.sha };
    }),
  );

  const tree = await api.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.data.tree.sha,
    tree: blobs,
  });

  const commit = await api.git.createCommit({
    owner,
    repo,
    message: input.commitMessage,
    tree: tree.data.sha,
    parents: [baseSha],
  });

  try {
    await api.git.createRef({ owner, repo, ref: `refs/heads/${input.branch}`, sha: commit.data.sha });
  } catch (error: unknown) {
    if (isAlreadyExists(error)) throw new BranchExistsError(input.branch);
    throw error;
  }

  const pull = await api.pulls.create({
    owner,
    repo,
    title: input.title,
    head: input.branch,
    base: baseBranch,
    body: input.body,
  });

  return {
    url: pull.data.html_url,
    number: pull.data.number,
    branch: input.branch,
    commitSha: commit.data.sha,
  };
}

export interface ApishiftPullRequest {
  number: number;
  url: string;
  state: string;
  title: string;
  branch: string;
  createdAt: string;
}

/**
 * Every pull request APIShift has opened on this repo, newest first.
 *
 * Matched on the branch prefix rather than an exact name, so a run still finds
 * the pull requests produced by earlier runs even when the change set differs.
 */
export async function findApishiftPullRequests(
  api: GitHubApi,
  config: GitHubConfig,
): Promise<ApishiftPullRequest[]> {
  const { data } = await api.pulls.list({
    owner: config.owner,
    repo: config.repo,
    state: 'all',
    per_page: 50,
  });

  return data
    .filter((pull) => pull.head.ref.startsWith('apishift/'))
    .map((pull) => ({
      number: pull.number,
      url: pull.html_url,
      state: pull.state,
      title: pull.title,
      branch: pull.head.ref,
      createdAt: pull.created_at,
    }))
    .sort((a, b) => b.number - a.number);
}

/** A real Octokit client. Imported lazily so tests never load it. */
export async function createGitHubApi(config: GitHubConfig): Promise<GitHubApi> {
  const { Octokit } = await import('@octokit/rest');

  return new Octokit({
    auth: config.token,
    // Octokit logs failed requests itself, which duplicates the message we
    // already write. Keep errors, drop the rest unless debugging.
    log: {
      debug: (): void => {},
      info: (): void => {},
      warn: (message: string): void => {
        if (process.env['APISHIFT_DEBUG'] === '1') process.stderr.write(`${message}\n`);
      },
      error: (message: string): void => {
        if (process.env['APISHIFT_DEBUG'] === '1') process.stderr.write(`${message}\n`);
      },
    },
  }) as unknown as GitHubApi;
}
