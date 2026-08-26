# acme-checkout

A small service that charges customers through the Acme Payments API.

This is the target codebase for the APIShift demo. It is deliberately ordinary: a
couple of `fetch` calls, a hand written `Charge` interface, and a few places that
read fields off the response.

It calls version 1.0.0 of the Acme Payments API:

- `POST /v1/charges` to create a charge, sending `amount` and `currency`
- `GET /v1/charges/{chargeId}` to read one back

When the vendor ships version 2.0.0, four of those things move at once. The path
is renamed, the `amount` field becomes `amount_cents` in both directions, the
`currency` field changes type, and a new required header appears. Nothing here
stops compiling, which is the whole problem.

[APIShift](https://github.com/SDRoan/API-Shift) opens the pull request that fixes it.

## Running

```bash
npm install
npm run typecheck
```
