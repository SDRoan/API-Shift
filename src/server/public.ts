/**
 * The hosted, diff only APIShift.
 *
 * Deliberately a different program from the local dashboard rather than a flag
 * on it. The local one scans a codebase and can open a pull request, which is
 * exactly what must not exist on a public endpoint. Keeping them separate means
 * the dangerous routes are absent rather than merely disabled.
 *
 * What this serves:
 *   GET /               a page where you paste two spec URLs
 *   GET /api/diff       the classified diff, from public http(s) URLs only
 *   GET /api/health
 *
 * There is no filesystem access, no repository scanning, and no GitHub token.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename } from 'node:path';
import { diffLoadedSpecs } from '../differ/index.js';
import { loadSpec } from '../differ/load.js';
import { formatDiffReport } from '../differ/report.js';
import { groupChanges } from '../differ/group.js';
import { detectVendor, looksLikeDifferentApis } from '../specs/vendor.js';
import { UnsafeSpecUrlError, assertPublicHttpUrl, fetchSpecSafely } from '../specs/remote.js';
import { materializeSpec } from '../specs/source.js';
import type { ApiChange } from '../types.js';

const HOST = process.env['HOST'] ?? '0.0.0.0';
const PORT = Number.parseInt(process.env['PORT'] ?? '8080', 10);

/** One diff at a time per process keeps a shared host from being trivially exhausted. */
const MAX_CONCURRENT = Number.parseInt(process.env['APISHIFT_MAX_CONCURRENT'] ?? '2', 10);
let inFlight = 0;

const EXAMPLES = [
  {
    name: 'PagerDuty',
    note: '96 changes, only 5 breaking',
    old: 'https://raw.githubusercontent.com/PagerDuty/api-schema/1482e50ccf662760c05580ee95ff63f8ebbc7534/reference/REST/openapiv3.json',
    new: 'https://raw.githubusercontent.com/PagerDuty/api-schema/2326e6b9f4737ca7f383214e1cd9d783c81fd2c6/reference/REST/openapiv3.json',
  },
  {
    name: 'Discord',
    note: 'six weeks, exactly one change',
    old: 'https://raw.githubusercontent.com/discord/discord-api-spec/2c0a5ddffb9c9cf9b3a8826454758397a6b4804b/specs/openapi.json',
    new: 'https://raw.githubusercontent.com/discord/discord-api-spec/4e5c3dbe385cc148dde582325314e598fddbd7a9/specs/openapi.json',
  },
  {
    name: 'Box',
    note: 'one enum value across seven endpoints',
    old: 'https://raw.githubusercontent.com/box/box-openapi/58287f5b6a112b25f923679de5b0354634ea8429/openapi.json',
    new: 'https://raw.githubusercontent.com/box/box-openapi/da33b570c9fa58c3540bba5dc55e28fc8a78fd32/openapi.json',
  },
];

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // The page runs its own inline script and loads nothing else.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  });
  response.end(html);
}

interface PublicSummary {
  total: number;
  breaking: number;
  distinct: number;
  kinds: Array<{ kind: string; count: number }>;
}

function summarize(changes: ApiChange[]): PublicSummary {
  const kinds = new Map<string, number>();
  for (const change of changes) kinds.set(change.kind, (kinds.get(change.kind) ?? 0) + 1);

  return {
    total: changes.length,
    breaking: changes.filter((change) => change.breaking).length,
    distinct: groupChanges(changes).length,
    kinds: [...kinds.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
  };
}

async function handleDiff(url: URL, response: ServerResponse): Promise<void> {
  const oldSource = url.searchParams.get('old')?.trim() ?? '';
  const newSource = url.searchParams.get('new')?.trim() ?? '';

  // Refuse rather than substitute a default. Quietly analysing something the
  // caller did not ask for is worse than saying no.
  if (oldSource.length === 0 || newSource.length === 0) {
    sendJson(response, 400, { error: 'both old and new spec URLs are required' });
    return;
  }

  if (inFlight >= MAX_CONCURRENT) {
    sendJson(response, 503, { error: 'busy, try again in a moment' });
    return;
  }

  inFlight += 1;
  try {
    assertPublicHttpUrl(oldSource);
    assertPublicHttpUrl(newSource);

    // Fetched here under a byte cap and a timeout, then parsed from disk with
    // external refs disabled, so no $ref inside a stranger's spec can make this
    // server fetch anything else.
    const [before, after] = await Promise.all([fetchSpecSafely(oldSource), fetchSpecSafely(newSource)]);
    const [beforePath, afterPath] = await Promise.all([
      materializeSpec(before.text, 'old', oldSource),
      materializeSpec(after.text, 'new', newSource),
    ]);

    const [loadedOld, loadedNew] = await Promise.all([
      loadSpec(beforePath, { allowExternalRefs: false }),
      loadSpec(afterPath, { allowExternalRefs: false }),
    ]);

    const diff = diffLoadedSpecs(
      { ...loadedOld, source: oldSource },
      { ...loadedNew, source: newSource },
    );

    sendJson(response, 200, {
      diff,
      summary: summarize(diff.changes),
      vendor: detectVendor(diff.newTitle, diff.newServer),
      report: formatDiffReport(diff),
      ...(looksLikeDifferentApis(diff.oldTitle, diff.newTitle)
        ? {
            warning:
              `These look like two different APIs: "${diff.oldTitle}" against "${diff.newTitle}". ` +
              'Every endpoint of one will report as removed and every endpoint of the other as added.',
          }
        : {}),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, error instanceof UnsafeSpecUrlError ? 400 : 422, { error: message });
  } finally {
    inFlight -= 1;
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'only GET is supported' });
    return;
  }

  if (url.pathname === '/') {
    sendHtml(response, renderPage());
    return;
  }
  if (url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, name: 'apishift-public' });
    return;
  }
  if (url.pathname === '/api/diff') {
    await handleDiff(url, response);
    return;
  }
  if (url.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }

  sendJson(response, 404, { error: 'not found' });
}

export function renderPage(): string {
  const examples = JSON.stringify(EXAMPLES);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>APIShift - find breaking API changes</title>
<style>
  :root {
    --bg: #f7f8fb; --panel: #fff; --ink: #151923; --muted: #5e687a;
    --line: #dce1ea; --blue: #2457d6; --green: #17803d; --red: #b42318; --amber: #a45a00;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); line-height: 1.55;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; }
  main { max-width: 940px; margin: 0 auto; padding: 48px 20px 80px; }
  h1 { font-size: 34px; margin: 0 0 10px; letter-spacing: -0.02em; }
  .lede { font-size: 18px; color: var(--muted); margin: 0 0 8px; max-width: 60ch; }
  .fact { font-size: 15px; color: var(--muted); margin: 0 0 28px; max-width: 66ch; }
  .fact strong { color: var(--ink); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  input { width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid var(--line);
    border-radius: 8px; font: inherit; font-size: 13px; background: #fbfcfe; color: var(--ink); }
  input:focus { outline: 3px solid rgba(36,87,214,.16); border-color: var(--blue); background: #fff; }
  .row { display: grid; gap: 14px; margin-bottom: 14px; }
  button { min-height: 44px; padding: 0 20px; border: 0; border-radius: 8px; background: var(--blue);
    color: #fff; font: inherit; font-weight: 650; cursor: pointer; }
  button:disabled { opacity: .6; cursor: wait; }
  .examples { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; align-items: center; }
  .examples span { font-size: 12px; color: var(--muted); }
  .examples button { background: transparent; border: 1px solid var(--line); color: var(--muted);
    min-height: 32px; padding: 0 12px; font-weight: 500; font-size: 13px; }
  .out { margin-top: 24px; }
  .stats { display: flex; gap: 22px; flex-wrap: wrap; padding: 14px 0; border-bottom: 1px solid var(--line); }
  .stat strong { font-size: 22px; } .stat span { color: var(--muted); font-size: 13px; margin-left: 6px; }
  .breaking strong { color: var(--red); } .safe strong { color: var(--green); }
  pre { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px;
    overflow: auto; font-size: 12.5px; line-height: 1.5; max-height: 560px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .msg { padding: 14px; border-radius: 8px; font-size: 14px; }
  .err { background: rgba(180,35,24,.07); border: 1px solid rgba(180,35,24,.3); color: var(--red); }
  .warn { background: rgba(164,90,0,.07); border: 1px solid rgba(164,90,0,.3); color: var(--amber); margin-bottom: 14px; }
  footer { margin-top: 44px; padding-top: 20px; border-top: 1px solid var(--line);
    color: var(--muted); font-size: 14px; }
  a { color: var(--blue); }
  code { background: #eef2f8; border-radius: 5px; padding: 1px 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
</style>
</head>
<body>
<main>
  <h1>Did your API vendor break your code?</h1>
  <p class="lede">Paste two versions of an OpenAPI spec. APIShift classifies every change as breaking or safe.</p>
  <p class="fact">Version numbers do not tell you. Two real OpenAI specs nineteen months apart contain
    <strong>530 breaking changes while <code>info.version</code> stayed 2.3.0 on both sides</strong>.</p>

  <div class="card">
    <div class="row">
      <div>
        <label for="old">Old spec URL</label>
        <input id="old" spellcheck="false" placeholder="https://.../openapi.json">
      </div>
      <div>
        <label for="new">New spec URL</label>
        <input id="new" spellcheck="false" placeholder="https://.../openapi.json">
      </div>
    </div>
    <button id="run" type="button">Compare</button>
    <div class="examples"><span>Try one:</span><span id="examples"></span></div>
  </div>

  <div class="out" id="out"></div>

  <footer>
    This page only compares specs. To find the lines of <em>your</em> code that break and open a pull
    request that patches them, run it locally:
    <pre>npx github:SDRoan/API-Shift fix ./my-app --old &lt;old&gt; --new &lt;new&gt; --open-pr</pre>
    <a href="https://github.com/SDRoan/API-Shift">Source on GitHub</a>
  </footer>
</main>

<script>
  var EXAMPLES = ${examples};
  var oldInput = document.querySelector('#old');
  var newInput = document.querySelector('#new');
  var runButton = document.querySelector('#run');
  var out = document.querySelector('#out');
  var examples = document.querySelector('#examples');

  EXAMPLES.forEach(function (example) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = example.name;
    button.title = example.note;
    button.addEventListener('click', function () {
      oldInput.value = example.old;
      newInput.value = example.new;
      run();
    });
    examples.append(button, document.createTextNode(' '));
  });

  function message(text, kind) {
    var box = document.createElement('div');
    box.className = 'msg ' + kind;
    box.textContent = text;
    return box;
  }

  function stat(value, label, kind) {
    var wrap = document.createElement('div');
    wrap.className = 'stat ' + (kind || '');
    var strong = document.createElement('strong');
    strong.textContent = String(value);
    var span = document.createElement('span');
    span.textContent = label;
    wrap.append(strong, span);
    return wrap;
  }

  async function run() {
    var oldUrl = oldInput.value.trim();
    var newUrl = newInput.value.trim();

    if (!oldUrl || !newUrl) {
      out.replaceChildren(message('Both spec URLs are required.', 'err'));
      return;
    }

    runButton.disabled = true;
    runButton.textContent = 'Comparing';
    out.replaceChildren(message('Fetching and comparing. Large specs take a few seconds.', 'msg'));

    try {
      var response = await fetch('/api/diff?old=' + encodeURIComponent(oldUrl) + '&new=' + encodeURIComponent(newUrl));
      var payload = await response.json();

      if (payload.error) {
        out.replaceChildren(message(payload.error, 'err'));
        return;
      }

      var nodes = [];
      if (payload.warning) nodes.push(message(payload.warning, 'warn'));

      var stats = document.createElement('div');
      stats.className = 'stats';
      stats.append(
        stat(payload.summary.breaking, 'breaking', 'breaking'),
        stat(payload.summary.total - payload.summary.breaking, 'safe', 'safe'),
        stat(payload.summary.distinct, 'distinct changes')
      );
      nodes.push(stats);

      var report = document.createElement('pre');
      report.textContent = payload.report;
      nodes.push(report);

      out.replaceChildren.apply(out, nodes);
    } catch (error) {
      out.replaceChildren(message('Something went wrong: ' + error.message, 'err'));
    } finally {
      runButton.disabled = false;
      runButton.textContent = 'Compare';
    }
  }

  runButton.addEventListener('click', run);
</script>
</body>
</html>`;
}

function start(): void {
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  server.listen(PORT, HOST, () => {
    const address = server.address() as AddressInfo;
    process.stdout.write(`APIShift public diff running on ${address.address}:${address.port}\n`);
  });
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  start();
}
