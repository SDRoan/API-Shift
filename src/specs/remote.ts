/**
 * Guards for fetching a spec whose URL came from a stranger.
 *
 * On localhost the source can be anything, including a file path. A public
 * endpoint cannot be that trusting: a URL supplied by a visitor is a request
 * your server makes on their behalf, so without checks it becomes a proxy into
 * anything the host can reach, including cloud metadata endpoints and services
 * bound to loopback.
 *
 * Three limits, all of which matter:
 *   1. Only public http and https. No file paths, no private addresses.
 *   2. A byte cap, since specs run to megabytes and a stranger picks the file.
 *   3. A timeout, so a slow host cannot hold a connection open.
 */

export const MAX_SPEC_BYTES = 24 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;

export class UnsafeSpecUrlError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnsafeSpecUrlError';
  }
}

/** Hosts that resolve to the machine itself or to a private network. */
const BLOCKED_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^\[?::1\]?$/,
  /^0\.0\.0\.0$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  // 172.16.0.0 through 172.31.255.255
  /^172\.(1[6-9]|2\d|3[01])\./,
  // Link local, which is how cloud metadata endpoints are reached
  /^169\.254\./,
  // Carrier grade NAT
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

/**
 * Reject anything that is not a public http or https URL.
 *
 * This is a hostname check, so it does not stop a public name that resolves to
 * a private address. A deployment that needs that guarantee should also run
 * behind an egress policy. It does stop the direct attempts.
 */
export function assertPublicHttpUrl(source: string): URL {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new UnsafeSpecUrlError('spec source must be an absolute http or https URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeSpecUrlError(`unsupported protocol ${url.protocol}, use http or https`);
  }

  const host = url.hostname;
  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new UnsafeSpecUrlError(`refusing to fetch from ${host}, which is not a public address`);
  }

  return url;
}

export interface FetchedSpec {
  url: string;
  text: string;
  bytes: number;
}

/**
 * Fetch a spec with a byte cap and a timeout, streaming so an oversized
 * response is abandoned rather than buffered in full.
 */
export async function fetchSpecSafely(
  source: string,
  limits: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<FetchedSpec> {
  const url = assertPublicHttpUrl(source);
  const maxBytes = limits.maxBytes ?? MAX_SPEC_BYTES;
  const timeoutMs = limits.timeoutMs ?? FETCH_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'application/json, application/yaml, text/plain, */*' },
    });

    if (!response.ok) {
      throw new UnsafeSpecUrlError(`HTTP ${response.status} ${response.statusText} from ${url.host}`);
    }

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      throw new UnsafeSpecUrlError(`spec is ${declared} bytes, larger than the ${maxBytes} byte limit`);
    }

    const body = response.body;
    if (body === null) throw new UnsafeSpecUrlError('empty response');

    const chunks: Uint8Array[] = [];
    let bytes = 0;

    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        await body.cancel().catch(() => undefined);
        throw new UnsafeSpecUrlError(`spec exceeded the ${maxBytes} byte limit`);
      }
      chunks.push(chunk);
    }

    return { url: url.toString(), text: Buffer.concat(chunks).toString('utf8'), bytes };
  } catch (error: unknown) {
    if (error instanceof UnsafeSpecUrlError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new UnsafeSpecUrlError(`timed out after ${timeoutMs}ms fetching ${url.host}`);
    }
    throw new UnsafeSpecUrlError(
      `could not fetch ${url.host}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
