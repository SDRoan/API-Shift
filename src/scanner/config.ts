/**
 * Per repo scanner configuration.
 *
 * The built in detection understands `fetch` and `axios`, which covers code
 * that calls an API directly. Most real codebases do not: they wrap it once and
 * call the wrapper everywhere.
 *
 *   // src/api.ts
 *   export const api = {
 *     createCharge: (body) => request('POST', '/v1/charges', body),
 *   };
 *
 * The path is right there in the source, but it is the second argument of a
 * function APIShift has never heard of, so nothing matches and the scan
 * silently finds nothing. That is the single biggest reason this would report
 * zero on a stranger's repo.
 *
 * An `apishift.json` at the repo root fixes that by naming the wrapper and
 * saying which argument holds the URL. Everything else keeps working as before,
 * so the file is optional.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RequestFunctionConfig {
  /** Callee text to match, for example "request" or "http.send". */
  name: string;
  /** Zero based index of the argument holding the URL. */
  urlArgument: number;
  /** Argument holding the request payload, when there is one. */
  bodyArgument?: number | undefined;
  /** Argument holding the HTTP method as a string literal, when there is one. */
  methodArgument?: number | undefined;
}

export interface ScannerConfig {
  /** Stripped from URLs before matching, for a client that stores it separately. */
  baseUrl?: string | undefined;
  requestFunctions: RequestFunctionConfig[];
}

export const EMPTY_CONFIG: ScannerConfig = { requestFunctions: [] };

export const CONFIG_FILENAME = 'apishift.json';

export class ScannerConfigError extends Error {
  constructor(path: string, reason: string) {
    super(`invalid ${CONFIG_FILENAME} at ${path}: ${reason}`);
    this.name = 'ScannerConfigError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate rather than trust. A typo in the config would otherwise degrade into
 * finding nothing, which reads exactly like "your code is fine".
 */
export function parseScannerConfig(raw: unknown, path: string): ScannerConfig {
  if (!isRecord(raw)) throw new ScannerConfigError(path, 'expected a JSON object');

  const baseUrl = raw['baseUrl'];
  if (baseUrl !== undefined && typeof baseUrl !== 'string') {
    throw new ScannerConfigError(path, 'baseUrl must be a string');
  }

  const declared = raw['requestFunctions'] ?? [];
  if (!Array.isArray(declared)) {
    throw new ScannerConfigError(path, 'requestFunctions must be an array');
  }

  const requestFunctions = declared.map((entry, index): RequestFunctionConfig => {
    const where = `requestFunctions[${index}]`;
    if (!isRecord(entry)) throw new ScannerConfigError(path, `${where} must be an object`);

    const name = entry['name'];
    if (typeof name !== 'string' || name.length === 0) {
      throw new ScannerConfigError(path, `${where}.name must be a non empty string`);
    }

    const urlArgument = entry['urlArgument'];
    if (typeof urlArgument !== 'number' || !Number.isInteger(urlArgument) || urlArgument < 0) {
      throw new ScannerConfigError(path, `${where}.urlArgument must be a non negative integer`);
    }

    const optionalIndex = (key: string): number | undefined => {
      const value = entry[key];
      if (value === undefined) return undefined;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new ScannerConfigError(path, `${where}.${key} must be a non negative integer`);
      }
      return value;
    };

    return {
      name,
      urlArgument,
      bodyArgument: optionalIndex('bodyArgument'),
      methodArgument: optionalIndex('methodArgument'),
    };
  });

  return {
    ...(typeof baseUrl === 'string' ? { baseUrl } : {}),
    requestFunctions,
  };
}

/** Read apishift.json from a repo root. Absent is normal and means defaults. */
export function loadScannerConfig(root: string): ScannerConfig {
  const path = join(root, CONFIG_FILENAME);

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return EMPTY_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw new ScannerConfigError(path, error instanceof Error ? error.message : String(error));
  }

  return parseScannerConfig(parsed, path);
}
