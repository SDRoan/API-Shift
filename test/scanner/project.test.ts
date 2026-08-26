/**
 * Loading a scan target.
 *
 * These tests exist because of a specific failure found on real input: a repo
 * path that did not resolve scanned zero files and reported zero affected
 * locations, which reads as "your code is fine". An error is the only honest
 * answer when nothing was scanned.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ScanTargetError, loadProject } from '../../src/scanner/project.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/consumer', import.meta.url));
const SPECS = fileURLToPath(new URL('../fixtures/specs', import.meta.url));
const A_FILE = fileURLToPath(new URL('../fixtures/consumer/src/calls.ts', import.meta.url));

describe('loadProject', () => {
  it('loads a real repo', () => {
    const loaded = loadProject(FIXTURE);
    expect(loaded.sourceFiles.length).toBeGreaterThan(0);
    expect(loaded.root).toBe(FIXTURE);
  });

  it('refuses a path that does not exist, rather than reporting nothing found', () => {
    expect(() => loadProject('/nope/not/a/real/path')).toThrow(ScanTargetError);
    expect(() => loadProject('/nope/not/a/real/path')).toThrow(/does not exist/);
  });

  it('refuses a shell command pasted in as a path', () => {
    expect(() => loadProject('npm run apishift -- diff')).toThrow(ScanTargetError);
  });

  it('refuses a file where a directory was expected', () => {
    expect(() => loadProject(A_FILE)).toThrow(/not a directory/);
  });

  it('refuses a directory with no source files in it', () => {
    expect(() => loadProject(SPECS)).toThrow(/nothing could be scanned/);
  });
});
