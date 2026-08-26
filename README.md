# APIShift

Dependabot for API changes.

When an API vendor ships a new version of its OpenAPI spec, APIShift diffs the old and new specs, classifies the breaking changes, scans your codebase for the calls that break, generates fixes, and opens a pull request. Silent breaking changes become a reviewable PR before anything reaches production.

## The idea

Most breaking API changes are mechanical. A path is renamed, a field is renamed, a query parameter changes name. Those are safe to patch with an AST codemod and are committed straight to the PR branch.

Some changes are judgment calls. A field type changes from string to integer, a new required parameter appears, a field disappears with no replacement. Those get a drafted suggestion from a local LLM, and they are never committed. They appear in the PR body as a review checklist with file, line, and reasoning.

Every proposed change carries a confidence level, computed as the minimum of three signals: how sure we are what changed in the spec, how sure we are that a given line calls that endpoint, and how sure we are that the edit is correct. Only high confidence changes are committed. An LLM drafted edit is low confidence by policy, so it can never be auto committed.

Full design in [DESIGN.md](DESIGN.md).

## Status

Scaffolding and design. Phase 1 not started.

| Phase | What | Status |
| --- | --- | --- |
| 1 | Differ, classified OpenAPI diff | not started |
| 2 | Scanner, ts-morph call site detection | not started |
| 3 | Fixer plus pull request | not started |
| 4 | Dashboard (optional) | not started |

## Requirements

- Node 22 or newer
- A GitHub personal access token with `repo` scope
- Optional: [Ollama](https://ollama.com) running locally with `llama3.2` pulled. Without it, ambiguous changes still appear in the review checklist, just without a drafted snippet.

Everything used here is free. No paid APIs, no paid hosting, no paid model providers.

## Setup

```bash
npm install
cp .env.example .env
# fill in GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO
npm run build
npm test
```

For the LLM drafts:

```bash
ollama pull llama3.2
```

## Usage

```bash
# diff two specs and print a readable report
npm run apishift -- diff demo/specs/v1.yaml demo/specs/v2.yaml

# write the diff to a file
npm run apishift -- diff demo/specs/v1.yaml demo/specs/v2.yaml --json diff.json

# find the affected call sites in a repo
npm run apishift -- scan ./demo/consumer-app --diff diff.json

# full pipeline, dry run by default
npm run apishift -- fix ./demo/consumer-app --old demo/specs/v1.yaml --new demo/specs/v2.yaml

# full pipeline, open a real pull request
npm run apishift -- fix ./demo/consumer-app --old demo/specs/v1.yaml --new demo/specs/v2.yaml --open-pr
```

Specs can be local file paths or URLs.

## Demo

`demo/` contains a small consumer app that calls a mock payments API, plus two spec versions. `v2` makes two mechanical breaking changes and one ambiguous one.

```bash
npm run demo
```

This runs the whole pipeline against the throwaway GitHub repo named in `.env` and opens a real pull request. In that PR:

- the renamed path and the renamed field appear as committed edits
- the changed field type appears as an unchecked review item with file, line, and reasoning

That contrast is the point of the project.

## Layout

```
src/differ/     parses both specs, returns a typed classified diff
src/scanner/    ts-morph, locates affected call sites in a target repo
src/fixer/      maps changes to edits, deterministic codemods plus LLM drafts
src/llm/        thin Ollama client behind a mockable interface
src/github/     branch, commit, and PR creation via Octokit
src/store/      SQLite for tracked specs and run history
src/cli/        orchestrates the pipeline
```

The differ and the scanner are pure and deterministic. All network and LLM calls sit behind interfaces, so no test requires Ollama or GitHub.

## Security

No secrets in source. All tokens come from `.env`, which is gitignored. `.env.example` documents what is needed. The LLM runs locally, so no source code leaves the machine.
