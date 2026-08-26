# APIShift

**Dependabot for API changes.** When a vendor ships a new OpenAPI spec, APIShift finds the breaking changes, locates the exact lines of your code that break, patches the mechanical ones, and opens a pull request with the judgment calls as a review checklist.

> **[See a real pull request it opened](https://github.com/SDRoan/apishift-demo-consumer/pull/2)** — 6 committed edits, 3 review items, on a real repo.

## The problem

Version numbers lie. Diffing two real OpenAI specs nineteen months apart finds **530 breaking changes while `info.version` stayed `2.3.0` on both sides**.

The dangerous changes are the invisible ones. Two days of OpenAI history produced exactly one change:

```
GET /organization/audit_logs
data[].type can now return tenant.ads_account.onboarding.redemption
```

A new enum value. Your code compiles, your tests pass, your types are unchanged, and one day a `switch` falls through in production. Nobody sends an email about that.

## What it does

```bash
npx github:SDRoan/API-Shift diff <old-spec> <new-spec>
```

```
APIShift diff: Box Platform API
  14 breaking, 18 non breaking
  22 distinct changes, some shared across endpoints

BREAKING (14)
  POST /ai/extract_structured
    request.field.added.required  [high]
      new required request field fields[].fields[].options[].key (string)

  7 endpoints
    enum.value.added  [high]
      entries[].fields[].type can now return taxonomy
```

Then it scans your code and patches it:

```diff
 export interface Charge {
-  amount: number;
+  amount_cents: number;
 }

-  await fetch(`${API_BASE}/v1/charges`, {
+  await fetch(`${API_BASE}/v1/payments`, {
-      amount,
+      amount_cents: amount,

-  return `Paid ${charge.amount} ${charge.currency}`;
+  return `Paid ${charge.amount_cents} ${charge.currency}`;
```

That last edit is in a function the HTTP call never reaches. APIShift resolves the response to its declared TypeScript type and renames the interface property plus every reader, so **the patched code still compiles under `strict`**.

## The idea that makes it safe

Most breaking changes are mechanical. A renamed path, a renamed field. Those are AST transforms, and they are committed.

Some are judgment calls. A type that changed, a new required parameter. Those are never committed. They become an unchecked checklist in the PR body with file, line, and reasoning.

Every edit carries a confidence that is the **minimum of three independent signals**: how sure the differ is what changed, how sure the scanner is that a line calls that endpoint, and how sure the fixer is that its edit is correct. Only `high` is committed, and a non deterministic edit is `low` by policy, so it can never reach the bar. The split is structural, not a check someone can forget.

## Try it

```bash
# Any two versions of the same spec, from any public repo
npx github:SDRoan/API-Shift diff \
  https://raw.githubusercontent.com/PagerDuty/api-schema/1482e50ccf662760c05580ee95ff63f8ebbc7534/reference/REST/openapiv3.json \
  https://raw.githubusercontent.com/PagerDuty/api-schema/2326e6b9f4737ca7f383214e1cd9d783c81fd2c6/reference/REST/openapiv3.json
```

`diff` exits 1 when it finds a breaking change, so it drops into CI as is. See [.github/workflows/apishift.yml](.github/workflows/apishift.yml).

Watch a spec instead of comparing two by hand:

```bash
apishift track stripe --source <spec-url> --repo ./my-app
apishift check          # fetch, compare with last time, analyse
apishift history        # what past runs did
```

Detection is by **content hash, not version string**, so a vendor that edits a spec without bumping its version is still caught.

Patch a repo and open a PR:

```bash
apishift fix ./my-app --old <spec> --new <spec>            # dry run
apishift fix ./my-app --old <spec> --new <spec> --open-pr  # opens the PR
```

There is also a local dashboard:

```bash
npm run localhost   # http://127.0.0.1:3000
```

## If your code wraps the API

Most codebases do not call `fetch` directly. They wrap it once:

```ts
export function createCharge(amount: number) {
  return request('POST', '/v1/charges', { amount, currency: 'usd' });
}
```

The path is right there, but as the second argument of a function APIShift has
never heard of, so a scan finds nothing. Drop an `apishift.json` at your repo
root naming the wrapper:

```json
{
  baseUrl: https://api.acme.test,
  requestFunctions: [
    { name: request, methodArgument: 0, urlArgument: 1, bodyArgument: 2 }
  ]
}
```

On the fixture in this repo that takes the scan from **0 affected locations to
7**, patching both URLs, the payload field, the interface, and every reader,
and the result still compiles under `strict`.

## Tested against real specs, not just fixtures

GitHub Enterprise, OpenAI, Stripe, Adyen, Twilio, PagerDuty, Sentry, Discord, Box, Asana, Plaid, Datadog, DigitalOcean.

That found three bugs fixtures never would have:

- **A cascade.** GitHub turning an event `payload` into a union made every nested field below it report as separately removed, inflating one diff from 154 changes to 3853.
- **A false positive.** Twilio annotating one parameter with `format: int64` produced 61 false breaking changes, because I was treating a format annotation as a type change when both are `number` in JavaScript.
- **Duplication.** Box adding one enum value to a shared schema appeared as 7 separate changes, because 7 endpoints reference it.

## Honest limits

- **OpenAPI 3.x only.** Swagger 2.0 is rejected with a clear message.
- **TypeScript and JavaScript only.** It recognises `fetch`, `axios`, and any wrapper you declare in `apishift.json`. A generated SDK where the path never appears anywhere in your source is still invisible to it.
- **Union internals.** `oneOf<3>` to `oneOf<4>` reports that a union widened, not what is inside the new member.
- **Multi file specs** need every referenced file to resolve from the same base, so raw commit URLs will not work for them.

## How it is built

| Module | Job |
| --- | --- |
| `src/differ/` | two specs in, typed classified changes out. Pure |
| `src/scanner/` | ts-morph over a repo, finds affected call sites. Pure, read only |
| `src/fixer/` | maps changes to edits, applies them by character offset |
| `src/github/` | Git Data API, so every file lands in one atomic commit |
| `src/store/` | SQLite, tracked specs and run history |
| `src/cli/`, `src/server/` | commands and the local dashboard |

Five runtime dependencies: `@apidevtools/swagger-parser`, `openapi-types`, `ts-morph`, `@octokit/rest`, `better-sqlite3`. Argument parsing uses Node's `util.parseArgs` and env loading uses `process.loadEnvFile`, so the CLI adds nothing of its own. The dashboard is plain `node:http` with no framework and no build step.

275 tests. The differ and scanner are pure so they test against fixtures with no mocks, GitHub is tested against a fake client, and one test compiles the JavaScript the dashboard actually serves.

Full design and reasoning in [DESIGN.md](DESIGN.md).

## Development

```bash
npm install
npm test
npm run typecheck
cp .env.example .env   # GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO for --open-pr
```

MIT.
