/**
 * GitHub configuration, read from the environment and nowhere else.
 *
 * No token, owner, or repo name ever appears in source. This loader is the one
 * place that reads them, and it fails fast with a message naming the missing
 * variable rather than surfacing a confusing 401 later.
 */

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
}

export class MissingConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `missing required environment ${missing.length === 1 ? 'variable' : 'variables'}: ${missing.join(', ')}\n` +
        'copy .env.example to .env and fill it in, then pass --env-file=.env',
    );
    this.name = 'MissingConfigError';
  }
}

type Environment = Record<string, string | undefined>;

/** Read and validate GitHub settings. Throws when anything required is absent. */
export function loadGitHubConfig(environment: Environment = process.env): GitHubConfig {
  const token = environment['GITHUB_TOKEN']?.trim() ?? '';
  const owner = environment['GITHUB_OWNER']?.trim() ?? '';
  const repo = environment['GITHUB_REPO']?.trim() ?? '';
  const baseBranch = environment['GITHUB_BASE_BRANCH']?.trim();

  const missing: string[] = [];
  if (token.length === 0) missing.push('GITHUB_TOKEN');
  if (owner.length === 0) missing.push('GITHUB_OWNER');
  if (repo.length === 0) missing.push('GITHUB_REPO');
  if (missing.length > 0) throw new MissingConfigError(missing);

  return {
    token,
    owner,
    repo,
    baseBranch: baseBranch !== undefined && baseBranch.length > 0 ? baseBranch : 'main',
  };
}

/** True when a pull request could be opened, without throwing. Used by the CLI to explain a dry run. */
export function hasGitHubConfig(environment: Environment = process.env): boolean {
  try {
    loadGitHubConfig(environment);
    return true;
  } catch {
    return false;
  }
}
