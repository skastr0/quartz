/**
 * AST-Based Token Extraction
 *
 * Extract type tokens from AST without invoking the type checker.
 * This is fast - we scan AST nodes, NOT resolved types.
 *
 * Key principle: Empty arrays mean "unknown" (no annotations), not "no types".
 */

import {
  type Node,
  type TypeNode,
  type ParameterDeclaration,
  type FunctionDeclaration,
  type MethodSignature,
  type FunctionTypeNode,
  type VariableDeclaration,
  type PropertySignature,
  type TypeParameterDeclaration,
  type ClassDeclaration,
  SyntaxKind,
} from "ts-morph";

import type { TokenExtractionResult, CallableEntry } from "./types";

/**
 * Extract tokens from a type node without invoking the type checker.
 *
 * @param typeNode - The TypeNode to extract tokens from
 * @returns Tokens and property keys found in the type
 */
export function extractTokensFromTypeNode(typeNode: TypeNode | undefined): TokenExtractionResult {
  if (!typeNode) {
    return { tokens: [], propKeys: [] };
  }

  const tokens: string[] = [];
  const propKeys: string[] = [];

  function visit(node: Node): void {
    const kind = node.getKind();

    switch (kind) {
      case SyntaxKind.TypeReference: {
        // Get the type name text
        const children = node.getChildren();
        for (const child of children) {
          if (
            child.getKind() === SyntaxKind.Identifier ||
            child.getKind() === SyntaxKind.QualifiedName
          ) {
            const text = child.getText();
            tokens.push(text);

            // Also add parts for qualified names
            if (child.getKind() === SyntaxKind.QualifiedName) {
              const parts = text.split(".");
              parts.forEach((p) => {
                if (!tokens.includes(p)) tokens.push(p);
              });
            }
          }
        }

        // Recurse into type arguments
        for (const child of children) {
          if (child.getKind() === SyntaxKind.SyntaxList) {
            for (const typeArg of child.getChildren()) {
              if (isTypeNode(typeArg)) {
                visit(typeArg);
              }
            }
          }
        }
        break;
      }

      case SyntaxKind.TypeLiteral: {
        // Extract property keys and recurse into property types
        for (const member of node.getChildren()) {
          if (member.getKind() === SyntaxKind.SyntaxList) {
            for (const prop of member.getChildren()) {
              if (prop.getKind() === SyntaxKind.PropertySignature) {
                const propSig = prop as PropertySignature;
                const name = propSig.getName();
                if (name && !propKeys.includes(name)) {
                  propKeys.push(name);
                }
                const propType = propSig.getTypeNode();
                if (propType) {
                  visit(propType);
                }
              } else if (prop.getKind() === SyntaxKind.MethodSignature) {
                const methodSig = prop as MethodSignature;
                const name = methodSig.getName();
                if (name && !propKeys.includes(name)) {
                  propKeys.push(name);
                }
                // Recurse into method signature types
                for (const param of methodSig.getParameters()) {
                  const paramType = param.getTypeNode();
                  if (paramType) visit(paramType);
                }
                const returnType = methodSig.getReturnTypeNode();
                if (returnType) visit(returnType);
              }
            }
          }
        }
        break;
      }

      case SyntaxKind.ArrayType: {
        tokens.push("Array");
        // Recurse into element type
        for (const child of node.getChildren()) {
          if (isTypeNode(child)) {
            visit(child);
            break;
          }
        }
        break;
      }

      case SyntaxKind.TupleType: {
        tokens.push("Tuple");
        // Recurse into element types
        for (const child of node.getChildren()) {
          if (child.getKind() === SyntaxKind.SyntaxList) {
            for (const elem of child.getChildren()) {
              if (isTypeNode(elem)) {
                visit(elem);
              }
            }
          }
        }
        break;
      }

      case SyntaxKind.UnionType:
      case SyntaxKind.IntersectionType: {
        // Recurse into constituent types
        for (const child of node.getChildren()) {
          if (isTypeNode(child)) {
            visit(child);
          } else if (child.getKind() === SyntaxKind.SyntaxList) {
            for (const elem of child.getChildren()) {
              if (isTypeNode(elem)) {
                visit(elem);
              }
            }
          }
        }
        break;
      }

      case SyntaxKind.FunctionType: {
        const fnType = node as FunctionTypeNode;
        // Recurse into parameter types
        for (const param of fnType.getParameters()) {
          const paramType = param.getTypeNode();
          if (paramType) visit(paramType);
        }
        // Recurse into return type
        const returnType = fnType.getReturnTypeNode();
        if (returnType) visit(returnType);
        break;
      }

      case SyntaxKind.ParenthesizedType: {
        // Unwrap and recurse
        for (const child of node.getChildren()) {
          if (isTypeNode(child)) {
            visit(child);
            break;
          }
        }
        break;
      }

      case SyntaxKind.TypeQuery: {
        // typeof operator
        tokens.push("typeof");
        // Extract the identifier being queried
        for (const child of node.getChildren()) {
          if (
            child.getKind() === SyntaxKind.Identifier ||
            child.getKind() === SyntaxKind.QualifiedName
          ) {
            tokens.push(child.getText());
          }
        }
        break;
      }

      case SyntaxKind.TypeOperator: {
        // keyof, readonly, unique
        const operatorToken = node.getChildAtIndex(0);
        if (operatorToken) {
          if (operatorToken.getKind() === SyntaxKind.KeyOfKeyword) {
            tokens.push("keyof");
          } else if (operatorToken.getKind() === SyntaxKind.ReadonlyKeyword) {
            tokens.push("readonly");
          } else if (operatorToken.getKind() === SyntaxKind.UniqueKeyword) {
            tokens.push("unique");
          }
        }
        // Recurse into the operand type
        for (const child of node.getChildren()) {
          if (isTypeNode(child)) {
            visit(child);
          }
        }
        break;
      }

      case SyntaxKind.IndexedAccessType: {
        // T[K] - recurse into both parts
        for (const child of node.getChildren()) {
          if (isTypeNode(child)) {
            visit(child);
          }
        }
        break;
      }

      case SyntaxKind.MappedType: {
        // { [K in keyof T]: V } - extract what we can
        for (const child of node.getChildren()) {
          if (isTypeNode(child)) {
            visit(child);
          }
        }
        break;
      }

      case SyntaxKind.ConditionalType: {
        // T extends U ? X : Y - extract all branches
        for (const child of node.getChildren()) {
          if (isTypeNode(child)) {
            visit(child);
          }
        }
        break;
      }

      case SyntaxKind.InferType: {
        tokens.push("infer");
        break;
      }

      case SyntaxKind.RestType: {
        // ...T in tuples
        for (const child of node.getChildren()) {
          if (isTypeNode(child)) {
            visit(child);
          }
        }
        break;
      }

      case SyntaxKind.OptionalType: {
        // T? in tuples
        for (const child of node.getChildren()) {
          if (isTypeNode(child)) {
            visit(child);
          }
        }
        break;
      }

      case SyntaxKind.LiteralType: {
        // String/number/boolean literal types - skip the value
        break;
      }

      case SyntaxKind.TemplateLiteralType: {
        // Template literal types - skip for v1
        break;
      }

      // Primitive keywords
      case SyntaxKind.StringKeyword:
        tokens.push("string");
        break;
      case SyntaxKind.NumberKeyword:
        tokens.push("number");
        break;
      case SyntaxKind.BooleanKeyword:
        tokens.push("boolean");
        break;
      case SyntaxKind.VoidKeyword:
        tokens.push("void");
        break;
      case SyntaxKind.NeverKeyword:
        tokens.push("never");
        break;
      case SyntaxKind.UnknownKeyword:
        tokens.push("unknown");
        break;
      case SyntaxKind.AnyKeyword:
        tokens.push("any");
        break;
      case SyntaxKind.UndefinedKeyword:
        tokens.push("undefined");
        break;
      case SyntaxKind.NullKeyword:
        tokens.push("null");
        break;
      case SyntaxKind.ObjectKeyword:
        tokens.push("object");
        break;
      case SyntaxKind.SymbolKeyword:
        tokens.push("symbol");
        break;
      case SyntaxKind.BigIntKeyword:
        tokens.push("bigint");
        break;
      case SyntaxKind.ThisType:
        tokens.push("this");
        break;
    }
  }

  visit(typeNode);

  // Deduplicate tokens and propKeys
  return {
    tokens: [...new Set(tokens)],
    propKeys: [...new Set(propKeys)],
  };
}

/**
 * Extract tokens from type parameter constraints.
 * For `T extends Entity`, this extracts tokens from `Entity`.
 * For `T extends A | B`, this extracts tokens from both `A` and `B`.
 *
 * @param typeParams - Array of type parameter declarations
 * @returns Combined token extraction result from all constraints
 */
export function extractTokensFromTypeParameters(
  typeParams: TypeParameterDeclaration[],
): TokenExtractionResult {
  const tokens: string[] = [];
  const propKeys: string[] = [];

  for (const typeParam of typeParams) {
    const constraint = typeParam.getConstraint();
    if (constraint) {
      const result = extractTokensFromTypeNode(constraint);
      tokens.push(...result.tokens);
      propKeys.push(...result.propKeys);
    }
  }

  return {
    tokens: [...new Set(tokens)],
    propKeys: [...new Set(propKeys)],
  };
}

/**
 * Check if a node is a type node.
 */
function isTypeNode(node: Node): boolean {
  const kind = node.getKind();
  return (
    kind === SyntaxKind.TypeReference ||
    kind === SyntaxKind.TypeLiteral ||
    kind === SyntaxKind.ArrayType ||
    kind === SyntaxKind.TupleType ||
    kind === SyntaxKind.UnionType ||
    kind === SyntaxKind.IntersectionType ||
    kind === SyntaxKind.FunctionType ||
    kind === SyntaxKind.ParenthesizedType ||
    kind === SyntaxKind.TypeQuery ||
    kind === SyntaxKind.TypeOperator ||
    kind === SyntaxKind.IndexedAccessType ||
    kind === SyntaxKind.MappedType ||
    kind === SyntaxKind.ConditionalType ||
    kind === SyntaxKind.InferType ||
    kind === SyntaxKind.RestType ||
    kind === SyntaxKind.OptionalType ||
    kind === SyntaxKind.LiteralType ||
    kind === SyntaxKind.TemplateLiteralType ||
    kind === SyntaxKind.StringKeyword ||
    kind === SyntaxKind.NumberKeyword ||
    kind === SyntaxKind.BooleanKeyword ||
    kind === SyntaxKind.VoidKeyword ||
    kind === SyntaxKind.NeverKeyword ||
    kind === SyntaxKind.UnknownKeyword ||
    kind === SyntaxKind.AnyKeyword ||
    kind === SyntaxKind.UndefinedKeyword ||
    kind === SyntaxKind.NullKeyword ||
    kind === SyntaxKind.ObjectKeyword ||
    kind === SyntaxKind.SymbolKeyword ||
    kind === SyntaxKind.BigIntKeyword ||
    kind === SyntaxKind.ThisType
  );
}

/**
 * Get parameters from a callable node.
 */
function getParameters(node: Node): ParameterDeclaration[] {
  if ("getParameters" in node && typeof node.getParameters === "function") {
    return (node as FunctionDeclaration).getParameters();
  }
  return [];
}

/**
 * Get return type node from a callable node.
 */
function getReturnTypeNode(node: Node): TypeNode | undefined {
  if ("getReturnTypeNode" in node && typeof node.getReturnTypeNode === "function") {
    return (node as FunctionDeclaration).getReturnTypeNode();
  }
  return undefined;
}

/**
 * Get type parameters from a callable node.
 */
function getTypeParameters(node: Node): TypeParameterDeclaration[] {
  if ("getTypeParameters" in node && typeof node.getTypeParameters === "function") {
    return (node as FunctionDeclaration).getTypeParameters();
  }
  return [];
}

/**
 * Extract tokens from a callable node (function, method, etc.).
 * Fills in paramTokens, returnTokens, paramPropKeys, and returnPropKeys.
 *
 * @param node - The callable node (function, method, arrow, etc.)
 * @returns Token extraction results for params and return type
 */
export function extractCallableTokens(node: Node): {
  paramTokens: string[];
  returnTokens: string[];
  paramPropKeys: string[];
  returnPropKeys: string[];
} {
  const params = getParameters(node);
  const returnTypeNode = getReturnTypeNode(node);
  const typeParams = getTypeParameters(node);

  // Extract tokens from all parameters
  const paramResults = params.map((p) => extractTokensFromTypeNode(p.getTypeNode()));

  // Extract tokens from return type
  const returnResult = extractTokensFromTypeNode(returnTypeNode);

  // Extract tokens from type parameter constraints (e.g., T extends Entity)
  // These tokens apply to both params and return because the generic could appear in either
  const typeParamConstraintResult = extractTokensFromTypeParameters(typeParams);

  // Combine and deduplicate
  // Add constraint tokens to both param and return tokens since the generic T
  // could reference them in either position
  const paramTokens = [
    ...new Set([...paramResults.flatMap((r) => r.tokens), ...typeParamConstraintResult.tokens]),
  ];
  const paramPropKeys = [
    ...new Set([...paramResults.flatMap((r) => r.propKeys), ...typeParamConstraintResult.propKeys]),
  ];

  const returnTokens = [...new Set([...returnResult.tokens, ...typeParamConstraintResult.tokens])];
  const returnPropKeys = [
    ...new Set([...returnResult.propKeys, ...typeParamConstraintResult.propKeys]),
  ];

  return {
    paramTokens,
    returnTokens,
    paramPropKeys,
    returnPropKeys,
  };
}

/**
 * Extract tokens for a variable declaration with callable initializer.
 * Handles arrow functions and function expressions.
 *
 * @param varDecl - The variable declaration
 * @returns Token extraction results
 */
export function extractVariableCallableTokens(varDecl: VariableDeclaration): {
  paramTokens: string[];
  returnTokens: string[];
  paramPropKeys: string[];
  returnPropKeys: string[];
} {
  const init = varDecl.getInitializer();
  if (!init) {
    return { paramTokens: [], returnTokens: [], paramPropKeys: [], returnPropKeys: [] };
  }

  // Check for explicit type annotation on the variable
  const typeNode = varDecl.getTypeNode();
  if (typeNode && typeNode.getKind() === SyntaxKind.FunctionType) {
    const fnType = typeNode as FunctionTypeNode;
    const paramResults = fnType
      .getParameters()
      .map((p) => extractTokensFromTypeNode(p.getTypeNode()));
    const returnResult = extractTokensFromTypeNode(fnType.getReturnTypeNode());

    return {
      paramTokens: [...new Set(paramResults.flatMap((r) => r.tokens))],
      returnTokens: returnResult.tokens,
      paramPropKeys: [...new Set(paramResults.flatMap((r) => r.propKeys))],
      returnPropKeys: returnResult.propKeys,
    };
  }

  // Fall back to extracting from the initializer
  return extractCallableTokens(init);
}

/**
 * Extract tokens for a callable property (fn: (a: A) => B).
 *
 * @param prop - The property signature with function type
 * @returns Token extraction results
 */
export function extractCallablePropertyTokens(prop: PropertySignature): {
  paramTokens: string[];
  returnTokens: string[];
  paramPropKeys: string[];
  returnPropKeys: string[];
} {
  const typeNode = prop.getTypeNode();
  if (!typeNode || typeNode.getKind() !== SyntaxKind.FunctionType) {
    return { paramTokens: [], returnTokens: [], paramPropKeys: [], returnPropKeys: [] };
  }

  const fnType = typeNode as FunctionTypeNode;
  const paramResults = fnType
    .getParameters()
    .map((p) => extractTokensFromTypeNode(p.getTypeNode()));
  const returnResult = extractTokensFromTypeNode(fnType.getReturnTypeNode());

  return {
    paramTokens: [...new Set(paramResults.flatMap((r) => r.tokens))],
    returnTokens: returnResult.tokens,
    paramPropKeys: [...new Set(paramResults.flatMap((r) => r.propKeys))],
    returnPropKeys: returnResult.propKeys,
  };
}

/**
 * Find the appropriate node for token extraction based on entry kind.
 * The node at position might be a child, so we need to navigate to the right ancestor.
 */
function findNodeForEntry(node: Node, kind: CallableEntry["kind"]): Node | null {
  // For VariableCallable, we need to find the VariableDeclaration
  if (kind === "VariableCallable") {
    let current: Node | undefined = node;
    while (current) {
      if (current.getKind() === SyntaxKind.VariableDeclaration) {
        return current;
      }
      current = current.getParent();
    }
    return null;
  }

  // For CallableProperty, find the PropertySignature
  if (kind === "CallableProperty") {
    let current: Node | undefined = node;
    while (current) {
      if (current.getKind() === SyntaxKind.PropertySignature) {
        return current;
      }
      current = current.getParent();
    }
    return null;
  }

  // For other kinds, the node at position should be correct,
  // but we can try to find a function-like ancestor
  let current: Node | undefined = node;
  while (current) {
    const nodeKind = current.getKind();
    if (
      nodeKind === SyntaxKind.FunctionDeclaration ||
      nodeKind === SyntaxKind.MethodDeclaration ||
      nodeKind === SyntaxKind.Constructor ||
      nodeKind === SyntaxKind.ArrowFunction ||
      nodeKind === SyntaxKind.FunctionExpression ||
      nodeKind === SyntaxKind.MethodSignature
    ) {
      return current;
    }
    current = current.getParent();
  }

  // Fall back to original node
  return node;
}

/**
 * Find the containing class declaration for a node, if any.
 * Used to extract class-level type parameter constraints for methods.
 */
function findContainingClass(node: Node): ClassDeclaration | null {
  let current: Node | undefined = node.getParent();
  while (current) {
    if (current.getKind() === SyntaxKind.ClassDeclaration) {
      return current as ClassDeclaration;
    }
    current = current.getParent();
  }
  return null;
}

/**
 * Populate tokens in a CallableEntry from its source node.
 * This is a convenience function that modifies the entry in place.
 *
 * @param entry - The entry to populate
 * @param node - The source node to extract tokens from
 */
export function populateEntryTokens(entry: CallableEntry, node: Node): void {
  const kind = entry.kind;

  // Find the appropriate node based on entry kind
  const targetNode = findNodeForEntry(node, kind);
  if (!targetNode) {
    // Can't find appropriate node, leave tokens empty
    return;
  }

  let result: {
    paramTokens: string[];
    returnTokens: string[];
    paramPropKeys: string[];
    returnPropKeys: string[];
  };

  if (kind === "VariableCallable") {
    result = extractVariableCallableTokens(targetNode as VariableDeclaration);
  } else if (kind === "CallableProperty") {
    result = extractCallablePropertyTokens(targetNode as PropertySignature);
  } else {
    result = extractCallableTokens(targetNode);
  }

  // For class methods and constructors, also extract class-level type parameter constraints
  // This handles patterns like: class WorkflowBaseService<T extends Entity> { duplicate(entity: T): T }
  // The "Entity" constraint needs to be added to the method's tokens
  if (kind === "ClassMethod" || kind === "StaticMethod" || kind === "Constructor") {
    const containingClass = findContainingClass(targetNode);
    if (containingClass) {
      const classTypeParams = containingClass.getTypeParameters();
      if (classTypeParams.length > 0) {
        const classConstraintResult = extractTokensFromTypeParameters(classTypeParams);
        // Add class-level constraint tokens to both param and return
        result.paramTokens = [...new Set([...result.paramTokens, ...classConstraintResult.tokens])];
        result.returnTokens = [
          ...new Set([...result.returnTokens, ...classConstraintResult.tokens]),
        ];
        result.paramPropKeys = [
          ...new Set([...result.paramPropKeys, ...classConstraintResult.propKeys]),
        ];
        result.returnPropKeys = [
          ...new Set([...result.returnPropKeys, ...classConstraintResult.propKeys]),
        ];
      }
    }
  }

  entry.paramTokens = result.paramTokens;
  entry.returnTokens = result.returnTokens;
  entry.paramPropKeys = result.paramPropKeys;
  entry.returnPropKeys = result.returnPropKeys;
}
