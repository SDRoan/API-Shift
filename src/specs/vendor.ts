/**
 * Working out whose API a spec describes.
 *
 * A spec never states its vendor, but two fields together identify one
 * reliably: `info.title` is the API's name for itself, and the primary server
 * host is where it actually lives. The host is the stronger signal, since a
 * title can be generic while `api.stripe.com` cannot.
 *
 * This drives the preview so a diff of a payments API looks like a payments
 * screen rather than an anonymous box. It is presentation only. Nothing about
 * classification or patching depends on recognising a vendor.
 */

/** The shape of product a vendor sells, which decides what the preview shows. */
export type VendorDomain =
  | 'payments'
  | 'messaging'
  | 'music'
  | 'code'
  | 'observability'
  | 'infrastructure'
  | 'ai'
  | 'generic';

export interface Vendor {
  id: string;
  /** Display name, for example Stripe. */
  name: string;
  /** Brand accent, used only as an accent. This is a labelled mockup, not a replica. */
  accent: string;
  domain: VendorDomain;
  /** True when we matched a known vendor rather than falling back. */
  recognized: boolean;
}

interface VendorRule {
  id: string;
  name: string;
  accent: string;
  domain: VendorDomain;
  /** Matched against the server host and the title, lowercased. */
  markers: string[];
}

const KNOWN: readonly VendorRule[] = [
  { id: 'stripe', name: 'Stripe', accent: '#635bff', domain: 'payments', markers: ['stripe'] },
  { id: 'adyen', name: 'Adyen', accent: '#0abf53', domain: 'payments', markers: ['adyen'] },
  { id: 'paypal', name: 'PayPal', accent: '#003087', domain: 'payments', markers: ['paypal'] },
  { id: 'square', name: 'Square', accent: '#3e4348', domain: 'payments', markers: ['squareup', 'square'] },
  { id: 'discord', name: 'Discord', accent: '#5865f2', domain: 'messaging', markers: ['discord'] },
  { id: 'slack', name: 'Slack', accent: '#611f69', domain: 'messaging', markers: ['slack'] },
  { id: 'twilio', name: 'Twilio', accent: '#f22f46', domain: 'messaging', markers: ['twilio'] },
  { id: 'spotify', name: 'Spotify', accent: '#1db954', domain: 'music', markers: ['spotify'] },
  { id: 'github', name: 'GitHub', accent: '#1f2328', domain: 'code', markers: ['github'] },
  { id: 'gitlab', name: 'GitLab', accent: '#fc6d26', domain: 'code', markers: ['gitlab'] },
  { id: 'sentry', name: 'Sentry', accent: '#362d59', domain: 'observability', markers: ['sentry'] },
  { id: 'pagerduty', name: 'PagerDuty', accent: '#06ac38', domain: 'observability', markers: ['pagerduty'] },
  { id: 'datadog', name: 'Datadog', accent: '#632ca6', domain: 'observability', markers: ['datadog', 'datadoghq'] },
  { id: 'digitalocean', name: 'DigitalOcean', accent: '#0069ff', domain: 'infrastructure', markers: ['digitalocean'] },
  { id: 'cloudflare', name: 'Cloudflare', accent: '#f38020', domain: 'infrastructure', markers: ['cloudflare'] },
  { id: 'openai', name: 'OpenAI', accent: '#10a37f', domain: 'ai', markers: ['openai'] },
  { id: 'anthropic', name: 'Anthropic', accent: '#d97757', domain: 'ai', markers: ['anthropic'] },
];

const FALLBACK_ACCENT = '#2457d6';

/** Host of the primary server, or an empty string when there is none to read. */
export function hostOf(serverUrl: string | undefined): string {
  if (serverUrl === undefined) return '';
  try {
    return new URL(serverUrl).host.toLowerCase();
  } catch {
    // Server URLs are often templated, for example https://{region}.acme.test
    return serverUrl.toLowerCase();
  }
}

/**
 * Trim an API title down to something that reads as a product name, so
 * "Acme Payments API v2" becomes "Acme Payments".
 */
function nameFromTitle(title: string): string {
  const cleaned = title
    .replace(/\bopenapi\b|\bapi\b|\brest\b|\bspecification\b|\bspec\b/gi, ' ')
    .replace(/\bv?\d+(\.\d+)*\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length > 0 ? cleaned : title.trim();
}

/** Guess the shape of product from the title when the vendor is unknown. */
function domainFromText(text: string): VendorDomain {
  if (/pay|charge|invoice|billing|checkout|balance/.test(text)) return 'payments';
  if (/message|chat|sms|channel/.test(text)) return 'messaging';
  if (/track|album|playlist|music|audio/.test(text)) return 'music';
  if (/repo|commit|pull request|issue/.test(text)) return 'code';
  if (/incident|alert|monitor|metric|log/.test(text)) return 'observability';
  if (/droplet|instance|cluster|server|dns/.test(text)) return 'infrastructure';
  if (/completion|embedding|model|prompt/.test(text)) return 'ai';
  return 'generic';
}

/**
 * Identify the vendor behind a spec. Falls back to the spec's own title rather
 * than guessing, so an unknown API is still named correctly.
 */
export function detectVendor(title: string, serverUrl?: string | undefined): Vendor {
  const host = hostOf(serverUrl);
  const haystack = `${host} ${title}`.toLowerCase();

  // The host is checked first, since it cannot be as generic as a title.
  const matched =
    KNOWN.find((rule) => rule.markers.some((marker) => host.includes(marker))) ??
    KNOWN.find((rule) => rule.markers.some((marker) => haystack.includes(marker)));

  if (matched !== undefined) {
    return {
      id: matched.id,
      name: matched.name,
      accent: matched.accent,
      domain: matched.domain,
      recognized: true,
    };
  }

  return {
    id: 'unknown',
    name: nameFromTitle(title),
    accent: FALLBACK_ACCENT,
    domain: domainFromText(haystack),
    recognized: false,
  };
}

/**
 * Do these two specs describe different APIs?
 *
 * Diffing Discord against Sentry reports every endpoint of one as deleted and
 * every endpoint of the other as added, which is a meaningless result that
 * looks authoritative. Comparing titles catches it before the run.
 */
export function looksLikeDifferentApis(oldTitle: string, newTitle: string): boolean {
  const normalize = (value: string): string => nameFromTitle(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  const before = normalize(oldTitle);
  const after = normalize(newTitle);

  if (before.length === 0 || after.length === 0) return false;
  return !before.includes(after) && !after.includes(before);
}
