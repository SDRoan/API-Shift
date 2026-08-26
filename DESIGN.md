# APIShift Design

Dependabot for API changes. When a vendor ships a new version of its OpenAPI spec, APIShift diffs the old and new specs, classifies the breaking changes, scans a target codebase for the call sites that break, generates fixes, and opens a pull request.

Status: design approved pending review. No implementation yet.

---

## 1. Problem

A vendor renames `/charges` to `/payments` and renames the `amount` field to `amount_cents`. The change ships in a new OpenAPI spec. Nothing in the consumer codebase fails to compile. Nothing fails in CI. The break shows up in production as a 404 and a silently dropped field.

Existing tools cover half the loop. Spec diff tools (openapi-diff, oasdiff) tell you what changed in the spec but know nothing about your code. Dependabot patches your dependency versions but knows nothing about your API vendor's contract. Nobody connects "the spec changed" to "these 6 lines in your repo are now wrong" to "here is the PR that fixes them".

APIShift closes that loop. The output is a reviewable pull request, not a report.

### Why a PR is the right output

A report puts the work back on the engineer. A pull request is a unit of work that already fits every team's review, CI, and merge workflow. It is also honest about uncertainty: the mechanical fixes arrive as committed diff, and the judgment calls arrive as an explicit checklist in the PR body. The engineer reviews rather than investigates.

---

## 2. Goals and non goals

### Goals

1. Correctness over coverage. A small set of change kinds handled precisely beats a large set handled approximately. A wrong automated edit is worse than no edit.
2. Deterministic core. The differ and the scanner are pure functions with no network and no LLM. They are unit testable against fixtures and produce the same output every run.
3. Honest confidence. Every proposed change carries a confidence level, and the level decides whether the change is committed or surfaced for review.
4. A demo that runs end to end with one command and opens a real pull request.

### Non goals for the MVP

These are noted as future work and are deliberately not built now.

| Out of scope | Why |
| --- | --- |
| Languages other than TypeScript and JavaScript | The scanner is the deepest part of the system. One language done well is the credible version. Python and Go are future work behind the same `Scanner` interface. |
| A hosted always on service or webhook listener | The CLI proves the pipeline. A GitHub App with webhook delivery adds hosting, secret rotation, and delivery retries, none of which demonstrate anything new about the core idea. |
| Auth, multi user, billing | Single user local tool. SQLite has no tenant column and should not grow one. |
| Non OpenAPI descriptions (GraphQL, gRPC, AsyncAPI) | Different change taxonomies entirely. |
| Automatic merge | APIShift opens PRs. A human merges them. This is a product stance, not a limitation. |

---

## 3. The fix strategy and confidence model

This is the core of the project. Everything else is plumbing.

### The split

The naive build sends the spec diff and the source file to an LLM and asks for a patch. That fails for three reasons. It is nondeterministic, so the same input produces different edits across runs. It is unverifiable, so a reviewer has to re-derive the whole change to trust it. It is unnecessary, because most breaking API changes are mechanical string level substitutions that an AST tool performs perfectly.

So the work splits by how mechanical the change is.

**Deterministic codemods** handle mechanical changes with ts-morph. Path renamed, request field renamed, response field renamed, query parameter renamed, removed field cleaned up. These are pure AST transforms with unit tests. They never touch business logic and never invent a value. They are committed to the PR branch.

**LLM assisted drafts** handle ambiguous changes with a local Ollama model. A field whose type changed from string to integer needs a conversion whose correct form depends on what the surrounding code does. A newly required parameter needs a value that only the application author knows. A field removed with no replacement needs a decision. The LLM drafts a suggestion. The suggestion is never committed. It appears in the PR body as a checklist item with the file, the line, the reasoning, and the proposed snippet.

### The confidence model

Confidence is not a vibe attached at the end. It is computed as the minimum of three independent signals, because a chain is as weak as its weakest link.

```
confidence(edit) = min(
  changeConfidence,   // how sure are we what changed in the spec
  siteConfidence,     // how sure are we this code calls that endpoint
  strategyConfidence  // how sure are we this edit is correct
)
```

Levels are `high`, `medium`, `low`.

**changeConfidence** comes from the differ. A removed path is observed directly, so it is `high`. A *renamed* path is inferred, because OpenAPI diffs do not record renames. A rename inferred from a matching `operationId` is `high`. A rename inferred from schema similarity plus a string distance heuristic is `medium`. See section 4.2.

**siteConfidence** comes from the scanner. A static string literal `fetch('/v1/charges')` is `high`. A template literal with a static path portion, `fetch(\`${BASE}/charges\`)`, is `high`. A member access resolved to a response binding by local dataflow within one function is `medium`. A bare property name match with no traceable link to the endpoint is `low`.

**strategyConfidence** comes from the fixer. A deterministic codemod is `high` by construction, because it is tested. Any LLM produced edit is `low` by policy, always, with no exception and no override flag. This is the rule that keeps the system trustworthy.

### The routing rule

```
high            -> apply the edit, commit it to the PR branch
medium or low   -> do not touch the file, add a checklist item to the PR body
```

Only `high` is committed. Because `strategyConfidence` for an LLM edit is always `low`, and confidence is a minimum, an LLM edit can never reach `high`. The split is structural rather than a policy check that could be forgotten.

### Worked example

`v2` renames path `/v1/charges` to `/v1/payments`, renames request field `amount` to `amount_cents`, and changes response field `currency` from string to an integer code.

| Change | changeConf | Site | siteConf | Strategy | stratConf | Result |
| --- | --- | --- | --- | --- | --- | --- |
| path rename | high (matching operationId) | `fetch('/v1/charges')` | high (literal) | RenamePath codemod | high | committed |
| field rename | high | `body: { amount: 500 }` | high (literal key) | RenameRequestField codemod | high | committed |
| type change | high | `res.currency` | medium (dataflow) | LLM draft | low | checklist item |

That contrast is the demo.

### LLM guardrails

1. The model runs locally through Ollama. No data leaves the machine.
2. Prompts request a strict JSON object. Responses are schema validated before use, and a malformed response is retried once then dropped, never partially applied.
3. Every drafted snippet is parsed with the TypeScript compiler before being shown. A draft that does not parse is discarded and the checklist item falls back to a plain language description.
4. Drafts are never written to disk in the target repo. They exist only in the PR body.
5. The `LlmClient` interface is mocked in all tests. No test requires Ollama to be running.

---

## 4. Architecture

Single npm package, internal modules, no monorepo.

```
src/
  types.ts        shared domain types, the contract between modules
  differ/         two specs in, classified changes out. pure.
  scanner/        repo path plus changes in, call sites out. pure.
  fixer/          changes plus sites in, edits with confidence out.
    codemods/     deterministic ts-morph transforms, one file each
    llm/          draft generation for ambiguous changes
  llm/            thin Ollama client behind an interface
  github/         branch, commit, PR via Octokit
  store/          SQLite access, tracked specs and run history
  cli/            argument parsing and pipeline orchestration
```

### 4.1 Data flow

```
old spec ─┐
          ├─> differ ──> ApiChange[] ──┐
new spec ─┘                            │
                                       ├─> fixer ──> ProposedEdit[] ──┬─> apply high conf ──> github ──> PR
repo path ────> scanner ──> CallSite[]─┘                              └─> low conf list ────> PR body
                     ▲                                                          │
                     └── driven by ApiChange[]                                  ▼
                                                                              store
```

The scanner is driven by the diff rather than scanning blindly. It only looks for what actually changed, which keeps it fast and keeps false positives low.

### 4.2 The differ

Parses both specs with `@apidevtools/swagger-parser` using `dereference`, so `$ref` chasing is not our problem. Walks paths, operations, parameters, request bodies, and responses, and emits a flat typed list.

Change kinds, with the default breaking classification:

| Kind | Breaking | Notes |
| --- | --- | --- |
| `operation.removed` | yes | |
| `operation.added` | no | |
| `path.renamed` | yes | inferred, see below |
| `param.removed` | no | request direction, the server ignores it |
| `param.added.required` | yes | request has no value to send |
| `param.renamed` | yes | inferred |
| `param.type.changed` | yes | |
| `request.field.removed` | no | unless it was required |
| `request.field.added.required` | yes | |
| `request.field.renamed` | yes | inferred |
| `request.field.type.changed` | yes | |
| `response.field.removed` | yes | consumer reads it today |
| `response.field.renamed` | yes | inferred |
| `response.field.type.changed` | yes | |
| `response.status.removed` | yes | |
| `enum.value.removed` | yes | in response direction |
| `enum.value.added` | no | in response direction, yes in request |

Direction matters. Removing a request field is safe for the consumer, because the server ignores an extra key. Removing a response field breaks any consumer reading it. The differ tracks `direction: 'request' | 'response'` on every field level change and classifies accordingly.

**Rename inference.** OpenAPI diffs report a removal and an addition, never a rename. Renames are the highest value change kind for a codemod, so they get real inference rather than a guess.

For paths, a removed path and an added path pair into a rename when:
1. Their operations share a non empty `operationId`. Confidence `high`.
2. Otherwise, their operations have structurally equal request and response schemas, the same method set, and normalized Levenshtein similarity above 0.5. Confidence `medium`.
3. Pairing is one to one and greedy by descending score. An unpaired removal stays a removal.

For fields, a removed property and an added property within the same schema pair into a rename when:
1. Their schemas are structurally equal and exactly one candidate exists on each side. Confidence `high`.
2. Otherwise, schemas are equal and the names are related by a known casing or unit transform, for example `amount` to `amount_cents` or `userId` to `user_id`. Confidence `medium`.

Unpaired changes remain separate add and remove entries. False renames are worse than missed renames, so the thresholds stay conservative.

The differ output is a stable sorted array so snapshots are deterministic, and it serializes to JSON so `apishift diff` can write a file that `apishift scan` reads back.

### 4.3 The scanner

`ts-morph` over the target repo, using its `tsconfig.json` when present and a glob fallback when not. Read only, always.

Five detection strategies, each producing its own site confidence:

1. **Static URL literal.** `fetch('/v1/charges')`, `axios.get('https://api.x.com/v1/charges')`. Match the affected path against the literal, allowing a base URL prefix and OpenAPI templating (`/charges/{id}` matches `/charges/123`). Confidence `high`.
2. **Template literal URL.** `fetch(\`${BASE}/v1/charges/${id}\`)`. Match on the static spans, treating interpolations as wildcards that must align with path template parameters. Confidence `high`.
3. **Request payload keys.** Object literal properties in a `body`, in `JSON.stringify({...})`, or in the axios data argument, on a call already matched to an operation by strategy 1 or 2. Confidence inherits from the URL match.
4. **Response member access.** Bind the variable that receives the call result, then find member accesses and destructuring on it within the same function scope. Handles `const res = await fetch(...); const data = await res.json(); data.amount` and the axios `res.data.amount` shape. Local dataflow only, no cross file inference. Confidence `medium`.
5. **Client method calls.** A method call whose name matches an affected `operationId`, in camelCase or snake_case form, on an object that looks like an API client. Confidence `medium`, or `high` when the client is a known generated client with a matching import.

Everything else is out. No regex fallback over source text, because the whole point of ts-morph is that we edit syntax and not strings.

Each `CallSite` records file, line, column, the matched strategy, the node kind, and the `ApiChange` it answers to. The record is enough for both a codemod and a PR checklist entry.

### 4.4 The fixer

Maps `(ApiChange, CallSite)` pairs to `ProposedEdit` values. A registry picks a strategy by change kind and site strategy. If no deterministic codemod claims the pair, it falls through to the LLM drafter.

Codemods in the MVP, one file and one test file each:

| Codemod | Handles |
| --- | --- |
| `renamePath` | rewrites the path segment inside string and template literals |
| `renameRequestField` | renames an object literal property key in a request payload |
| `renameResponseField` | renames member access and destructuring on a response binding |
| `renameQueryParam` | renames keys in query object literals and `URLSearchParams` calls |
| `removeRequestField` | deletes a property that no longer exists in the request schema |

Each codemod is a pure function from a ts-morph node plus change to a text edit description. Edits are collected, checked for overlap, and applied in one pass per file in reverse position order so offsets stay valid.

The LLM drafter handles `*.type.changed`, `param.added.required`, `request.field.added.required`, and unpaired `response.field.removed`. It receives the change, the surrounding function source, and the site, and returns a JSON object with `suggestion`, `reasoning`, and `snippet`.

### 4.5 The GitHub module

Octokit with a personal access token from `.env`. The commit is built with the Git Data API rather than a sequence of Contents API calls, so all file changes land in one atomic commit.

1. read the base branch head sha
2. create blobs for each changed file
3. create a tree from the base tree plus the blobs
4. create a commit pointing at that tree
5. create a ref `refs/heads/apishift/<spec-slug>-<new-version>-<short-run-id>`
6. open the PR

The PR body is generated from the run and has a fixed shape:

```
## Spec change summary
what changed between the two spec versions, breaking first

## Patched automatically (high confidence)
file, line, and the edit applied, grouped by file

## Needs human review (low confidence)
- [ ] file:line, what changed, why it is ambiguous, suggested snippet

## Run details
spec source, versions, run id, counts
```

The run is dry run by default. Nothing hits GitHub without `--open-pr`.

### 4.6 The store

`better-sqlite3`, synchronous, one file at `.apishift/apishift.db`. Migrations are a numbered array of SQL strings applied in order and tracked with `PRAGMA user_version`.

```sql
CREATE TABLE specs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,           -- file path or url
  last_seen_version TEXT,
  last_checked_at TEXT
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  spec_id INTEGER REFERENCES specs(id),
  old_version TEXT NOT NULL,
  new_version TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,           -- running | success | failed
  pr_url TEXT,
  error TEXT
);

CREATE TABLE changes (
  id INTEGER PRIMARY KEY,
  run_id INTEGER REFERENCES runs(id),
  kind TEXT NOT NULL,
  breaking INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  payload TEXT NOT NULL           -- json ApiChange
);

CREATE TABLE edits (
  id INTEGER PRIMARY KEY,
  run_id INTEGER REFERENCES runs(id),
  change_id INTEGER REFERENCES changes(id),
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  strategy TEXT NOT NULL,         -- codemod name or 'llm'
  confidence TEXT NOT NULL,
  applied INTEGER NOT NULL,
  detail TEXT NOT NULL            -- json ProposedEdit
);
```

Run history makes the dashboard phase trivial and makes the CLI able to answer "what did the last run do".

### 4.7 The LLM module

```ts
export interface LlmClient {
  complete(prompt: string, options?: LlmOptions): Promise<string>
  isAvailable(): Promise<boolean>
}
```

`OllamaClient` implements it over `POST /api/generate` with `stream: false`, model and host from env with defaults `llama3.2` and `http://localhost:11434`. Tests use `FakeLlmClient`, which returns scripted responses. If Ollama is unreachable, the pipeline degrades: ambiguous changes still appear in the checklist, with the plain language description and no suggested snippet. The pipeline never fails because a model is missing.

### 4.8 Core types

The contract between modules, defined once in `src/types.ts`.

```ts
export type Confidence = 'high' | 'medium' | 'low'
export type Direction = 'request' | 'response'

export interface ApiChange {
  id: string
  kind: ChangeKind
  breaking: boolean
  confidence: Confidence
  direction?: Direction
  path: string
  method?: HttpMethod
  operationId?: string
  target?: { from?: string; to?: string; location: 'path' | 'query' | 'header' | 'body' | 'response' }
  detail: string
}

export interface CallSite {
  changeId: string
  file: string
  line: number
  column: number
  strategy: SiteStrategy
  confidence: Confidence
  snippet: string
}

export interface ProposedEdit {
  changeId: string
  site: CallSite
  strategy: string          // codemod name or 'llm'
  confidence: Confidence    // min of the three signals
  action: 'apply' | 'review'
  before: string
  after?: string            // present for apply, optional for review
  reasoning: string
}
```

### 4.9 Dependencies

Approved stack only, plus what the Node runtime already provides.

Runtime: `@apidevtools/swagger-parser`, `openapi-types`, `ts-morph`, `@octokit/rest`, `better-sqlite3`.
Dev: `typescript`, `vitest`, `@types/node`, `@types/better-sqlite3`.

Two things that would normally be dependencies are not, and this is deliberate:

- **Argument parsing.** Node's built in `util.parseArgs` covers the CLI, so no commander or yargs.
- **Env loading.** Node 22 has `process.loadEnvFile()`, so no dotenv.

Nothing else gets added without flagging it first.

---

## 5. Phase plan

Each phase ends with something runnable and passing tests. No phase starts before the previous one is green.

### Phase 1: Differ

Parse two specs, emit the classified diff, including rename inference. Unit tests over fixture spec pairs, one pair per change kind, plus a pair with no changes and a pair with only additive changes.

Done when `apishift diff <old> <new>` prints a readable report and `--json <file>` writes a diff artifact.

### Phase 2: Scanner

ts-morph over a target repo, driven by a diff artifact. All five detection strategies with their confidence levels. Unit tests over a small fixture repo under `test/fixtures/consumer/` covering each strategy plus near miss cases that must not match.

Done when `apishift scan <repo> --diff <file>` reports file, line, strategy, and confidence for every affected site.

### Phase 3: Fixer plus PR

The five codemods with tests, the LLM drafter against `FakeLlmClient`, edit application, and the GitHub flow. Store writes for runs, changes, and edits.

Done when `apishift fix <repo> --old <spec> --new <spec> --open-pr` opens a real PR with committed high confidence edits and a low confidence checklist. `--dry-run` is the default and prints the same content locally.

### Phase 4 (optional): Dashboard

React 18, Vite, TypeScript, Tailwind. Reads the SQLite database through a tiny local read only server. Lists tracked specs, run history, diffs, and PR links. Local first, and the core project does not depend on it.

---

## 6. Demo scenario

`demo/` proves the whole loop with no manual editing.

```
demo/
  consumer-app/       small TS app calling a mock payments API
    src/charges.ts    fetch based calls, static URL literals
    src/client.ts     axios based calls, template literal URL
    src/report.ts     reads response fields including the ambiguous one
  specs/
    v1.yaml
    v2.yaml
  README.md
```

`v1` to `v2` carries three changes chosen to exercise both halves of the strategy:

1. Path `/v1/charges` renamed to `/v1/payments`, same `operationId`. Mechanical, committed.
2. Request field `amount` renamed to `amount_cents`. Mechanical, committed.
3. Response field `currency` changed from string to integer. Ambiguous, checklist only.

`npm run demo` runs the pipeline against a throwaway GitHub repo read from `.env` and opens a real PR. The PR shows edits 1 and 2 as committed diff and change 3 as an unchecked review item with the file, the line, the reasoning, and a suggested conversion.

The contrast between the committed diff and the checklist is the thing to look at.

---

## 7. Testing

- Differ and scanner are pure, so they are tested directly against fixtures with no mocks.
- Each codemod has its own test file with a before and after source pair.
- The LLM path is tested against `FakeLlmClient`. No test needs Ollama running.
- The GitHub module is tested against a fake Octokit, asserting the call sequence and payloads. No test opens a real PR.
- One integration test runs differ, scanner, and fixer over the demo fixtures and asserts the confidence split, stopping short of the network.

---

## 8. Known risks

| Risk | Mitigation |
| --- | --- |
| Rename inference produces a false pair and a codemod rewrites correct code | Conservative thresholds, one to one pairing, `medium` confidence never auto commits |
| Scanner misses call sites built dynamically at runtime | Accepted. Missed sites are reported as unmatched changes in the PR body so the reviewer knows coverage was partial |
| A local 3B model writes poor suggestions | Suggestions are never committed, are parse checked, and degrade to plain text. The pipeline works with the model turned off |
| Codemods conflict when two changes touch one line | Edits are checked for range overlap before application, and a conflicting pair drops to the review checklist |

---

## 9. Configuration

All secrets come from `.env`, which is gitignored. `.env.example` is committed.

```
GITHUB_TOKEN=          # PAT with repo scope
GITHUB_OWNER=
GITHUB_REPO=
GITHUB_BASE_BRANCH=main
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2
APISHIFT_DB=.apishift/apishift.db
```

No token, host, or repo name appears in source. The GitHub module reads config through one typed loader that fails fast with a clear message when a required value is missing.
