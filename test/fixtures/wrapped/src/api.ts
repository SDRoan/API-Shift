/**
 * The shape most real codebases actually have: the API is wrapped once and
 * called through the wrapper everywhere else.
 *
 * The paths are here in the source, but as the second argument of a function
 * APIShift has never heard of. Without apishift.json this scan finds nothing.
 */

const BASE = 'https://api.acme.test';

export interface Charge {
  id: string;
  amount: number;
  currency: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(BASE + path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as T;
}

export function createCharge(amount: number): Promise<Charge> {
  return request('POST', '/v1/charges', { amount, currency: 'usd' });
}

export function getCharge(id: string): Promise<Charge> {
  return request('GET', `/v1/charges/${id}`);
}

export function receipt(charge: Charge): string {
  return `${charge.amount} ${charge.currency}`;
}
