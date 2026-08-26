/**
 * Turning a URL expression in source code into something comparable with an
 * OpenAPI path.
 *
 * Real code rarely writes the path as one plain string. It writes
 * `${API_BASE}/v1/charges/${id}`, or `BASE + '/v1/charges'`. So a URL is reduced
 * to a shape: its literal text, with every interpolation collapsed to a single
 * sentinel character. Matching then happens segment by segment, where a sentinel
 * segment is allowed to stand in for a path parameter and nothing else.
 */

import { Node } from 'ts-morph';

/** Stands in for an interpolated expression. Cannot occur in real source text. */
export const INTERPOLATION = '\u0000';

export interface UrlShape {
  /** Literal text, with each interpolated expression replaced by INTERPOLATION. */
  text: string;
  /** True when at least one part of the URL was computed at runtime. */
  dynamic: boolean;
}

export interface UrlMatch {
  /** The path portion of the URL that matched, as it appears in source. */
  pathText: string;
  /** The literal prefix of the spec path, which is the part a rename can rewrite. */
  literalPrefix: string;
}

/**
 * Read a URL expression into a shape, or undefined when it is not a string at
 * all. A bare identifier is deliberately not resolved: guessing the value of a
 * variable is how a scanner starts producing false positives.
 */
export function urlShapeOf(node: Node | undefined): UrlShape | undefined {
  if (node === undefined) return undefined;

  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return { text: node.getLiteralText(), dynamic: false };
  }

  if (Node.isTemplateExpression(node)) {
    let text = node.getHead().getLiteralText();
    for (const span of node.getTemplateSpans()) {
      text += INTERPOLATION + span.getLiteral().getLiteralText();
    }
    return { text, dynamic: true };
  }

  // BASE + '/v1/charges'
  if (Node.isBinaryExpression(node) && node.getOperatorToken().getText() === '+') {
    const left = urlShapeOf(node.getLeft()) ?? { text: INTERPOLATION, dynamic: true };
    const right = urlShapeOf(node.getRight()) ?? { text: INTERPOLATION, dynamic: true };
    return { text: left.text + right.text, dynamic: left.dynamic || right.dynamic };
  }

  return undefined;
}

/** Drop the query string and fragment, which are matched separately. */
function pathPortionOf(text: string): string {
  const cut = Math.min(
    ...[text.indexOf('?'), text.indexOf('#')].filter((index) => index !== -1).concat(text.length),
  );
  return text.slice(0, cut);
}

/** Remove a scheme and host, or a leading interpolated base URL. */
function stripOrigin(path: string): string {
  const withoutScheme = path.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '');
  return withoutScheme.replace(new RegExp(`^${INTERPOLATION}+`), '');
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function isTemplateSegment(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}');
}

/**
 * The part of a spec path before its first parameter. A path rename can only be
 * applied as a literal rewrite over this prefix, so anything that differs after
 * a parameter is left for a human.
 */
export function literalPrefixOf(specPath: string): string {
  const segments = segmentsOf(specPath);
  const literal: string[] = [];
  for (const segment of segments) {
    if (isTemplateSegment(segment)) break;
    literal.push(segment);
  }
  return `/${literal.join('/')}`;
}

/**
 * Does this URL call the given spec path?
 *
 * The URL must end with the spec path at a segment boundary, so `/v1/charges`
 * matches `${BASE}/v1/charges` but not `/v1/charges/{id}`, and a proxy prefix
 * like `/api/v1/charges` still matches.
 */
export function matchSpecPath(
  shape: UrlShape,
  specPath: string,
  baseUrl?: string | undefined,
): UrlMatch | undefined {
  let text = pathPortionOf(shape.text);

  // A client that stores its base URL separately leaves it in the literal, so
  // strip the one the project declared before matching.
  if (baseUrl !== undefined && baseUrl.length > 0 && text.startsWith(baseUrl)) {
    text = text.slice(baseUrl.length);
  }

  const urlPath = stripOrigin(text);
  const urlSegments = segmentsOf(urlPath);
  const specSegments = segmentsOf(specPath);

  if (specSegments.length === 0 || urlSegments.length < specSegments.length) return undefined;

  const offset = urlSegments.length - specSegments.length;
  for (const [index, specSegment] of specSegments.entries()) {
    const urlSegment = urlSegments[offset + index];
    if (urlSegment === undefined) return undefined;

    if (isTemplateSegment(specSegment)) {
      // Any single concrete segment can fill a path parameter.
      if (urlSegment.length === 0) return undefined;
      continue;
    }

    // A literal segment has to be literally present. An interpolation here means
    // we cannot confirm the call, and an unconfirmed match is not a match.
    if (urlSegment !== specSegment) return undefined;
  }

  const literalPrefix = literalPrefixOf(specPath);
  if (!urlPath.includes(literalPrefix)) return undefined;

  return { pathText: urlPath, literalPrefix };
}

/**
 * Rewrite a path rename inside the original source text of a URL literal.
 * Returns undefined when the rename touches anything after a path parameter,
 * which is the case a codemod should not attempt.
 */
export function rewritePath(sourceText: string, fromPath: string, toPath: string): string | undefined {
  const fromPrefix = literalPrefixOf(fromPath);
  const toPrefix = literalPrefixOf(toPath);

  // The tail after the literal prefix has to be identical, otherwise the rename
  // changes parameter structure and a human should look at it.
  if (fromPath.slice(fromPrefix.length) !== toPath.slice(toPrefix.length)) return undefined;
  if (fromPrefix === toPrefix) return undefined;
  if (!sourceText.includes(fromPrefix)) return undefined;

  return sourceText.replace(fromPrefix, toPrefix);
}
