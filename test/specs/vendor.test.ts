/**
 * Vendor detection. Presentation only: nothing about classification or
 * patching depends on recognising a vendor, so the fallback has to be as good
 * as the match.
 */

import { describe, expect, it } from 'vitest';
import { detectVendor, hostOf, looksLikeDifferentApis } from '../../src/specs/vendor.js';

describe('detectVendor', () => {
  it('identifies a vendor from the server host', () => {
    const vendor = detectVendor('Payments API', 'https://api.stripe.com');
    expect(vendor).toMatchObject({ id: 'stripe', name: 'Stripe', domain: 'payments', recognized: true });
  });

  it('identifies a vendor from the title when there is no server', () => {
    expect(detectVendor('Discord HTTP API').id).toBe('discord');
  });

  it('prefers the host, since a title can be generic and a host cannot', () => {
    expect(detectVendor('Compare with Stripe', 'https://api.spotify.com').id).toBe('spotify');
  });

  it('falls back to the spec title rather than guessing a vendor', () => {
    const vendor = detectVendor('Acme Payments API v2', 'https://api.acme.test');
    expect(vendor.recognized).toBe(false);
    expect(vendor.name).toBe('Acme Payments');
  });

  it('infers a domain for an unknown vendor from what the API talks about', () => {
    expect(detectVendor('Acme Charges and Invoices').domain).toBe('payments');
    expect(detectVendor('Acme Incident Alerts').domain).toBe('observability');
    expect(detectVendor('Acme Widgets').domain).toBe('generic');
  });

  it('always returns a usable accent and name', () => {
    const vendor = detectVendor('', undefined);
    expect(vendor.accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(typeof vendor.name).toBe('string');
  });
});

describe('hostOf', () => {
  it('reads the host from a server URL', () => {
    expect(hostOf('https://api.stripe.com/v1')).toBe('api.stripe.com');
  });

  it('tolerates a templated server URL', () => {
    expect(hostOf('https://{region}.acme.test')).toContain('acme.test');
  });

  it('returns an empty string when there is no server', () => {
    expect(hostOf(undefined)).toBe('');
  });
});

describe('looksLikeDifferentApis', () => {
  it('catches two unrelated APIs', () => {
    expect(looksLikeDifferentApis('Discord HTTP API', 'Sentry API')).toBe(true);
  });

  it('accepts the same API across versions', () => {
    expect(looksLikeDifferentApis('Stripe API', 'Stripe API')).toBe(false);
    expect(looksLikeDifferentApis('Acme Payments API v1', 'Acme Payments API v2')).toBe(false);
  });

  it('accepts a title that gained or lost a qualifier', () => {
    expect(looksLikeDifferentApis('GitHub v3 REST API', 'GitHub REST API')).toBe(false);
  });

  it('stays quiet when a title is missing, rather than warning on nothing', () => {
    expect(looksLikeDifferentApis('', 'Stripe API')).toBe(false);
  });
});
