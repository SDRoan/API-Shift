/**
 * Reading a spec's raw text from a URL or a file.
 *
 * The differ parses specs through swagger-parser, which wants a path or a URL.
 * Tracking needs the raw bytes as well, so a later check can hash them and diff
 * against what was stored without asking the user for the old file.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SpecSource {
  source: string;
  text: string;
}

export class SpecFetchError extends Error {
  constructor(source: string, reason: string) {
    super(`failed to read spec from ${source}: ${reason}`);
    this.name = 'SpecFetchError';
  }
}

export function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/** Fetch or read a spec's raw text. */
export async function readSpecText(source: string): Promise<SpecSource> {
  if (!isUrl(source)) {
    try {
      return { source, text: await readFile(source, 'utf8') };
    } catch (error: unknown) {
      throw new SpecFetchError(source, error instanceof Error ? error.message : String(error));
    }
  }

  let response: Response;
  try {
    response = await fetch(source, { headers: { accept: 'application/json, application/yaml, text/plain' } });
  } catch (error: unknown) {
    throw new SpecFetchError(source, error instanceof Error ? error.message : String(error));
  }

  if (!response.ok) {
    throw new SpecFetchError(source, `HTTP ${response.status} ${response.statusText}`);
  }

  return { source, text: await response.text() };
}

/** JSON or YAML, guessed from the source name and then from the content itself. */
export function extensionFor(source: string, text: string): string {
  const lower = source.toLowerCase();
  if (lower.endsWith('.json')) return '.json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return '.yaml';
  return text.trimStart().startsWith('{') ? '.json' : '.yaml';
}

/**
 * Write stored spec text to a temp file so swagger-parser can read it.
 *
 * Parsing from a string would mean carrying a YAML parser of our own. Writing
 * the bytes back out and handing over a path reuses the parser we already have.
 */
export async function materializeSpec(text: string, label: string, source: string): Promise<string> {
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = join(tmpdir(), `apishift-${safeLabel}-${Date.now()}${extensionFor(source, text)}`);
  await writeFile(path, text, 'utf8');
  return path;
}
