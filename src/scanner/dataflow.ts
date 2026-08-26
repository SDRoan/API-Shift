/**
 * Following a response value from the call that produced it to the code that
 * reads its fields.
 *
 * Two mechanisms, in order of strength:
 *
 *   1. Through the type. If the decoded payload has a named type declared in the
 *      repo, the field lives on an interface, and renaming it is an ordinary
 *      symbol rename. That reaches every reader in the codebase, including
 *      functions the call never flows into, and it keeps the code compiling.
 *   2. Through local bindings. When there is no named type, references are
 *      followed within the enclosing scope only. Weaker, so it scores lower.
 *
 * Anything beyond these two is left alone. Guessing is how a scanner starts
 * rewriting code it does not understand.
 */

import { Node, SyntaxKind } from 'ts-morph';
import type {
  Identifier,
  Type,
  InterfaceDeclaration,
  PropertySignature,
  TypeAliasDeclaration,
  VariableDeclaration,
} from 'ts-morph';
import type { HttpCall } from './http.js';

export type PayloadTypeDeclaration = InterfaceDeclaration | TypeAliasDeclaration;

export interface PayloadBinding {
  /**
   * The variable holding the decoded payload, when there is one. Code that
   * returns the payload directly has a usable type but no binding.
   */
  declaration: VariableDeclaration | undefined;
  /** Its declared type, when that type is written in this repo. */
  typeDeclaration: PayloadTypeDeclaration | undefined;
}

/** Step outward past await, casts, parentheses, and non null assertions. */
function unwrapOutward(node: Node): Node {
  let current: Node = node;
  for (;;) {
    const parent = current.getParent();
    if (parent === undefined) return current;
    if (
      Node.isAwaitExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isParenthesizedExpression(parent) ||
      Node.isNonNullExpression(parent) ||
      Node.isTypeAssertion(parent)
    ) {
      current = parent;
      continue;
    }
    return current;
  }
}

/** The variable a value is assigned to, if any. */
function declarationReceiving(node: Node): VariableDeclaration | undefined {
  const outer = unwrapOutward(node);
  const parent = outer.getParent();
  return parent !== undefined && Node.isVariableDeclaration(parent) ? parent : undefined;
}

function referencesOf(declaration: VariableDeclaration): Identifier[] {
  const name = declaration.getNameNode();
  if (!Node.isIdentifier(name)) return [];
  return name
    .findReferencesAsNodes()
    .filter((node): node is Identifier => Node.isIdentifier(node))
    .filter((node) => node !== name);
}

/** `x.json()` where x is one of the given references. */
function jsonDecodeCallsFrom(references: Identifier[]): Node[] {
  return references
    .map((reference) => reference.getParent())
    .filter((parent): parent is Node => parent !== undefined)
    .filter((parent) => Node.isPropertyAccessExpression(parent) && parent.getName() === 'json')
    .map((parent) => parent.getParent())
    .filter((call): call is Node => call !== undefined && Node.isCallExpression(call));
}

/**
 * Resolve an expression's type back to the interface or type alias that declares
 * it, but only when that declaration lives in this repo. A type from
 * node_modules is not ours to rewrite.
 */
/**
 * Unwrap a Promise, so a wrapper declared as Promise<Charge> resolves to the
 * Charge it eventually produces.
 */
function awaitedType(type: Type): Type {
  return type.getSymbol()?.getName() === 'Promise' ? type.getTypeArguments()[0] ?? type : type;
}

function typeDeclarationOfNode(node: Node): PayloadTypeDeclaration | undefined {
  const type = awaitedType(node.getType());
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  const target = symbol
    ?.getDeclarations()
    .find(
      (declaration): declaration is PayloadTypeDeclaration =>
        Node.isInterfaceDeclaration(declaration) || Node.isTypeAliasDeclaration(declaration),
    );

  if (target === undefined) return undefined;
  if (target.getSourceFile().isInNodeModules()) return undefined;
  return target;
}

/**
 * The variables that hold the decoded response body for a call.
 *
 *   const r = await fetch(url); const body = await r.json();
 *   const r = await axios.get(url);            // payload is r.data
 *   const { data } = await axios.get(url);
 */
export function payloadBindingsOf(httpCall: HttpCall): PayloadBinding[] {
  const direct = declarationReceiving(httpCall.call);

  // A wrapper is usually returned straight out rather than bound to a
  // variable: `return request('GET', '/v1/charges')`. There is no binding to
  // follow, but the declared return type still names the payload, which is
  // all a rename needs.
  if (direct === undefined) {
    const declared = typeDeclarationOfNode(httpCall.call);
    return declared === undefined ? [] : [{ declaration: undefined, typeDeclaration: declared }];
  }

  const bindings: PayloadBinding[] = [];
  const record = (declaration: VariableDeclaration): void => {
    bindings.push({ declaration, typeDeclaration: typeDeclarationOfNode(declaration) });
  };

  // fetch: the payload appears one step later, at the .json() call.
  for (const decode of jsonDecodeCallsFrom(referencesOf(direct))) {
    const decoded = declarationReceiving(decode);
    if (decoded !== undefined) {
      record(decoded);
      continue;
    }

    // `return (await response.json()) as Charge` never binds the payload to a
    // variable, but the cast still names the type, which is all a rename needs.
    const typeDeclaration = typeDeclarationOfNode(unwrapOutward(decode));
    if (typeDeclaration !== undefined) {
      bindings.push({ declaration: undefined, typeDeclaration });
    }
  }

  // A destructured response, where the payload binding is the declaration itself.
  const nameNode = direct.getNameNode();
  if (Node.isObjectBindingPattern(nameNode)) {
    const dataElement = nameNode
      .getElements()
      .find((element) => element.getPropertyNameNode()?.getText() === 'data' || element.getName() === 'data');
    if (dataElement !== undefined) bindings.push({ declaration: direct, typeDeclaration: undefined });
  }

  // axios: the response object itself carries the payload under .data.
  if (bindings.length === 0) record(direct);

  return bindings;
}

/** The property signature for a field on a payload type, when it declares one. */
export function propertySignatureOf(
  declaration: PayloadTypeDeclaration,
  fieldName: string,
): PropertySignature | undefined {
  if (Node.isInterfaceDeclaration(declaration)) {
    return declaration.getProperty(fieldName);
  }

  const literal = declaration.getTypeNode()?.asKind(SyntaxKind.TypeLiteral);
  return literal?.getProperty(fieldName);
}

/**
 * Every place a property signature is read, which is what a rename has to
 * rewrite for the code to keep compiling.
 */
export function propertyReferences(property: PropertySignature): Node[] {
  const name = property.getNameNode();
  if (!Node.isIdentifier(name)) return [];
  return name.findReferencesAsNodes().filter((node) => node !== name);
}

/** Local fallback: reads of `binding.field` within the scope that declared it. */
export function localFieldReads(binding: PayloadBinding, fieldName: string): Node[] {
  if (binding.declaration === undefined) return [];

  return referencesOf(binding.declaration)
    .flatMap((reference) => {
      const parent = reference.getParent();
      if (parent === undefined) return [];

      // charge.amount
      if (Node.isPropertyAccessExpression(parent) && parent.getName() === fieldName) {
        return [parent.getNameNode()];
      }

      // response.data.amount
      if (Node.isPropertyAccessExpression(parent) && parent.getName() === 'data') {
        const outer = parent.getParent();
        if (outer !== undefined && Node.isPropertyAccessExpression(outer) && outer.getName() === fieldName) {
          return [outer.getNameNode()];
        }
      }

      return [];
    });
}
