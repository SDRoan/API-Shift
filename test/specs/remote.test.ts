/**
 * Guards for a URL supplied by a stranger.
 *
 * On a public endpoint the visitor chooses what your server fetches. Without
 * these checks the service is a proxy into anything the host can reach,
 * including cloud metadata endpoints and services bound to loopback.
 */

import { describe, expect, it } from 'vitest';
import { UnsafeSpecUrlError, assertPublicHttpUrl } from '../../src/specs/remote.js';

describe('assertPublicHttpUrl', () => {
  it('accepts a normal public https URL', () => {
    expect(assertPublicHttpUrl('https://raw.githubusercontent.com/o/r/main/openapi.json').host).toBe(
      'raw.githubusercontent.com',
    );
  });

  it('refuses anything that is not http or https', () => {
    for (const source of ['file:///etc/passwd', 'ftp://example.test/spec.json', 'data:text/plain,x']) {
      expect(() => assertPublicHttpUrl(source)).toThrow(UnsafeSpecUrlError);
    }
  });

  it('refuses a path, which would otherwise read the server filesystem', () => {
    expect(() => assertPublicHttpUrl('/etc/passwd')).toThrow(/absolute http or https/);
    expect(() => assertPublicHttpUrl('./openapi.json')).toThrow(UnsafeSpecUrlError);
  });

  it('refuses loopback', () => {
    for (const source of ['http://localhost:3000/s.json', 'http://127.0.0.1/s.json', 'http://[::1]/s.json']) {
      expect(() => assertPublicHttpUrl(source)).toThrow(/not a public address/);
    }
  });

  it('refuses cloud metadata, which is the classic SSRF target', () => {
    expect(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/')).toThrow(UnsafeSpecUrlError);
    expect(() => assertPublicHttpUrl('http://metadata.google.internal/x')).toThrow(UnsafeSpecUrlError);
  });

  it('refuses private ranges', () => {
    for (const source of [
      'http://10.0.0.5/s.json',
      'http://192.168.1.1/s.json',
      'http://172.16.0.1/s.json',
      'http://172.31.255.255/s.json',
    ]) {
      expect(() => assertPublicHttpUrl(source)).toThrow(/not a public address/);
    }
  });

  it('does not refuse a public address that merely looks similar', () => {
    // 172.32 is outside the private range, and 11.x is public.
    expect(() => assertPublicHttpUrl('http://172.32.0.1/s.json')).not.toThrow();
    expect(() => assertPublicHttpUrl('http://11.0.0.1/s.json')).not.toThrow();
  });

  it('refuses .internal and .local names', () => {
    expect(() => assertPublicHttpUrl('http://db.internal/s.json')).toThrow(UnsafeSpecUrlError);
    expect(() => assertPublicHttpUrl('http://printer.local/s.json')).toThrow(UnsafeSpecUrlError);
  });
});
