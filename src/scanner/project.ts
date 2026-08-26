/**
 * Loading a target repo into ts-morph.
 *
 * The scanner reads a codebase it does not own, so it has to cope with repos
 * that have a tsconfig, repos that do not, and repos whose tsconfig excludes the
 * files we care about. It never writes here. Applying edits is the fixer's job.
 */

import { existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Project, ScriptTarget } from 'ts-morph';
import type { SourceFile } from 'ts-morph';

/** Directories that never contain first party call sites. */
const SKIP_DIRS = ['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.apishift'];

const SOURCE_GLOBS = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'];

export interface LoadedProject {
  project: Project;
  root: string;
  sourceFiles: SourceFile[];
}

/**
 * Raised when the scan target is not something we can scan.
 *
 * This exists because the alternative is worse than an error. A repo path that
 * does not resolve would otherwise scan zero files and report zero affected
 * locations, which reads as "your code is fine" when nothing was ever looked at.
 * A silent false negative is the one result this tool must never produce.
 */
export class ScanTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanTargetError';
  }
}

function ignoreGlobs(): string[] {
  return SKIP_DIRS.map((dir) => `!**/${dir}/**`);
}

/**
 * Load a repo. A tsconfig gives better type information, which the response
 * member strategy uses, so it is preferred. Files outside the tsconfig are added
 * afterwards so a partial config does not silently hide call sites.
 */
export function loadProject(root: string): LoadedProject {
  if (!existsSync(root)) {
    throw new ScanTargetError(`codebase path does not exist: ${root}`);
  }
  if (!statSync(root).isDirectory()) {
    throw new ScanTargetError(`codebase path is not a directory: ${root}`);
  }

  const tsconfigPath = join(root, 'tsconfig.json');
  const hasTsconfig = existsSync(tsconfigPath);

  const project = hasTsconfig
    ? new Project({ tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: false })
    : new Project({
        compilerOptions: { allowJs: true, target: ScriptTarget.ESNext },
        useInMemoryFileSystem: false,
      });

  project.addSourceFilesAtPaths([...SOURCE_GLOBS.map((glob) => join(root, glob)), ...ignoreGlobs()]);

  const sourceFiles = project
    .getSourceFiles()
    .filter((file) => !relative(root, file.getFilePath()).startsWith('..'))
    .filter((file) => !SKIP_DIRS.some((dir) => file.getFilePath().includes(`/${dir}/`)));

  if (sourceFiles.length === 0) {
    throw new ScanTargetError(
      `no TypeScript or JavaScript files found under ${root}, so nothing could be scanned`,
    );
  }

  return { project, root, sourceFiles };
}

/** Repo relative path, which is what reports and pull request bodies show. */
export function relativePathOf(root: string, file: SourceFile): string {
  return relative(root, file.getFilePath());
}
