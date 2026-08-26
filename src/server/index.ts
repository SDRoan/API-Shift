import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, resolve } from 'node:path';
import { diffSpecs } from '../differ/index.js';
import { planApiUpdate } from '../fixer/index.js';
import { scanCodebase } from '../scanner/index.js';
import type { ApiChange, Confidence, SpecDiff } from '../types.js';
import { hasGitHubConfig, loadGitHubConfig } from '../github/config.js';
import { createGitHubApi, findApishiftPullRequests } from '../github/index.js';
import { detectVendor, looksLikeDifferentApis } from '../specs/vendor.js';
import type { Vendor } from '../specs/vendor.js';
import type { ApishiftPullRequest } from '../github/index.js';

// Pick up .env so the dashboard can show real pull requests without the caller
// remembering --env-file. Absent or unreadable is fine, the UI degrades to the
// preview and says so.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env, run in preview only mode
}

const DEFAULT_HOST = process.env.HOST ?? '127.0.0.1';
const DEFAULT_PORT = parsePort(process.env.PORT, 3000);
const MAX_PORT_ATTEMPTS = 20;
const STRIPE_OLD_SPEC = 'https://raw.githubusercontent.com/stripe/openapi/v2200/openapi/spec3.json';
const STRIPE_NEW_SPEC = 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json';
const DEMO_OLD_SPEC = 'demo/specs/v1.yaml';
const DEMO_NEW_SPEC = 'demo/specs/v2.yaml';
const DEMO_CODEBASE = 'demo/consumer-app';

interface DiffSummary {
  total: number;
  breaking: number;
  nonBreaking: number;
  confidence: Record<Confidence, number>;
  kinds: Array<{ kind: string; count: number }>;
}

interface DiffPayload {
  diff: SpecDiff;
  summary: DiffSummary;
  /** Who the API belongs to, so the preview can look like their product. */
  vendor: Vendor;
  /** Set when the two specs look like different APIs entirely. */
  warning?: string;
}

/** Identity and a mismatch check, shared by both endpoints. */
function describeSpecs(diff: SpecDiff): { vendor: Vendor; warning?: string } {
  const vendor = detectVendor(diff.newTitle, diff.newServer);

  if (looksLikeDifferentApis(diff.oldTitle, diff.newTitle)) {
    return {
      vendor,
      warning:
        `These look like two different APIs: "${diff.oldTitle}" against "${diff.newTitle}". ` +
        'Every endpoint of one will report as removed and every endpoint of the other as added.',
    };
  }

  return { vendor };
}

interface AgentPayload extends DiffPayload {
  repoPath: string;
  sites: ReturnType<typeof scanCodebase> extends Promise<infer Sites> ? Sites : never;
  edits: ReturnType<typeof planApiUpdate>['edits'];
  pr: ReturnType<typeof planApiUpdate>['pr'];
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

function summarizeChanges(changes: ApiChange[]): DiffSummary {
  const confidence: Record<Confidence, number> = { high: 0, medium: 0, low: 0 };
  const kinds = new Map<string, number>();

  for (const change of changes) {
    confidence[change.confidence] += 1;
    kinds.set(change.kind, (kinds.get(change.kind) ?? 0) + 1);
  }

  return {
    total: changes.length,
    breaking: changes.filter((change) => change.breaking).length,
    nonBreaking: changes.filter((change) => !change.breaking).length,
    confidence,
    kinds: [...kinds.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(html);
}

async function handleDiff(url: URL, response: ServerResponse): Promise<void> {
  const oldSource = url.searchParams.get('old')?.trim() || STRIPE_OLD_SPEC;
  const newSource = url.searchParams.get('new')?.trim() || STRIPE_NEW_SPEC;

  try {
    const diff = await diffSpecs(oldSource, newSource);
    const payload: DiffPayload = {
      diff,
      summary: summarizeChanges(diff.changes),
      ...describeSpecs(diff),
    };
    sendJson(response, 200, payload);
  } catch (error: unknown) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveCodebasePath(repoPath: string): string {
  const workspace = resolve(process.cwd());
  const absolute = resolve(process.cwd(), repoPath);
  if (absolute !== workspace && !absolute.startsWith(`${workspace}/`)) {
    throw new Error('codebase path must stay inside this APIShift workspace');
  }
  return absolute;
}

async function handleAgent(url: URL, response: ServerResponse): Promise<void> {
  const oldSource = url.searchParams.get('old')?.trim() || DEMO_OLD_SPEC;
  const newSource = url.searchParams.get('new')?.trim() || DEMO_NEW_SPEC;
  const repoPath = url.searchParams.get('repo')?.trim() || DEMO_CODEBASE;

  try {
    const diff = await diffSpecs(oldSource, newSource);
    const absoluteRepoPath = resolveCodebasePath(repoPath);
    const sites = await scanCodebase(absoluteRepoPath, diff.changes);
    const run = planApiUpdate(diff.changes, sites);
    const payload: AgentPayload = {
      diff,
      summary: summarizeChanges(diff.changes),
      ...describeSpecs(diff),
      repoPath,
      sites: run.sites,
      edits: run.edits,
      pr: run.pr,
    };
    sendJson(response, 200, payload);
  } catch (error: unknown) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

interface PullRequestPayload {
  configured: boolean;
  repo?: string;
  pullRequests: ApishiftPullRequest[];
  error?: string;
}

/**
 * Real pull requests APIShift has opened, so the dashboard can stop calling a
 * preview something it is not. Read only: nothing here creates a branch or a
 * pull request, that stays an explicit CLI action.
 */
async function handlePullRequests(response: ServerResponse): Promise<void> {
  if (!hasGitHubConfig()) {
    sendJson(response, 200, { configured: false, pullRequests: [] } satisfies PullRequestPayload);
    return;
  }

  try {
    const config = loadGitHubConfig();
    const api = await createGitHubApi(config);
    const pullRequests = await findApishiftPullRequests(api, config);
    sendJson(response, 200, {
      configured: true,
      repo: `${config.owner}/${config.repo}`,
      pullRequests,
    } satisfies PullRequestPayload);
  } catch (error: unknown) {
    sendJson(response, 200, {
      configured: true,
      pullRequests: [],
      error: error instanceof Error ? error.message : String(error),
    } satisfies PullRequestPayload);
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const host = request.headers.host ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const url = new URL(request.url ?? '/', `http://${host}`);

  if (request.method === 'GET' && url.pathname === '/') {
    sendHtml(response, renderDashboard());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, name: 'apishift' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/diff') {
    await handleDiff(url, response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/agent') {
    await handleAgent(url, response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/pull-requests') {
    await handlePullRequests(response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>APIShift</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --ink: #151923;
      --muted: #5e687a;
      --line: #dce1ea;
      --blue: #2457d6;
      --cyan: #0e7490;
      --green: #17803d;
      --amber: #a45a00;
      --red: #b42318;
      --shadow: 0 14px 34px rgba(21, 25, 35, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }

    button,
    input {
      font: inherit;
    }

    .app {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }

    header {
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.88);
      backdrop-filter: blur(16px);
      position: sticky;
      top: 0;
      z-index: 2;
    }

    .topbar {
      max-width: 1180px;
      margin: 0 auto;
      padding: 16px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .mark {
      width: 38px;
      height: 38px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: var(--ink);
      color: #fff;
      font-weight: 800;
      letter-spacing: 0;
    }

    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.1;
      letter-spacing: 0;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 14px;
      white-space: nowrap;
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--green);
      box-shadow: 0 0 0 4px rgba(23, 128, 61, 0.14);
    }

    main {
      width: 100%;
      max-width: 1180px;
      margin: 0 auto;
      padding: 24px 20px 36px;
      display: grid;
      grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }

    .panel,
    .overview,
    .change {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }

    .panel {
      padding: 18px;
    }

    .control {
      display: grid;
      gap: 8px;
      margin-bottom: 14px;
    }

    label {
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
    }

    input {
      width: 100%;
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--ink);
      background: #fbfcfe;
    }

    input:focus {
      outline: 3px solid rgba(36, 87, 214, 0.16);
      border-color: var(--blue);
      background: #fff;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-top: 18px;
    }

    button {
      min-height: 42px;
      border: 0;
      border-radius: 8px;
      padding: 0 15px;
      background: var(--blue);
      color: #fff;
      font-weight: 800;
      cursor: pointer;
    }

    button:disabled {
      cursor: wait;
      opacity: 0.72;
    }

    .ghost {
      background: #eef2ff;
      color: var(--blue);
    }

    /* A thin strip, not cards. The pipeline stages are the headline figures,
       and two competing sets of big numbers read as duplication. */
    .summary {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 18px;
    }

    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      min-height: 84px;
      display: grid;
      align-content: space-between;
      gap: 8px;
      background: #fbfcfe;
    }

    .metric span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .metric strong {
      font-size: 28px;
      line-height: 1;
      letter-spacing: 0;
    }

    .visual {
      height: 10px;
      display: grid;
      grid-template-columns: var(--break) var(--safe);
      overflow: hidden;
      border-radius: 999px;
      background: #e8ecf3;
      margin-top: 16px;
    }

    .visual div:first-child {
      background: var(--red);
    }

    .visual div:last-child {
      background: var(--green);
    }

    .results {
      min-width: 0;
      display: grid;
      gap: 14px;
    }

    .overview {
      padding: 16px;
      display: grid;
      gap: 16px;
      box-shadow: none;
    }

    .version-flow {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      align-items: center;
      gap: 12px;
    }

    .version-node {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      min-width: 0;
      background: #fbfcfe;
    }

    .version-node span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }

    .version-node strong {
      display: block;
      margin-top: 5px;
      font-size: 18px;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }

    .version-node em {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
      font-style: normal;
      overflow-wrap: anywhere;
    }

    .flow {
      min-width: 104px;
      display: grid;
      justify-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }

    .arrow {
      width: 100%;
      height: 2px;
      position: relative;
      background: var(--blue);
    }

    .arrow::after {
      content: "";
      position: absolute;
      right: -1px;
      top: 50%;
      width: 9px;
      height: 9px;
      border-top: 2px solid var(--blue);
      border-right: 2px solid var(--blue);
      transform: translateY(-50%) rotate(45deg);
      background: transparent;
    }

    .chart-grid {
      display: grid;
      grid-template-columns: minmax(180px, 220px) minmax(0, 1fr);
      gap: 16px;
      align-items: center;
    }

    .impact-chart {
      display: grid;
      justify-items: center;
      gap: 10px;
    }

    .donut {
      width: 148px;
      aspect-ratio: 1;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: conic-gradient(var(--red) var(--breakAngle), var(--green) 0);
      position: relative;
    }

    .donut::after {
      content: "";
      position: absolute;
      inset: 18px;
      border-radius: 50%;
      background: var(--panel);
      box-shadow: inset 0 0 0 1px var(--line);
    }

    .donut strong {
      position: relative;
      z-index: 1;
      font-size: 24px;
      line-height: 1;
    }

    .legend {
      width: 100%;
      display: grid;
      gap: 7px;
      font-size: 13px;
      color: var(--muted);
    }

    .legend-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .legend-label {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }

    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 3px;
      flex: 0 0 auto;
    }

    .swatch.breaking {
      background: var(--red);
    }

    .swatch.safe {
      background: var(--green);
    }

    .kind-bars {
      display: grid;
      gap: 11px;
      min-width: 0;
    }

    .kind-row {
      display: grid;
      gap: 6px;
    }

    .kind-row-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 800;
    }

    .kind-row-head span {
      overflow-wrap: anywhere;
    }

    .kind-track {
      height: 12px;
      border-radius: 999px;
      overflow: hidden;
      background: #e8ecf3;
    }

    .kind-fill {
      width: var(--size);
      min-width: 4px;
      height: 100%;
      border-radius: inherit;
      background: var(--blue);
    }

    .kind-fill.breaking {
      background: var(--red);
    }

    .kind-fill.safe {
      background: var(--green);
    }

    .kind-fill.review {
      background: var(--amber);
    }

    .agent-panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      display: grid;
      gap: 16px;
      background: var(--panel);
    }

    .agent-panel[hidden] {
      display: none;
    }

    .pipeline {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }

    .pipeline-step {
      min-height: 94px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      display: grid;
      align-content: space-between;
      gap: 8px;
      background: #fbfcfe;
    }

    .pipeline-step span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }

    .pipeline-step strong {
      font-size: 24px;
      line-height: 1;
    }

    .pipeline-step em {
      color: var(--muted);
      font-size: 12px;
      font-style: normal;
      overflow-wrap: anywhere;
    }

    .agent-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 0.82fr);
      gap: 12px;
      align-items: start;
    }

    .agent-list {
      display: grid;
      gap: 8px;
      max-height: 420px;
      overflow: auto;
      padding-right: 4px;
    }

    .site-card,
    .pr-preview {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfe;
    }

    .site-card {
      padding: 12px;
      display: grid;
      gap: 8px;
    }

    .site-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 12px;
    }

    .site-path {
      min-width: 0;
      color: var(--ink);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    .patch-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }

    .patch-row code {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px 8px;
      background: #fff;
      overflow-wrap: anywhere;
    }

    .patch-arrow {
      color: var(--blue);
      font-weight: 800;
    }

    .pr-preview {
      overflow: hidden;
    }

    .pr-head {
      padding: 12px;
      border-bottom: 1px solid var(--line);
      display: grid;
      gap: 5px;
      background: #fff;
    }

    .pr-head strong,
    .section-title {
      color: var(--ink);
      font-size: 14px;
      font-weight: 800;
    }

    .pr-head span {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .endpoint-list {
      margin-top: 10px;
      border-top: 1px solid var(--line);
      padding-top: 8px;
    }

    .endpoint-list > summary {
      cursor: pointer;
      font-size: 12px;
      color: var(--muted);
    }

    .endpoint-items {
      display: grid;
      gap: 4px;
      margin-top: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      color: var(--muted);
    }

    .spec-warning {
      border: 1px solid rgba(164, 90, 0, 0.35);
      background: rgba(164, 90, 0, 0.07);
      color: var(--amber);
      border-radius: 8px;
      padding: 12px 14px;
      font-size: 13px;
    }

    /* The brand accent marks the mock as belonging to a vendor. It is a label,
       not an attempt to reproduce their interface. */
    .mock-screen .mock-button {
      background: var(--brand, var(--blue));
    }

    .mock-screen .mock-toolbar strong {
      border-left: 3px solid var(--brand, var(--blue));
      padding-left: 8px;
    }

    .pr-live {
      display: grid;
      gap: 6px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: #f4f8ff;
    }

    .pr-live.absent {
      background: #fbfcfe;
    }

    .pr-live-top {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .pr-state {
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      padding: 3px 9px;
      border-radius: 999px;
      background: rgba(23, 128, 61, 0.12);
      color: var(--green);
    }

    .pr-state.closed {
      background: rgba(180, 35, 24, 0.1);
      color: var(--red);
    }

    .pr-link {
      color: var(--blue);
      font-weight: 700;
      text-decoration: none;
    }

    .pr-link:hover {
      text-decoration: underline;
    }

    .pr-hint {
      color: var(--muted);
      font-size: 12px;
    }

    .pr-hint code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: #eef2f8;
      border-radius: 5px;
      padding: 1px 5px;
    }

    .site-kind {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11.5px;
      color: var(--muted);
    }

    .site-todo {
      display: grid;
      gap: 3px;
      border-left: 3px solid var(--amber);
      padding: 8px 10px;
      border-radius: 0 8px 8px 0;
      background: rgba(164, 90, 0, 0.06);
      font-size: 13px;
    }

    .site-todo strong {
      font-size: 12px;
      color: var(--amber);
    }

    .pr-section {
      margin: 14px 0 6px;
      font-size: 13px;
      font-weight: 800;
    }

    .pr-section:first-child {
      margin-top: 0;
    }

    .pr-paragraph {
      margin: 0 0 8px;
      font-size: 13px;
    }

    .pr-list {
      margin: 0 0 10px;
      padding-left: 18px;
      display: grid;
      gap: 5px;
      font-size: 13px;
    }

    .pr-list li.todo {
      list-style: none;
      margin-left: -18px;
    }

    .pr-list li.todo::before {
      content: '☐ ';
      color: var(--amber);
    }

    .pr-list code,
    .pr-paragraph code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      background: #eef2f8;
      border-radius: 5px;
      padding: 1px 5px;
    }

    .pr-body {
      margin: 0;
      max-height: 360px;
      overflow: auto;
      padding: 12px;
      color: #252b37;
      font-size: 13px;
      line-height: 1.5;
      overflow-wrap: anywhere;
      background: #fbfcfe;
    }

    .result-head {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
      padding: 2px 2px 0;
    }

    .result-head h2 {
      margin: 0;
      font-size: 20px;
      letter-spacing: 0;
    }

    .meta {
      color: var(--muted);
      font-size: 13px;
      text-align: right;
    }

    .change-list {
      display: grid;
      gap: 10px;
    }

    .change {
      padding: 14px;
      display: grid;
      gap: 10px;
      box-shadow: none;
      position: relative;
      transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
    }

    .change:hover,
    .change:focus {
      border-color: rgba(36, 87, 214, 0.42);
      box-shadow: 0 16px 36px rgba(21, 25, 35, 0.12);
      outline: none;
      transform: translateY(-1px);
      z-index: 1;
    }

    .change-top {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 12px;
    }

    .endpoint {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }

    .method,
    .pill {
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 12px;
      font-weight: 800;
      line-height: 1;
      white-space: nowrap;
    }

    .method {
      color: #fff;
      background: var(--cyan);
    }

    .path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
      font-size: 14px;
    }

    .pill {
      border: 1px solid var(--line);
      color: var(--muted);
      background: #f8fafc;
    }

    .pill.breaking {
      color: var(--red);
      background: #fff1f0;
      border-color: #ffd1cc;
    }

    .pill.safe {
      color: var(--green);
      background: #edf9f0;
      border-color: #c9efd3;
    }

    .pill.medium {
      color: var(--amber);
      background: #fff8e8;
      border-color: #ffe2a8;
    }

    .kind {
      color: var(--blue);
      font-weight: 800;
      overflow-wrap: anywhere;
    }

    .detail {
      color: var(--muted);
      margin: 0;
      overflow-wrap: anywhere;
    }

    .preview {
      display: none;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fbfcfe;
      box-shadow: inset 3px 0 0 var(--blue);
    }

    .change:hover .preview,
    .change:focus .preview {
      display: grid;
      gap: 10px;
    }

    .preview-title {
      color: var(--ink);
      font-size: 13px;
      font-weight: 800;
    }

    .preview-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .preview-column {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      min-width: 0;
      background: #fff;
    }

    .preview-column span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }

    .preview-column code {
      display: block;
      margin-top: 6px;
      color: var(--ink);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .preview-column.after {
      border-color: #c9efd3;
      background: #f6fff8;
    }

    .preview-column.before {
      border-color: #ffd1cc;
      background: #fff8f7;
    }

    .preview-note {
      color: var(--muted);
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    .preview-tokens {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }

    .preview-token {
      border: 1px solid #c9efd3;
      border-radius: 999px;
      padding: 4px 8px;
      color: var(--green);
      background: #fff;
      font-size: 12px;
      font-weight: 800;
      overflow-wrap: anywhere;
    }

    .usage-preview {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 10px;
    }

    .usage-block {
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: #fff;
      min-width: 0;
    }

    .usage-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 34px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      background: #f8fafc;
    }

    /* Before and After sit side by side, because a comparison you have to
       scroll between is not a comparison. Collapses to one column when narrow. */
    .code-compare {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0;
    }

    .code-cell {
      border-right: 1px solid var(--line);
      display: flex;
      flex-direction: column;
    }

    .code-cell:last-child {
      border-right: 0;
    }

    .phase-caption {
      padding: 7px 10px 0;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .code-sample {
      margin: 0;
      padding: 10px;
      min-height: 82px;
      flex: 1;
      color: #252b37;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: #fbfcfe;
    }

    .code-sample.before {
      box-shadow: inset 3px 0 0 var(--red);
    }

    .code-sample.after {
      box-shadow: inset 3px 0 0 var(--green);
    }

    .mock-compare {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }

    .mock-screen {
      min-height: 118px;
      border-right: 1px solid var(--line);
      background: #fbfcfe;
    }

    .mock-screen:last-child {
      border-right: 0;
    }

    .mock-toolbar {
      min-height: 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 10px;
      border-bottom: 1px solid var(--line);
      background: #fff;
    }

    .mock-toolbar strong {
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .mock-badge {
      border-radius: 999px;
      padding: 3px 7px;
      font-size: 11px;
      font-weight: 800;
      white-space: nowrap;
      background: #eef2ff;
      color: var(--blue);
    }

    .mock-badge.success {
      color: var(--green);
      background: #edf9f0;
    }

    .mock-badge.warning {
      color: var(--amber);
      background: #fff8e8;
    }

    .mock-badge.error {
      color: var(--red);
      background: #fff1f0;
    }

    .mock-body {
      display: grid;
      gap: 8px;
      padding: 10px;
    }

    .mock-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 28px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px 8px;
      background: #fff;
      color: var(--muted);
      font-size: 12px;
    }

    .mock-row strong {
      color: var(--ink);
      overflow-wrap: anywhere;
      text-align: right;
    }

    .mock-button {
      min-height: 32px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      padding: 0 10px;
      color: #fff;
      background: var(--blue);
      font-size: 12px;
      font-weight: 800;
    }

    .mock-button.disabled {
      color: var(--muted);
      background: #e8ecf3;
    }

    .empty,
    .error {
      min-height: 240px;
      display: grid;
      place-items: center;
      text-align: center;
      padding: 24px;
      border: 1px dashed var(--line);
      border-radius: 8px;
      color: var(--muted);
      background: #fff;
    }

    .error {
      border-color: #ffd1cc;
      color: var(--red);
      background: #fff7f6;
    }

    @media (max-width: 820px) {
      main {
        grid-template-columns: 1fr;
      }

      .topbar,
      .result-head,
      .actions {
        align-items: stretch;
      }

      .topbar,
      .result-head {
        flex-direction: column;
      }

      .chart-grid,
      .version-flow,
      .agent-grid,
      .pipeline {
        grid-template-columns: 1fr;
      }

      .flow {
        min-width: 0;
        width: 100%;
      }

      .arrow {
        width: 2px;
        height: 34px;
      }

      .arrow::after {
        right: 50%;
        top: auto;
        bottom: -1px;
        transform: translateX(50%) rotate(135deg);
      }

      .meta {
        text-align: left;
      }
    }

    @media (max-width: 460px) {
      .summary {
        grid-template-columns: 1fr;
      }

      .actions {
        flex-direction: column;
      }

      button {
        width: 100%;
      }

      .preview-grid {
        grid-template-columns: 1fr;
      }

      .usage-preview {
        grid-template-columns: 1fr;
      }

      /* Too narrow to sit side by side, so stack and swap the divider back to
         a horizontal one. */
      .code-compare,
      .mock-compare {
        grid-template-columns: 1fr;
      }

      .code-cell,
      .mock-screen {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }

      .code-cell:last-child,
      .mock-screen:last-child {
        border-bottom: 0;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="topbar">
        <div class="brand">
          <div class="mark" aria-hidden="true">AS</div>
          <h1>APIShift</h1>
        </div>
        <div class="status"><span class="dot" aria-hidden="true"></span><span>Local server online</span></div>
      </div>
    </header>

    <main>
      <section class="panel" aria-label="Spec inputs">
        <div class="control">
          <label for="oldSpec">Old spec</label>
          <input id="oldSpec" value="${DEMO_OLD_SPEC}" spellcheck="false">
        </div>
        <div class="control">
          <label for="newSpec">New spec</label>
          <input id="newSpec" value="${DEMO_NEW_SPEC}" spellcheck="false">
        </div>
        <div class="control">
          <label for="repoPath">Codebase</label>
          <input id="repoPath" value="${DEMO_CODEBASE}" spellcheck="false">
        </div>
        <div class="actions">
          <button id="runButton" type="button">Run diff</button>
          <button id="agentButton" type="button">Run update agent</button>
          <button id="fixDemoButton" class="ghost" type="button">Fix demo app</button>
          <button id="stripeButton" class="ghost" type="button">Stripe API</button>
          <button id="demoButton" class="ghost" type="button">Demo specs</button>
        </div>
        <div class="summary" aria-live="polite">
          <div class="metric"><span>Total</span><strong id="totalCount">0</strong></div>
          <div class="metric"><span>Breaking</span><strong id="breakingCount">0</strong></div>
          <div class="metric"><span>Safe</span><strong id="safeCount">0</strong></div>
          <div class="metric"><span>High confidence</span><strong id="highCount">0</strong></div>
        </div>
        <div class="visual" id="visualBar" style="--break: 0fr; --safe: 1fr;" aria-hidden="true">
          <div></div>
          <div></div>
        </div>
      </section>

      <section class="results" aria-label="Diff results">
        <div class="spec-warning" id="specWarning" role="status" hidden></div>
        <div class="result-head">
          <h2>Changes</h2>
          <div class="meta" id="meta">Waiting for a diff</div>
        </div>
        <div class="agent-panel" id="agentPanel" hidden>
          <div class="pipeline" id="pipeline"></div>
          <div class="agent-grid">
            <div>
              <div class="section-title">Affected code</div>
              <div class="agent-list" id="agentList"></div>
            </div>
            <div class="pr-preview">
              <div class="pr-head">
                <strong id="prTitle">PR preview</strong>
                <span id="prBranch">No branch yet</span>
              </div>
              <div class="pr-live" id="prLive" hidden></div>
              <pre class="pr-body" id="prBody"></pre>
            </div>
          </div>
        </div>
        <div class="overview" id="overview" aria-label="Visual change overview">
          <div class="version-flow">
            <div class="version-node">
              <span>Old</span>
              <strong id="oldVersionLabel">-</strong>
              <em id="oldSourceLabel">-</em>
            </div>
            <div class="flow">
              <div class="arrow" aria-hidden="true"></div>
              <span id="flowLabel">0 changes</span>
            </div>
            <div class="version-node">
              <span>New</span>
              <strong id="newVersionLabel">-</strong>
              <em id="newSourceLabel">-</em>
            </div>
          </div>
          <div class="chart-grid">
            <div class="impact-chart">
              <div class="donut" id="impactDonut" style="--breakAngle: 0deg;">
                <strong id="impactPercent">0%</strong>
              </div>
              <div class="legend">
                <div class="legend-row">
                  <span class="legend-label"><span class="swatch breaking"></span>Breaking</span>
                  <strong id="legendBreaking">0</strong>
                </div>
                <div class="legend-row">
                  <span class="legend-label"><span class="swatch safe"></span>Safe</span>
                  <strong id="legendSafe">0</strong>
                </div>
              </div>
            </div>
            <div class="kind-bars" id="kindBars"></div>
          </div>
        </div>
        <div id="results" class="empty">No diff loaded</div>
      </section>
    </main>
  </div>

  <script>
    const presets = {
      fixDemo: {
        oldSpec: ${JSON.stringify(DEMO_OLD_SPEC)},
        newSpec: ${JSON.stringify(DEMO_NEW_SPEC)},
        repoPath: ${JSON.stringify(DEMO_CODEBASE)}
      },
      stripe: {
        oldSpec: ${JSON.stringify(STRIPE_OLD_SPEC)},
        newSpec: ${JSON.stringify(STRIPE_NEW_SPEC)},
        repoPath: ${JSON.stringify(DEMO_CODEBASE)}
      },
      demo: {
        oldSpec: ${JSON.stringify(DEMO_OLD_SPEC)},
        newSpec: ${JSON.stringify(DEMO_NEW_SPEC)},
        repoPath: ${JSON.stringify(DEMO_CODEBASE)}
      }
    };

    const oldInput = document.querySelector('#oldSpec');
    const newInput = document.querySelector('#newSpec');
    const repoInput = document.querySelector('#repoPath');
    const runButton = document.querySelector('#runButton');
    const agentButton = document.querySelector('#agentButton');
    const fixDemoButton = document.querySelector('#fixDemoButton');
    const stripeButton = document.querySelector('#stripeButton');
    const demoButton = document.querySelector('#demoButton');
    const results = document.querySelector('#results');
    const meta = document.querySelector('#meta');
    const agentPanel = document.querySelector('#agentPanel');
    const pipeline = document.querySelector('#pipeline');
    const agentList = document.querySelector('#agentList');
    const prTitle = document.querySelector('#prTitle');
    const prBranch = document.querySelector('#prBranch');
    const prBody = document.querySelector('#prBody');
    const oldVersionLabel = document.querySelector('#oldVersionLabel');
    const newVersionLabel = document.querySelector('#newVersionLabel');
    const oldSourceLabel = document.querySelector('#oldSourceLabel');
    const newSourceLabel = document.querySelector('#newSourceLabel');
    const flowLabel = document.querySelector('#flowLabel');
    const impactDonut = document.querySelector('#impactDonut');
    const impactPercent = document.querySelector('#impactPercent');
    const legendBreaking = document.querySelector('#legendBreaking');
    const legendSafe = document.querySelector('#legendSafe');
    const kindBars = document.querySelector('#kindBars');
    const visualBar = document.querySelector('#visualBar');
    const totalCount = document.querySelector('#totalCount');
    const breakingCount = document.querySelector('#breakingCount');
    const safeCount = document.querySelector('#safeCount');
    const highCount = document.querySelector('#highCount');

    function setText(node, value) {
      node.textContent = String(value);
    }

    function setCounts(summary) {
      setText(totalCount, summary.total);
      setText(breakingCount, summary.breaking);
      setText(safeCount, summary.nonBreaking);
      setText(highCount, summary.confidence.high);
      const total = Math.max(summary.total, 1);
      visualBar.style.setProperty('--break', String(summary.breaking / total) + 'fr');
      visualBar.style.setProperty('--safe', String(summary.nonBreaking / total) + 'fr');
    }

    function pipelineStep(label, value, detail) {
      const step = document.createElement('div');
      step.className = 'pipeline-step';

      const caption = document.createElement('span');
      caption.textContent = label;

      const number = document.createElement('strong');
      number.textContent = String(value);

      const note = document.createElement('em');
      note.textContent = detail;

      step.append(caption, number, note);
      return step;
    }

    function sourceLabel(source) {
      try {
        const url = new URL(source);
        const parts = url.pathname.split('/').filter(Boolean);
        return url.hostname + '/' + parts.slice(-3).join('/');
      } catch {
        const parts = source.split('/').filter(Boolean);
        return parts.slice(-3).join('/') || source;
      }
    }

    function impactOfKind(kind) {
      if (kind.includes('removed') || kind.includes('required') || kind.includes('renamed') || kind.includes('type.changed')) {
        return 'breaking';
      }
      if (kind.includes('added')) {
        return 'safe';
      }
      return 'review';
    }

    function renderKindBars(kinds, total) {
      const rows = kinds.map(({ kind, count }) => {
        const row = document.createElement('div');
        row.className = 'kind-row';

        const head = document.createElement('div');
        head.className = 'kind-row-head';

        const label = document.createElement('span');
        label.textContent = kind;

        const value = document.createElement('strong');
        value.textContent = String(count);

        const track = document.createElement('div');
        track.className = 'kind-track';

        const fill = document.createElement('div');
        fill.className = 'kind-fill ' + impactOfKind(kind);
        fill.style.setProperty('--size', String(Math.max((count / Math.max(total, 1)) * 100, 1)) + '%');

        head.append(label, value);
        track.append(fill);
        row.append(head, track);
        return row;
      });

      if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No change categories';
        kindBars.replaceChildren(empty);
        return;
      }

      kindBars.replaceChildren(...rows);
    }

    function setOverview(payload) {
      const { diff, summary } = payload;
      const total = Math.max(summary.total, 1);
      const breakingPercent = Math.round((summary.breaking / total) * 100);
      const breakAngle = (summary.breaking / total) * 360;

      setText(oldVersionLabel, diff.oldVersion);
      setText(newVersionLabel, diff.newVersion);
      setText(oldSourceLabel, sourceLabel(diff.oldSource));
      setText(newSourceLabel, sourceLabel(diff.newSource));
      setText(flowLabel, summary.total === 1 ? '1 change' : summary.total + ' changes');
      setText(impactPercent, breakingPercent + '%');
      setText(legendBreaking, summary.breaking);
      setText(legendSafe, summary.nonBreaking);
      impactDonut.style.setProperty('--breakAngle', String(breakAngle) + 'deg');
      renderKindBars(summary.kinds, summary.total);
    }

    function endpointLabel(change) {
      return (change.method ? change.method.toUpperCase() + ' ' : '') + change.path;
    }

    function humanize(value) {
      return String(value || 'item')
        .replace(/\\[\\]/g, '')
        .replace(/[{}]/g, '')
        .split(/[._/-]+/)
        .filter(Boolean)
        .slice(-3)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
    }

    function fieldName(change) {
      const target = change.target || {};
      const found = target.to || target.from || change.detail.split(' ')[0] || 'value';
      return found;
    }

    /**
     * The vendor for the diff on screen. The preview is a mockup of YOUR app
     * against their API, not a replica of their product, so it borrows the
     * brand accent and name and nothing else.
     */
    var currentVendor = { name: 'this API', accent: '#2457d6', domain: 'generic', recognized: false };

    var SCREEN_BY_DOMAIN = {
      payments: 'Checkout screen',
      messaging: 'Message view',
      music: 'Player screen',
      code: 'Repository view',
      observability: 'Incident view',
      infrastructure: 'Resource view',
      ai: 'Completion view',
      generic: 'Customer app'
    };

    function appTitle(change) {
      const path = change.path.toLowerCase();
      const screen = SCREEN_BY_DOMAIN[currentVendor.domain] || 'Customer app';

      // A recognised vendor names the integration, so it is obvious whose API
      // this is without pretending to be their own site.
      if (currentVendor.recognized) return 'Your ' + currentVendor.name + ' integration';

      if (path.includes('drive')) return 'File manager';
      if (path.includes('blog')) return 'Blog dashboard';
      if (path.includes('analytics') || path.includes('management')) return 'Analytics dashboard';
      if (path.includes('charge') || path.includes('payment') || path.includes('balance')) return 'Payments dashboard';
      if (path.includes('account')) return 'Account settings';
      return screen;
    }

    function firstToken(tokens, fallback) {
      return tokens.length > 0 ? tokens[0] : fallback;
    }

    function valuesAfterPhrase(detail, phrase) {
      const index = detail.indexOf(phrase);
      if (index === -1) return [];
      return detail
        .slice(index + phrase.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    }

    function fieldBeforePhrase(detail, phrase, fallback) {
      const index = detail.indexOf(phrase);
      if (index === -1) return fallback;
      return detail.slice(0, index).trim() || fallback;
    }

    function previewModel(change) {
      const target = change.target || {};
      const endpoint = endpointLabel(change);

      if (change.kind === 'operation.added') {
        return {
          title: 'Endpoint added',
          before: 'Not available in the old API',
          after: endpoint,
          note: 'This is a new call the updated API exposes.',
          tokens: []
        };
      }

      if (change.kind === 'enum.value.added') {
        const phrase = ' can now return ';
        const field = fieldBeforePhrase(change.detail, phrase, target.to || target.from || 'value');
        const tokens = valuesAfterPhrase(change.detail, phrase);
        return {
          title: 'New possible value',
          before: field + ' returned the old value set',
          after: field + ' can now also be one of these values',
          note: endpoint,
          tokens
        };
      }

      if (change.kind === 'enum.value.removed') {
        const phrase = ' no longer returns ';
        const field = fieldBeforePhrase(change.detail, phrase, target.from || target.to || 'value');
        const tokens = valuesAfterPhrase(change.detail, phrase);
        return {
          title: 'Possible value removed',
          before: field + ' could return these values',
          after: field + ' no longer returns them',
          note: endpoint,
          tokens
        };
      }

      if (change.kind.includes('added.required')) {
        const location = target.location ? target.location + ': ' : '';
        const type = target.toType ? ' (' + target.toType + ')' : '';
        return {
          title: 'Required input added',
          before: 'No required ' + location + (target.to || 'input'),
          after: location + (target.to || change.detail) + type + ' is now required',
          note: endpoint,
          tokens: []
        };
      }

      if (change.kind.includes('renamed')) {
        return {
          title: 'Name changed',
          before: target.from || change.path,
          after: target.to || change.detail,
          note: endpoint,
          tokens: []
        };
      }

      if (change.kind.includes('type.changed')) {
        return {
          title: 'Type changed',
          before: (target.from || 'field') + ': ' + (target.fromType || 'old type'),
          after: (target.to || target.from || 'field') + ': ' + (target.toType || 'new type'),
          note: endpoint,
          tokens: []
        };
      }

      if (change.kind.includes('removed')) {
        return {
          title: 'Removed from new API',
          before: target.from || endpoint,
          after: 'Not available in the new API',
          note: change.detail,
          tokens: []
        };
      }

      if (change.kind.includes('added')) {
        return {
          title: 'Added to new API',
          before: 'Not present in the old API',
          after: target.to || endpoint,
          note: change.detail,
          tokens: []
        };
      }

      return {
        title: 'Change preview',
        before: 'Old API behavior',
        after: 'New API behavior',
        note: change.detail,
        tokens: []
      };
    }

    function previewColumn(label, value, className) {
      const column = document.createElement('div');
      column.className = 'preview-column ' + className;

      const caption = document.createElement('span');
      caption.textContent = label;

      const code = document.createElement('code');
      code.textContent = value;

      column.append(caption, code);
      return column;
    }

    function usageModel(change, preview) {
      const target = change.target || {};
      const endpoint = endpointLabel(change);
      const field = humanize(fieldName(change));
      const rawField = fieldName(change);
      const sampleToken = firstToken(preview.tokens, 'new_value');
      const title = appTitle(change);

      if (change.kind === 'operation.added') {
        return {
          codeBefore: '// No API call existed yet\\nshowUnavailableState();',
          codeAfter: 'await api.request("' + endpoint + '");\\nshowSuccessState();',
          before: {
            title,
            badge: 'Before',
            badgeClass: 'warning',
            rows: [['Feature', 'Unavailable'], ['Action', 'Hidden']],
            action: { text: humanize(change.path), disabled: true }
          },
          after: {
            title,
            badge: 'After',
            badgeClass: 'success',
            rows: [['Feature', humanize(change.path)], ['API call', endpoint]],
            action: { text: 'Use new action', disabled: false }
          }
        };
      }

      if (change.kind === 'operation.removed') {
        return {
          codeBefore: 'await api.request("' + endpoint + '");\\nrenderResult(data);',
          codeAfter: '// Endpoint removed\\nshowUnavailableState();',
          before: {
            title,
            badge: 'Works',
            badgeClass: 'success',
            rows: [['Action', humanize(change.path)], ['Status', 'Available']],
            action: { text: 'Run action', disabled: false }
          },
          after: {
            title,
            badge: 'Removed',
            badgeClass: 'error',
            rows: [['Action', humanize(change.path)], ['Status', 'Unavailable']],
            action: { text: 'Unavailable', disabled: true }
          }
        };
      }

      if (change.kind === 'enum.value.added') {
        return {
          codeBefore: 'switch (' + rawField + ') {\\n  default: showUnknownState();\\n}',
          codeAfter: 'case "' + sampleToken + '":\\n  showBadge("' + humanize(sampleToken) + '");\\n  break;',
          before: {
            title,
            badge: 'Unexpected',
            badgeClass: 'warning',
            rows: [[field, sampleToken], ['UI state', 'Unknown value']],
            action: { text: 'Needs handling', disabled: true }
          },
          after: {
            title,
            badge: 'Handled',
            badgeClass: 'success',
            rows: [[field, sampleToken], ['UI state', humanize(sampleToken)]],
            action: { text: 'Display normally', disabled: false }
          }
        };
      }

      if (change.kind === 'enum.value.removed') {
        const removedValue = firstToken(preview.tokens, 'old_value');
        return {
          codeBefore: 'if (' + rawField + ' === "' + removedValue + '") {\\n  show' + humanize(removedValue).replace(/\\s/g, '') + '();\\n}',
          codeAfter: '// Value no longer appears\\nremoveOldUiBranch();',
          before: {
            title,
            badge: 'Before',
            badgeClass: 'success',
            rows: [[field, removedValue], ['UI state', humanize(removedValue)]],
            action: { text: 'Old option shown', disabled: false }
          },
          after: {
            title,
            badge: 'After',
            badgeClass: 'warning',
            rows: [[field, 'No longer returned'], ['UI state', 'Old option removed']],
            action: { text: 'Option hidden', disabled: true }
          }
        };
      }

      if (change.kind.includes('renamed')) {
        const beforeName = target.from || rawField;
        const afterName = target.to || rawField;
        return {
          codeBefore: 'const value = response.' + beforeName + ';\\nrender(value);',
          codeAfter: 'const value = response.' + afterName + ';\\nrender(value);',
          before: {
            title,
            badge: 'Old name',
            badgeClass: 'warning',
            rows: [[humanize(beforeName), 'Used by UI'], ['Result', 'May break after update']],
            action: { text: 'Old data binding', disabled: false }
          },
          after: {
            title,
            badge: 'New name',
            badgeClass: 'success',
            rows: [[humanize(afterName), 'Used by UI'], ['Result', 'Renders again']],
            action: { text: 'Updated binding', disabled: false }
          }
        };
      }

      if (change.kind.includes('type.changed')) {
        return {
          codeBefore: 'const value = response.' + rawField + ';\\nrenderText(value);',
          codeAfter: 'const value = Number(response.' + rawField + ');\\nrenderNumber(value);',
          before: {
            title,
            badge: 'Old type',
            badgeClass: 'warning',
            rows: [[field, target.fromType || 'old type'], ['UI formatter', 'Text']],
            action: { text: 'Old formatter', disabled: false }
          },
          after: {
            title,
            badge: 'New type',
            badgeClass: 'success',
            rows: [[field, target.toType || 'new type'], ['UI formatter', 'Updated']],
            action: { text: 'Correct formatter', disabled: false }
          }
        };
      }

      if (change.kind.includes('removed')) {
        const removed = target.from || rawField;
        return {
          codeBefore: 'render(response.' + removed + ');',
          codeAfter: 'renderFallback();\\n// ' + removed + ' is gone',
          before: {
            title,
            badge: 'Before',
            badgeClass: 'success',
            rows: [[humanize(removed), 'Visible'], ['Screen', 'Complete data']],
            action: { text: 'Show field', disabled: false }
          },
          after: {
            title,
            badge: 'Missing',
            badgeClass: 'error',
            rows: [[humanize(removed), 'Missing'], ['Screen', 'Fallback needed']],
            action: { text: 'Needs fallback', disabled: true }
          }
        };
      }

      if (change.kind.includes('added.required')) {
        const required = target.to || rawField;
        return {
          codeBefore: 'await api.request("' + endpoint + '", payload);',
          codeAfter: 'await api.request("' + endpoint + '", {\\n  ...payload,\\n  "' + required + '": value\\n});',
          before: {
            title,
            badge: 'Missing',
            badgeClass: 'error',
            rows: [[humanize(required), 'Not sent'], ['Submit', 'Can fail']],
            action: { text: 'Submit blocked', disabled: true }
          },
          after: {
            title,
            badge: 'Included',
            badgeClass: 'success',
            rows: [[humanize(required), 'Provided'], ['Submit', 'Ready']],
            action: { text: 'Submit', disabled: false }
          }
        };
      }

      return {
        codeBefore: 'renderOldApiResponse();',
        codeAfter: 'renderUpdatedApiResponse();',
        before: {
          title,
          badge: 'Before',
          badgeClass: 'warning',
          rows: [['API data', 'Old shape'], ['Screen', 'Existing UI']],
          action: { text: 'Old behavior', disabled: false }
        },
        after: {
          title,
          badge: 'After',
          badgeClass: 'success',
          rows: [['API data', 'New shape'], ['Screen', 'Updated UI']],
          action: { text: 'New behavior', disabled: false }
        }
      };
    }

    function phaseCaption(phase) {
      const caption = document.createElement('div');
      caption.className = 'phase-caption';
      caption.textContent = phase;
      return caption;
    }

    /** One side of the code comparison, captioned so it is never ambiguous. */
    function codeCell(phase, source, variant) {
      const cell = document.createElement('div');
      cell.className = 'code-cell';

      const sample = document.createElement('pre');
      sample.className = 'code-sample ' + variant;
      sample.textContent = source;

      cell.append(phaseCaption(phase), sample);
      return cell;
    }

    function mockScreen(model, phase) {
      const screen = document.createElement('div');
      screen.className = 'mock-screen';
      screen.style.setProperty('--brand', currentVendor.accent);

      const toolbar = document.createElement('div');
      toolbar.className = 'mock-toolbar';

      const title = document.createElement('strong');
      title.textContent = model.title;

      const badge = document.createElement('span');
      badge.className = 'mock-badge ' + model.badgeClass;
      badge.textContent = model.badge;

      const body = document.createElement('div');
      body.className = 'mock-body';

      const rows = model.rows.map(([label, value]) => {
        const row = document.createElement('div');
        row.className = 'mock-row';

        const key = document.createElement('span');
        key.textContent = label;

        const val = document.createElement('strong');
        val.textContent = value;

        row.append(key, val);
        return row;
      });

      const action = document.createElement('div');
      action.className = 'mock-button' + (model.action.disabled ? ' disabled' : '');
      action.textContent = model.action.text;

      toolbar.append(title, badge);
      body.append(...rows, action);
      screen.append(phaseCaption(phase), toolbar, body);
      return screen;
    }

    function renderUsagePreview(change, preview) {
      const model = usageModel(change, preview);
      const usage = document.createElement('div');
      usage.className = 'usage-preview';

      const code = document.createElement('div');
      code.className = 'usage-block';

      const codeHead = document.createElement('div');
      codeHead.className = 'usage-head';
      codeHead.textContent = 'Developer code';

      const codeCompare = document.createElement('div');
      codeCompare.className = 'code-compare';

      codeCompare.append(
        codeCell('Before', model.codeBefore, 'before'),
        codeCell('After', model.codeAfter, 'after')
      );
      code.append(codeHead, codeCompare);

      const mock = document.createElement('div');
      mock.className = 'usage-block';

      const mockHead = document.createElement('div');
      mockHead.className = 'usage-head';
      mockHead.textContent = 'Website view';

      const mockCompare = document.createElement('div');
      mockCompare.className = 'mock-compare';
      mockCompare.append(mockScreen(model.before, 'Before'), mockScreen(model.after, 'After'));

      mock.append(mockHead, mockCompare);
      usage.append(code, mock);
      return usage;
    }

    function renderPreview(change) {
      const model = previewModel(change);
      const preview = document.createElement('div');
      preview.className = 'preview';

      const title = document.createElement('div');
      title.className = 'preview-title';
      title.textContent = model.title;

      const grid = document.createElement('div');
      grid.className = 'preview-grid';
      grid.append(
        previewColumn('Before', model.before, 'before'),
        previewColumn('After', model.after, 'after')
      );

      const note = document.createElement('div');
      note.className = 'preview-note';
      note.textContent = model.note;

      preview.append(title, grid);

      if (model.tokens.length > 0) {
        const tokens = document.createElement('div');
        tokens.className = 'preview-tokens';
        tokens.append(...model.tokens.map((value) => {
          const token = document.createElement('span');
          token.className = 'preview-token';
          token.textContent = value;
          return token;
        }));
        preview.append(tokens);
      }

      preview.append(note);
      preview.append(renderUsagePreview(change, model));
      return preview;
    }

    /** One row per distinct change, carrying the endpoints it touches. */
    function renderGroupedChange(group) {
      const card = renderChange(group.representative);
      const endpoints = renderEndpoints(group);
      if (endpoints) card.append(endpoints);
      return card;
    }

    function renderChange(change) {
      const item = document.createElement('article');
      item.className = 'change';
      item.tabIndex = 0;

      const top = document.createElement('div');
      top.className = 'change-top';

      const endpoint = document.createElement('div');
      endpoint.className = 'endpoint';

      if (change.method) {
        const method = document.createElement('span');
        method.className = 'method';
        method.textContent = change.method.toUpperCase();
        endpoint.append(method);
      }

      const path = document.createElement('span');
      path.className = 'path';
      path.textContent = change.path;
      endpoint.append(path);

      const impact = document.createElement('span');
      impact.className = 'pill ' + (change.breaking ? 'breaking' : 'safe');
      impact.textContent = change.breaking ? 'Breaking' : 'Safe';

      top.append(endpoint, impact);

      const kind = document.createElement('div');
      kind.className = 'kind';
      kind.textContent = change.kind;

      const detail = document.createElement('p');
      detail.className = 'detail';
      detail.textContent = change.detail;

      const confidence = document.createElement('span');
      confidence.className = 'pill ' + change.confidence;
      confidence.textContent = change.confidence + ' confidence';

      item.append(top, kind, detail, confidence, renderPreview(change));
      return item;
    }

    /**
     * One affected location. Two cards can share a file, line, and column when
     * two separate spec changes hit the same call, so each card names the change
     * it belongs to. Without that they read as an accidental duplicate.
     */
    function renderAgentEdit(edit, change) {
      const card = document.createElement('article');
      card.className = 'site-card';

      const head = document.createElement('div');
      head.className = 'site-head';

      const path = document.createElement('div');
      path.className = 'site-path';
      path.textContent = edit.site.file + ':' + edit.site.line + ':' + edit.site.column;

      const pill = document.createElement('span');
      pill.className = 'pill ' + (edit.action === 'apply' ? 'safe' : 'medium');
      pill.textContent = edit.action === 'apply' ? 'Auto patch' : 'Needs you';

      const kind = document.createElement('div');
      kind.className = 'site-kind';
      kind.textContent = change ? change.kind : edit.strategy;

      const reason = document.createElement('p');
      reason.className = 'detail';
      reason.textContent = edit.reasoning;

      head.append(path, pill);
      card.append(head, kind, reason);

      if (edit.after) {
        // A real mechanical edit, so show the actual before and after.
        const patch = document.createElement('div');
        patch.className = 'patch-row';

        const before = document.createElement('code');
        before.textContent = edit.before;

        const arrow = document.createElement('span');
        arrow.className = 'patch-arrow';
        arrow.textContent = '->';

        const after = document.createElement('code');
        after.textContent = edit.after;

        patch.append(before, arrow, after);
        card.append(patch);
        return card;
      }

      // No safe mechanical fix exists, so say what to do rather than render a
      // before and after that does not exist.
      const todo = document.createElement('div');
      todo.className = 'site-todo';

      const label = document.createElement('strong');
      label.textContent = 'Your call';

      const what = document.createElement('span');
      what.textContent = change
        ? change.detail + '. Decide how this code should handle it.'
        : 'Decide how this code should handle it.';

      todo.append(label, what);
      card.append(todo);
      return card;
    }

    /** Inline code spans, so \`file.ts:5\` reads as code rather than backticks. */
    function withInlineCode(text, into) {
      const parts = text.split('\`');
      parts.forEach((part, index) => {
        if (part.length === 0) return;
        if (index % 2 === 1) {
          const code = document.createElement('code');
          code.textContent = part;
          into.append(code);
        } else {
          into.append(document.createTextNode(part));
        }
      });
    }

    /**
     * A deliberately small markdown renderer for the pull request body. It only
     * needs the shapes we actually emit: headings, bullets, and checkboxes.
     * Showing the raw text meant readers saw literal ## characters.
     */
    function renderPrBody(markdown) {
      const nodes = [];
      let list = null;

      for (const line of markdown.split('\\n')) {
        if (line.startsWith('## ')) {
          list = null;
          const heading = document.createElement('h3');
          heading.className = 'pr-section';
          heading.textContent = line.slice(3);
          nodes.push(heading);
          continue;
        }

        const checkbox = line.startsWith('- [ ] ');
        if (line.startsWith('- ') || checkbox) {
          if (!list) {
            list = document.createElement('ul');
            list.className = 'pr-list';
            nodes.push(list);
          }
          const item = document.createElement('li');
          if (checkbox) item.className = 'todo';
          withInlineCode(line.slice(checkbox ? 6 : 2), item);
          list.append(item);
          continue;
        }

        list = null;
        if (line.trim().length === 0) continue;

        const paragraph = document.createElement('p');
        paragraph.className = 'pr-paragraph';
        withInlineCode(line, paragraph);
        nodes.push(paragraph);
      }

      prBody.replaceChildren(...nodes);
    }

    function renderAgent(payload) {
      if (payload.vendor) currentVendor = payload.vendor;
      const applied = payload.edits.filter((edit) => edit.action === 'apply');
      const review = payload.edits.filter((edit) => edit.action === 'review');

      pipeline.replaceChildren(
        pipelineStep('Detect', payload.summary.breaking, payload.summary.total + ' vendor changes'),
        pipelineStep('Scan', payload.sites.length, payload.repoPath),
        pipelineStep('Patch', applied.length, payload.pr.filesChanged + ' files'),
        pipelineStep('Review', review.length, 'PR checklist')
      );

      if (payload.edits.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No affected code found in this codebase';
        agentList.replaceChildren(empty);
      } else {
        const changeById = new Map(payload.diff.changes.map((change) => [change.id, change]));
        agentList.replaceChildren(
          ...payload.edits.map((edit) => renderAgentEdit(edit, changeById.get(edit.changeId)))
        );
      }

      prTitle.textContent = payload.pr.title;
      prBranch.textContent = payload.pr.branch;
      renderPrBody(payload.pr.body);
      agentPanel.hidden = false;
    }

    /** Leaf of a dotted pointer, so entries[].fields[].type becomes type. */
    function leafOf(pointer) {
      if (!pointer) return '';
      const parts = String(pointer).split('.');
      return (parts[parts.length - 1] || '').split('[]').join('');
    }

    /**
     * Two changes are the same fact when they say the same thing about the same
     * field. A vendor editing one shared schema produces a record per endpoint
     * that references it, so Box adding one enum value appeared seven times.
     */
    function groupKeyOf(change) {
      const target = change.target || {};
      const from = leafOf(target.from);
      const to = leafOf(target.to);

      let detail = change.detail || '';
      if (target.from && from) detail = detail.split(target.from).join(from);
      if (target.to && to) detail = detail.split(target.to).join(to);

      return [change.kind, change.direction || '', change.breaking ? 'b' : 's', from, to,
        target.fromType || '', target.toType || '', detail].join('|');
    }

    function endpointLabelOf(change) {
      return change.method ? change.method.toUpperCase() + ' ' + change.path : change.path;
    }

    function groupChangesForDisplay(changes) {
      const byKey = new Map();

      for (const change of changes) {
        const key = groupKeyOf(change);
        const existing = byKey.get(key);
        if (!existing) {
          byKey.set(key, { representative: change, changes: [change], endpoints: [endpointLabelOf(change)] });
          continue;
        }
        existing.changes.push(change);
        const label = endpointLabelOf(change);
        if (existing.endpoints.indexOf(label) === -1) existing.endpoints.push(label);
      }

      return Array.from(byKey.values());
    }

    /** The endpoint line for a group: one endpoint, or a count you can expand. */
    function renderEndpoints(group) {
      if (group.endpoints.length === 1) return null;

      const wrap = document.createElement('details');
      wrap.className = 'endpoint-list';

      const summary = document.createElement('summary');
      summary.textContent = group.endpoints.length + ' endpoints affected';
      wrap.append(summary);

      const list = document.createElement('div');
      list.className = 'endpoint-items';
      for (const endpoint of group.endpoints) {
        const item = document.createElement('div');
        item.textContent = endpoint;
        list.append(item);
      }

      wrap.append(list);
      return wrap;
    }

    function renderPayload(payload) {
      if (payload.vendor) currentVendor = payload.vendor;
      showWarning(payload.warning);
      setCounts(payload.summary);
      setOverview(payload);
      const generated = new Date(payload.diff.generatedAt).toLocaleString();
      const who = payload.vendor && payload.vendor.name ? payload.vendor.name + ' / ' : '';
      const groupCount = groupChangesForDisplay(payload.diff.changes).length;
      const shared = groupCount < payload.diff.changes.length
        ? ' / ' + groupCount + ' distinct'
        : '';
      meta.textContent = who + payload.diff.oldVersion + ' -> ' + payload.diff.newVersion + shared + ' / ' + generated;

      results.className = 'change-list';
      const grouped = groupChangesForDisplay(payload.diff.changes);
      results.replaceChildren(...grouped.map(renderGroupedChange));

      if (payload.diff.changes.length === 0) {
        results.className = 'empty';
        results.textContent = 'No differences found';
      }
    }

    function renderError(message) {
      setCounts({ total: 0, breaking: 0, nonBreaking: 0, confidence: { high: 0, medium: 0, low: 0 } });
      setOverview({
        diff: {
          oldVersion: '-',
          newVersion: '-',
          oldSource: oldInput.value.trim() || '-',
          newSource: newInput.value.trim() || '-',
          generatedAt: new Date().toISOString(),
          changes: []
        },
        summary: {
          total: 0,
          breaking: 0,
          nonBreaking: 0,
          confidence: { high: 0, medium: 0, low: 0 },
          kinds: []
        }
      });
      meta.textContent = 'Diff failed';
      results.className = 'error';
      results.textContent = message;
    }

    async function runDiff() {
      runButton.disabled = true;
      runButton.textContent = 'Running';
      meta.textContent = 'Running diff';
      results.className = 'empty';
      results.textContent = 'Loading';
      agentPanel.hidden = true;

      const params = new URLSearchParams({
        old: oldInput.value.trim(),
        new: newInput.value.trim()
      });

      try {
        const response = await fetch('/api/diff?' + params.toString());
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Diff failed');
        renderPayload(payload);
      } catch (error) {
        renderError(error instanceof Error ? error.message : String(error));
      } finally {
        runButton.disabled = false;
        runButton.textContent = 'Run diff';
      }
    }

    async function runAgent() {
      agentButton.disabled = true;
      agentButton.textContent = 'Running';
      meta.textContent = 'Running update agent';
      results.className = 'empty';
      results.textContent = 'Loading';

      const params = new URLSearchParams({
        old: oldInput.value.trim(),
        new: newInput.value.trim(),
        repo: repoInput.value.trim()
      });

      try {
        const response = await fetch('/api/agent?' + params.toString());
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Update agent failed');
        renderPayload(payload);
        renderAgent(payload);
      } catch (error) {
        renderError(error instanceof Error ? error.message : String(error));
      } finally {
        agentButton.disabled = false;
        agentButton.textContent = 'Run update agent';
      }
    }

    function loadPreset(preset) {
      oldInput.value = preset.oldSpec;
      newInput.value = preset.newSpec;
      repoInput.value = preset.repoPath;
      runDiff();
    }

    function loadAgentPreset(preset) {
      oldInput.value = preset.oldSpec;
      newInput.value = preset.newSpec;
      repoInput.value = preset.repoPath;
      runAgent();
    }

    fixDemoButton.addEventListener('click', () => {
      loadAgentPreset(presets.fixDemo);
    });

    stripeButton.addEventListener('click', () => {
      loadPreset(presets.stripe);
    });

    demoButton.addEventListener('click', () => {
      loadPreset(presets.demo);
    });

    const specWarning = document.querySelector('#specWarning');

    /** Say plainly when the two specs are not the same API. */
    function showWarning(message) {
      if (!message) {
        specWarning.hidden = true;
        specWarning.textContent = '';
        return;
      }
      specWarning.hidden = false;
      specWarning.textContent = message;
    }

    const prLive = document.querySelector('#prLive');

    /** Show the real pull request, or say plainly that none exists yet. */
    async function loadPullRequests() {
      let payload;
      try {
        const response = await fetch('/api/pull-requests');
        payload = await response.json();
      } catch {
        return;
      }

      prLive.replaceChildren();
      prLive.hidden = false;
      prLive.className = 'pr-live';

      if (!payload.configured) {
        prLive.classList.add('absent');
        const hint = document.createElement('div');
        hint.className = 'pr-hint';
        hint.innerHTML = 'No GitHub credentials, so this is a preview. Add <code>.env</code> to open real pull requests.';
        prLive.append(hint);
        return;
      }

      if (payload.error) {
        prLive.classList.add('absent');
        const hint = document.createElement('div');
        hint.className = 'pr-hint';
        hint.textContent = 'GitHub lookup failed: ' + payload.error;
        prLive.append(hint);
        return;
      }

      const latest = payload.pullRequests[0];

      if (!latest) {
        prLive.classList.add('absent');
        const hint = document.createElement('div');
        hint.className = 'pr-hint';
        hint.innerHTML = 'Not opened yet. Run <code>npm run demo</code> to open it on ' + (payload.repo || 'GitHub') + '.';
        prLive.append(hint);
        return;
      }

      const top = document.createElement('div');
      top.className = 'pr-live-top';

      const link = document.createElement('a');
      link.className = 'pr-link';
      link.href = latest.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = 'Pull request #' + latest.number;

      const state = document.createElement('span');
      state.className = 'pr-state' + (latest.state === 'open' ? '' : ' closed');
      state.textContent = latest.state;

      top.append(link, state);

      const hint = document.createElement('div');
      hint.className = 'pr-hint';
      hint.textContent = latest.title + ' · ' + payload.repo;

      prLive.append(top, hint);

      const earlier = payload.pullRequests.slice(1);
      if (earlier.length > 0) {
        const more = document.createElement('div');
        more.className = 'pr-hint';
        more.append(document.createTextNode('Earlier runs: '));

        earlier.forEach((pull, index) => {
          if (index > 0) more.append(document.createTextNode(', '));
          const link = document.createElement('a');
          link.className = 'pr-link';
          link.href = pull.url;
          link.target = '_blank';
          link.rel = 'noreferrer';
          link.textContent = '#' + pull.number + ' (' + pull.state + ')';
          more.append(link);
        });

        prLive.append(more);
      }
    }

    runButton.addEventListener('click', runDiff);
    agentButton.addEventListener('click', runAgent);
    runDiff();
    loadPullRequests();
  </script>
</body>
</html>`;
}

function startServer(port: number, attemptsLeft: number): void {
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 1) {
      startServer(port + 1, attemptsLeft - 1);
      return;
    }

    process.stderr.write(`Failed to start APIShift dashboard: ${error.message}\n`);
    process.exitCode = 1;
  });

  server.listen(port, DEFAULT_HOST, () => {
    const address = server.address() as AddressInfo;
    process.stdout.write(`APIShift dashboard running at http://${address.address}:${address.port}\n`);
  });
}

// Only listen when run as a program. Importing this module, which the tests do
// to syntax check the page it serves, must not bind a port.
if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  startServer(DEFAULT_PORT, MAX_PORT_ATTEMPTS);
}
