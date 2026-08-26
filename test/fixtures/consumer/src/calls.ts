/**
 * Fixture repo for the scanner. Every call shape the scanner claims to handle
 * appears here once, alongside near misses that must not match.
 *
 * Not compiled by the main build. `axios` is declared locally so the fixture
 * needs no dependency of its own.
 */

declare const axios: {
  get: (url: string, config?: unknown) => Promise<{ data: Charge }>;
  post: (url: string, data?: unknown, config?: unknown) => Promise<{ data: Charge }>;
  (config: { url: string; method?: string; data?: unknown }): Promise<{ data: Charge }>;
};

const API_BASE = 'https://api.acme.test';

export interface Charge {
  id: string;
  amount: number;
  currency: string;
}

// url.literal, plain string
export async function listCharges(): Promise<unknown> {
  const response = await fetch('/v1/charges');
  return response.json();
}

// url.template, interpolated base and a path parameter
export async function getCharge(chargeId: string): Promise<Charge> {
  const response = await fetch(`${API_BASE}/v1/charges/${chargeId}`);
  return (await response.json()) as Charge;
}

// request.payload through JSON.stringify, with one shorthand and one explicit key
export async function createCharge(amount: number): Promise<Charge> {
  const response = await fetch(`${API_BASE}/v1/charges`, {
    method: 'POST',
    body: JSON.stringify({
      amount,
      currency: 'usd',
    }),
  });
  return (await response.json()) as Charge;
}

// axios.post, where the payload is the second argument
export async function createChargeViaAxios(amount: number): Promise<Charge> {
  const result = await axios.post(`${API_BASE}/v1/charges`, { amount, currency: 'usd' });
  return result.data;
}

// axios config object call
export async function listChargesViaConfig(): Promise<Charge> {
  const result = await axios({ url: '/v1/charges', method: 'GET' });
  return result.data;
}

// response.member, read from a payload with a declared type
export async function describeCharge(chargeId: string): Promise<string> {
  const charge = await getCharge(chargeId);
  return `${charge.amount} ${charge.currency}`;
}

// A near miss: same field name, unrelated endpoint. Must not match.
export async function listRefunds(): Promise<unknown> {
  const response = await fetch('/v1/refunds', {
    method: 'POST',
    body: JSON.stringify({ amount: 100 }),
  });
  return response.json();
}

// A near miss: a path that only looks similar. Must not match.
export async function listArchivedCharges(): Promise<unknown> {
  const response = await fetch('/v1/charges_archive');
  return response.json();
}

// A near miss: a URL the scanner cannot read. Must not match.
export async function callUnknown(url: string): Promise<unknown> {
  const response = await fetch(url);
  return response.json();
}
