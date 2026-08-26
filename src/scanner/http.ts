/**
 * Recognizing HTTP calls in source.
 *
 * The scanner only cares about calls it can tie to a spec path, so the URL
 * argument is the strong signal and the callee name is a secondary one. That
 * ordering keeps the matcher general: a hand rolled `request()` wrapper is found
 * for the same reason `fetch` is, because its first argument is a URL that
 * matches an affected path.
 */

import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, Expression, ObjectLiteralExpression, SourceFile } from 'ts-morph';
import type { HttpMethod } from '../types.js';
import { EMPTY_CONFIG } from './config.js';
import type { RequestFunctionConfig, ScannerConfig } from './config.js';

const AXIOS_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request']);

/** Callee names that make a call unambiguously an HTTP call. */
const KNOWN_CALLEES = new Set(['fetch', 'axios']);

export interface HttpCall {
  call: CallExpression;
  /** The expression holding the URL, when the call has one. */
  urlArgument: Expression | undefined;
  /** The options or config object, if present. */
  config: ObjectLiteralExpression | undefined;
  /** The request payload object, if one can be located. */
  payload: ObjectLiteralExpression | undefined;
  /** The method, when the call shape states it. */
  method: HttpMethod | undefined;
  /** True when the callee is a name we recognize rather than an unknown wrapper. */
  recognizedCallee: boolean;
}

function objectLiteralOf(node: Node | undefined): ObjectLiteralExpression | undefined {
  return node !== undefined && Node.isObjectLiteralExpression(node) ? node : undefined;
}

function propertyValue(
  object: ObjectLiteralExpression | undefined,
  name: string,
): Expression | undefined {
  const property = object?.getProperty(name);
  if (property === undefined || !Node.isPropertyAssignment(property)) return undefined;
  return property.getInitializer();
}

/**
 * Unwrap `JSON.stringify({...})` so the object literal inside is reachable. This
 * is the single most common way a request body is written.
 */
function unwrapJsonStringify(node: Expression | undefined): Expression | undefined {
  if (node === undefined || !Node.isCallExpression(node)) return node;
  if (node.getExpression().getText() !== 'JSON.stringify') return node;
  return node.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression) ?? node;
}

function asMethod(text: string): HttpMethod | undefined {
  const lower = text.toLowerCase();
  const methods: HttpMethod[] = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
  return methods.find((method) => method === lower);
}

/** Read the method out of a `{ method: 'POST' }` style config. */
function methodFromConfig(config: ObjectLiteralExpression | undefined): HttpMethod | undefined {
  const value = propertyValue(config, 'method');
  if (value === undefined) return undefined;
  if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) {
    return asMethod(value.getLiteralText());
  }
  return undefined;
}

/**
 * Describe one call expression as an HTTP call, covering the shapes that appear
 * in real client code:
 *
 *   fetch(url, { method, body })
 *   axios.post(url, data, config)
 *   axios({ url, method, data })
 *   client.get(url)
 */
/**
 * A wrapper the project declared in apishift.json.
 *
 * Matched on the callee text, so a plain function and a method both work, and
 * the URL comes from whichever argument the project said holds it.
 */
function describeConfiguredCall(
  call: CallExpression,
  rule: RequestFunctionConfig,
): HttpCall | undefined {
  const args = call.getArguments();
  const urlArgument = args[rule.urlArgument] as Expression | undefined;
  if (urlArgument === undefined) return undefined;

  const payload =
    rule.bodyArgument === undefined
      ? undefined
      : objectLiteralOf(unwrapJsonStringify(args[rule.bodyArgument] as Expression | undefined));

  let method: HttpMethod | undefined;
  if (rule.methodArgument !== undefined) {
    const declared = args[rule.methodArgument];
    if (
      declared !== undefined &&
      (Node.isStringLiteral(declared) || Node.isNoSubstitutionTemplateLiteral(declared))
    ) {
      method = asMethod(declared.getLiteralText());
    }
  }

  return {
    call,
    urlArgument,
    config: undefined,
    payload,
    method,
    recognizedCallee: true,
  };
}

export function describeHttpCall(
  call: CallExpression,
  config: ScannerConfig = EMPTY_CONFIG,
): HttpCall | undefined {
  const callee = call.getExpression();
  const args = call.getArguments();

  // A declared wrapper wins, since the project knows its own code better than
  // any heuristic here does.
  const rule = config.requestFunctions.find((candidate) => candidate.name === callee.getText());
  if (rule !== undefined) {
    const described = describeConfiguredCall(call, rule);
    if (described !== undefined) return described;
  }
  const first = args[0]?.asKind(SyntaxKind.ObjectLiteralExpression) ?? args[0];

  // axios({ url, method, data }) and any single config object call.
  const configOnly = objectLiteralOf(first);
  if (configOnly !== undefined && propertyValue(configOnly, 'url') !== undefined) {
    return {
      call,
      urlArgument: propertyValue(configOnly, 'url'),
      config: configOnly,
      payload: objectLiteralOf(unwrapJsonStringify(propertyValue(configOnly, 'data') ?? propertyValue(configOnly, 'body'))),
      method: methodFromConfig(configOnly),
      recognizedCallee: KNOWN_CALLEES.has(callee.getText()),
    };
  }

  const urlArgument = args[0] as Expression | undefined;
  if (urlArgument === undefined) return undefined;

  // fetch(url, { method, body })
  if (Node.isIdentifier(callee) && callee.getText() === 'fetch') {
    const config = objectLiteralOf(args[1]);
    return {
      call,
      urlArgument,
      config,
      payload: objectLiteralOf(unwrapJsonStringify(propertyValue(config, 'body'))),
      method: methodFromConfig(config) ?? 'get',
      recognizedCallee: true,
    };
  }

  // axios.post(url, data), client.get(url)
  if (Node.isPropertyAccessExpression(callee)) {
    const methodName = callee.getName();
    if (!AXIOS_METHODS.has(methodName)) return undefined;

    const receiver = callee.getExpression().getText();
    const sendsBody = methodName === 'post' || methodName === 'put' || methodName === 'patch';
    const config = objectLiteralOf(args[sendsBody ? 2 : 1]);

    return {
      call,
      urlArgument,
      config,
      payload: sendsBody ? objectLiteralOf(unwrapJsonStringify(args[1] as Expression | undefined)) : undefined,
      method: asMethod(methodName) ?? methodFromConfig(config),
      recognizedCallee: KNOWN_CALLEES.has(receiver),
    };
  }

  return undefined;
}

/** Every call in a file that looks like it might be an HTTP call. */
export function httpCallsIn(file: SourceFile, config: ScannerConfig = EMPTY_CONFIG): HttpCall[] {
  return file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .map((call) => describeHttpCall(call, config))
    .filter((call): call is HttpCall => call !== undefined);
}
