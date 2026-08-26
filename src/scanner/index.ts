/**
 * The scanner: given a repo and a classified diff, find the code that breaks.
 *
 * Driven by the diff rather than scanning blindly, so it only looks for what
 * actually changed. Read only. Every site records absolute character offsets, so
 * the fixer can apply an edit without needing the AST again, and so a site
 * serializes to JSON without carrying a compiler node with it.
 */

import { Node, SyntaxKind } from 'ts-morph';
import type { Project, SourceFile } from 'ts-morph';
import type { ApiChange, CallSite, Confidence, SiteStrategy } from '../types.js';
import { loadProject, relativePathOf } from './project.js';
import { describeHttpCall, httpCallsIn } from './http.js';
import type { HttpCall } from './http.js';
import { localFieldReads, payloadBindingsOf, propertyReferences, propertySignatureOf } from './dataflow.js';
import { matchSpecPath, rewritePath, urlShapeOf } from './url.js';
import { EMPTY_CONFIG, loadScannerConfig } from './config.js';
import type { ScannerConfig } from './config.js';

export interface ScannedSite extends CallSite {
  absoluteFile: string;
  /** Character offsets of the exact text this site covers. */
  start: number;
  end: number;
  /**
   * The exact source text between those offsets. `snippet` is normalized for
   * display, so it cannot be used to verify the file has not moved.
   */
  text: string;
  /** Replacement text, present only when a deterministic codemod claims the site. */
  replacement?: string | undefined;
  /** The codemod that claimed it, or undefined when this is review only. */
  codemod?: string | undefined;
  /** Why this site is listed, shown in review checklist items. */
  reason: string;
}

export interface ScanResult {
  project: Project;
  root: string;
  sites: ScannedSite[];
}

const MAX_SNIPPET = 120;

/**
 * Config for the scan in progress. The strategies below all need it and it
 * never varies within a run, so it is set once rather than threaded through
 * every signature.
 */
let activeConfig: ScannerConfig = EMPTY_CONFIG;

function snippetOf(node: Node): string {
  const text = node.getText().replace(/\s+/g, ' ').trim();
  return text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET)}...` : text;
}

/** The leaf name of a dotted field pointer, so `data[].amount` yields `amount`. */
function leafName(pointer: string | undefined): string | undefined {
  const leaf = pointer?.split('.').at(-1)?.replaceAll('[]', '').trim();
  return leaf !== undefined && leaf.length > 0 ? leaf : undefined;
}

interface SiteInput {
  change: ApiChange;
  node: Node;
  root: string;
  file: SourceFile;
  strategy: SiteStrategy;
  confidence: Confidence;
  reason: string;
  replacement?: string | undefined;
  codemod?: string | undefined;
}

function makeSite(input: SiteInput): ScannedSite {
  const { node, file, root } = input;
  const start = node.getStart();
  const { line, column } = file.getLineAndColumnAtPos(start);

  return {
    changeId: input.change.id,
    file: relativePathOf(root, file),
    absoluteFile: file.getFilePath(),
    line,
    column,
    start,
    end: node.getEnd(),
    text: node.getText(),
    strategy: input.strategy,
    confidence: input.confidence,
    snippet: snippetOf(node),
    reason: input.reason,
    ...(input.replacement !== undefined ? { replacement: input.replacement } : {}),
    ...(input.codemod !== undefined ? { codemod: input.codemod } : {}),
  };
}

/** Does this call belong to the operation the change describes? */
function callMatchesOperation(httpCall: HttpCall, change: ApiChange): boolean {
  const shape = urlShapeOf(httpCall.urlArgument);
  if (shape === undefined) return false;
  if (matchSpecPath(shape, change.path, activeConfig.baseUrl) === undefined) return false;

  // When both sides state a method, they have to agree. A call whose method we
  // cannot read is still allowed through, since the URL already matched.
  if (change.method !== undefined && httpCall.method !== undefined) {
    return httpCall.method === change.method;
  }
  return true;
}

function urlStrategyOf(httpCall: HttpCall): SiteStrategy {
  const shape = urlShapeOf(httpCall.urlArgument);
  return shape?.dynamic === true ? 'url.template' : 'url.literal';
}

/** path.renamed, rewritten inside the URL literal itself. */
function scanPathRename(change: ApiChange, file: SourceFile, root: string): ScannedSite[] {
  const from = change.target?.from;
  const to = change.target?.to;
  if (from === undefined || to === undefined) return [];

  const sites: ScannedSite[] = [];
  for (const httpCall of httpCallsIn(file, activeConfig)) {
    const urlNode = httpCall.urlArgument;
    if (urlNode === undefined) continue;
    if (!callMatchesOperation(httpCall, change)) continue;

    const replacement = rewritePath(urlNode.getText(), from, to);
    sites.push(
      makeSite({
        change,
        node: urlNode,
        file,
        root,
        strategy: urlStrategyOf(httpCall),
        confidence: 'high',
        codemod: replacement !== undefined ? 'rename-path' : undefined,
        replacement,
        reason:
          replacement !== undefined
            ? `calls ${from}, which is now ${to}`
            : `calls ${from}, which moved to ${to} in a way that changes its parameters`,
      }),
    );
  }

  return sites;
}

/** request.field.renamed, rewritten in the payload object literal. */
function scanRequestFieldRename(change: ApiChange, file: SourceFile, root: string): ScannedSite[] {
  const from = leafName(change.target?.from);
  const to = leafName(change.target?.to);
  if (from === undefined || to === undefined) return [];

  const sites: ScannedSite[] = [];
  for (const httpCall of httpCallsIn(file, activeConfig)) {
    if (httpCall.payload === undefined) continue;
    if (!callMatchesOperation(httpCall, change)) continue;

    const property = httpCall.payload.getProperty(from);
    if (property === undefined) continue;

    // `{ amount }` has to become `{ amount_cents: amount }`, since the local
    // variable keeps its own name.
    if (Node.isShorthandPropertyAssignment(property)) {
      sites.push(
        makeSite({
          change,
          node: property,
          file,
          root,
          strategy: 'request.payload',
          confidence: 'high',
          codemod: 'rename-request-field',
          replacement: `${to}: ${from}`,
          reason: `sends ${from}, which the API now calls ${to}`,
        }),
      );
      continue;
    }

    if (Node.isPropertyAssignment(property)) {
      sites.push(
        makeSite({
          change,
          node: property.getNameNode(),
          file,
          root,
          strategy: 'request.payload',
          confidence: 'high',
          codemod: 'rename-request-field',
          replacement: to,
          reason: `sends ${from}, which the API now calls ${to}`,
        }),
      );
    }
  }

  return sites;
}

/**
 * response.field.renamed. Preferred route is the declared type, because renaming
 * an interface property reaches every reader and keeps the code compiling. Local
 * reads are the fallback when the payload has no named type.
 */
function scanResponseFieldRename(change: ApiChange, file: SourceFile, root: string): ScannedSite[] {
  const from = leafName(change.target?.from);
  const to = leafName(change.target?.to);
  if (from === undefined || to === undefined) return [];

  const sites: ScannedSite[] = [];
  const seen = new Set<string>();

  const push = (node: Node, strategy: SiteStrategy, confidence: Confidence): void => {
    const owner = node.getSourceFile();
    const key = `${owner.getFilePath()}:${node.getStart()}`;
    if (seen.has(key)) return;
    seen.add(key);

    sites.push(
      makeSite({
        change,
        node,
        file: owner,
        root,
        strategy,
        confidence,
        codemod: 'rename-response-field',
        replacement: to,
        reason: `reads ${from}, which the API now returns as ${to}`,
      }),
    );
  };

  for (const httpCall of httpCallsIn(file, activeConfig)) {
    if (!callMatchesOperation(httpCall, change)) continue;

    for (const binding of payloadBindingsOf(httpCall)) {
      const declaration = binding.typeDeclaration;

      if (declaration !== undefined) {
        const property = propertySignatureOf(declaration, from);
        if (property !== undefined) {
          // The declaration itself, then every reader of it.
          push(property.getNameNode(), 'response.type', 'high');
          for (const reference of propertyReferences(property)) {
            push(reference, 'response.member', 'high');
          }
          continue;
        }
      }

      for (const read of localFieldReads(binding, from)) {
        push(read, 'response.member', 'medium');
      }
    }
  }

  return sites;
}

/**
 * Changes with no safe mechanical fix. These still need a site, because a
 * reviewer needs the file and line, but they never carry a replacement.
 */
function scanReviewOnly(change: ApiChange, file: SourceFile, root: string): ScannedSite[] {
  const sites: ScannedSite[] = [];
  const field = leafName(change.target?.from ?? change.target?.to);

  for (const httpCall of httpCallsIn(file, activeConfig)) {
    if (!callMatchesOperation(httpCall, change)) continue;

    // Request side changes anchor at the call, since that is where a value would
    // have to be supplied.
    if (change.direction === 'request' || change.direction === undefined) {
      const anchor = httpCall.urlArgument ?? httpCall.call;
      sites.push(
        makeSite({
          change,
          node: anchor,
          file,
          root,
          strategy: urlStrategyOf(httpCall),
          confidence: 'high',
          reason: change.detail,
        }),
      );
      continue;
    }

    if (field === undefined) continue;

    for (const binding of payloadBindingsOf(httpCall)) {
      const declaration = binding.typeDeclaration;
      const property = declaration === undefined ? undefined : propertySignatureOf(declaration, field);

      if (property !== undefined) {
        sites.push(
          makeSite({
            change,
            node: property.getNameNode(),
            file: property.getSourceFile(),
            root,
            strategy: 'response.type',
            confidence: 'high',
            reason: change.detail,
          }),
        );
        continue;
      }

      for (const read of localFieldReads(binding, field)) {
        sites.push(
          makeSite({
            change,
            node: read,
            file: read.getSourceFile(),
            root,
            strategy: 'response.member',
            confidence: 'medium',
            reason: change.detail,
          }),
        );
      }
    }
  }

  return sites;
}

/** client.createCharge(...), matched against an operationId. */
function scanClientMethod(change: ApiChange, file: SourceFile, root: string): ScannedSite[] {
  const operationId = change.operationId;
  if (operationId === undefined || operationId.length === 0) return [];

  const snake = operationId.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  const names = new Set([operationId, snake]);

  return file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => {
      const callee = call.getExpression();
      return Node.isPropertyAccessExpression(callee) && names.has(callee.getName());
    })
    .filter((call) => describeHttpCall(call) === undefined || true)
    .map((call) =>
      makeSite({
        change,
        node: call.getExpression(),
        file,
        root,
        strategy: 'client.method',
        confidence: 'medium',
        reason: `calls ${operationId}, which changed: ${change.detail}`,
      }),
    );
}

/** Change kinds that have a deterministic codemod. Everything else is review only. */
function scanChangeInFile(change: ApiChange, file: SourceFile, root: string): ScannedSite[] {
  switch (change.kind) {
    case 'path.renamed':
      return scanPathRename(change, file, root);
    case 'request.field.renamed':
      return scanRequestFieldRename(change, file, root);
    case 'response.field.renamed':
      return scanResponseFieldRename(change, file, root);
    case 'operation.added':
      return [];
    case 'operation.removed':
      return [...scanReviewOnly(change, file, root), ...scanClientMethod(change, file, root)];
    default:
      return scanReviewOnly(change, file, root);
  }
}

/** Sites are deduplicated by position and change, so one node never lands twice. */
function deduplicate(sites: ScannedSite[]): ScannedSite[] {
  const byKey = new Map<string, ScannedSite>();

  for (const site of sites) {
    // Keyed without the change id on purpose. Two endpoints sharing a response
    // type produce a site each on the very same property, with the very same
    // message, and a reader has one line to fix rather than two.
    const key = `${site.absoluteFile}:${site.start}:${site.end}:${site.reason}`;
    const existing = byKey.get(key);
    // Keep the entry that can actually fix something.
    if (existing === undefined || (existing.replacement === undefined && site.replacement !== undefined)) {
      byKey.set(key, site);
    }
  }

  return [...byKey.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.start - b.start || a.changeId.localeCompare(b.changeId),
  );
}

export function scanProject(root: string, changes: ApiChange[]): ScanResult {
  const loaded = loadProject(root);
  activeConfig = loadScannerConfig(root);
  const sites: ScannedSite[] = [];

  for (const change of changes) {
    if (!change.breaking) continue;
    for (const file of loaded.sourceFiles) {
      sites.push(...scanChangeInFile(change, file, loaded.root));
    }
  }

  return { project: loaded.project, root: loaded.root, sites: deduplicate(sites) };
}

/** Async wrapper, kept because the server and CLI await it. */
export async function scanCodebase(root: string, changes: ApiChange[]): Promise<ScannedSite[]> {
  return Promise.resolve(scanProject(root, changes).sites);
}
