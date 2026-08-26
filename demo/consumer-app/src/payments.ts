const API_BASE = 'https://api.example-payments.test';

export interface Charge {
  id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed';
}

export async function createCharge(amount: number, currency: string): Promise<Charge> {
  const response = await fetch(`${API_BASE}/v1/charges`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      amount,
      currency,
    }),
  });

  return response.json() as Promise<Charge>;
}

export async function loadCharge(chargeId: string): Promise<string> {
  const response = await fetch(`${API_BASE}/v1/charges/${chargeId}`);
  const charge = (await response.json()) as Charge;

  if (charge.status === 'succeeded') {
    return `Paid ${charge.amount} ${charge.currency}`;
  }

  return `Charge ${charge.id} is ${charge.status}`;
}

export function renderChargeBadge(charge: Charge): string {
  return `${charge.status}: ${charge.amount} ${charge.currency}`;
}
