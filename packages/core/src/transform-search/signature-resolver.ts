/**
 * Signature Resolver
 *
 * Resolve and cache actual TypeScript types for candidate callables.
 * This is Layer C of the indexing architecture.
 *
 * After Layer B narrows candidates to ~50-200, we resolve their actual
 * TypeScript types using the type checker. This is expensive, so we cache results.
 */

import {
  type Project,
  type SourceFile,
  type Node,
  type Type,
  type Signature,
  SyntaxKind,
} from "ts-morph";

import type { CallableEntry, CallableId, CallableIndex } from "./types";

/**
 * Known wrapper types that can be unwrapped.
 */
export type WrapperKind = "Promise" | "PromiseLike" | "Effect" | "Observable" | "Task" | null;

/**
 * A resolved parameter from a call signature.
 */
export interface ResolvedParam {
  name: string;
  type: Type;
  typeText: string;
  optional: boolean;
  rest: boolean;
}

/**
 * A resolved call/construct signature.
 */
export interface ResolvedCallSignature {
  /** Resolved parameter types */
  params: ResolvedParam[];

  /** Resolved return type (before unwrapping) */
  returnType: Type;

  /** Return type as text */
  returnTypeText: string;

  /** Detected wrapper on return type */
  returnWrapper: WrapperKind;

  /** Unwrapped return type (if wrapper detected) */
  unwrappedReturnType: Type | null;

  /** Unwrapped return type as text */
  unwrappedReturnTypeText: string | null;
}

/**
 * Fully resolved signature for a callable.
 */
export interface ResolvedSignature {
  /** For each call signature (overloads create multiple) */
  signatures: ResolvedCallSignature[];

  /** Project version for cache invalidation */
  resolvedAtVersion: number;
}

/**
 * Cache for resolved signatures.
 */
interface SignatureCache {
  /** CallableId → ResolvedSignature */
  cache: Map<CallableId, ResolvedSignature>;

  /** Track which project version this cache is valid for */
  projectVersion: number;

  /** Stats */
  hits: number;
  misses: number;
}

/**
 * Resolves and caches TypeScript signatures for callable entries.
 */
export class SignatureResolver {
  private cache: SignatureCache;
  private project: Project;
  private index: CallableIndex;
  private packagePath: string;

  constructor(project: Project, index: CallableIndex, packagePath: string) {
    this.project = project;
    this.index = index;
    this.packagePath = packagePath;
    this.cache = {
      cache: new Map(),
      projectVersion: Date.now(),
      hits: 0,
      misses: 0,
    };
  }

  /**
   * Resolve signatures for a set of candidate IDs.
   * Returns resolved signatures, using cache where available.
   */
  resolveSignatures(candidateIds: CallableId[]): Map<CallableId, ResolvedSignature> {
    const results = new Map<CallableId, ResolvedSignature>();
    const toResolve: CallableId[] = [];

    // Check cache first
    for (const id of candidateIds) {
      const cached = this.cache.cache.get(id);
      if (cached && cached.resolvedAtVersion === this.cache.projectVersion) {
        results.set(id, cached);
        this.cache.hits++;
      } else {
        toResolve.push(id);
        this.cache.misses++;
      }
    }

    // Resolve uncached
    for (const id of toResolve) {
      const entry = this.index.entries[id];
      if (!entry) continue;

      const resolved = this.resolveCallableSignature(entry);
      if (resolved) {
        results.set(id, resolved);
        this.cache.cache.set(id, resolved);
      }
    }

    return results;
  }

  /**
   * Resolve a single callable's signature.
   */
  private resolveCallableSignature(entry: CallableEntry): ResolvedSignature | null {
    // Get the source file
    const fullPath = this.packagePath + "/" + entry.filePath;
    const sourceFile = this.project.getSourceFile(fullPath);
    if (!sourceFile) {
      // Try without package path prefix
      const altSourceFile = this.project.getSourceFile(entry.filePath);
      if (!altSourceFile) return null;
      return this.resolveFromSourceFile(altSourceFile, entry);
    }

    return this.resolveFromSourceFile(sourceFile, entry);
  }

  private resolveFromSourceFile(
    sourceFile: SourceFile,
    entry: CallableEntry,
  ): ResolvedSignature | null {
    // Find the node at the stored position
    const node = sourceFile.getDescendantAtPos(entry.pos);
    if (!node) return null;

    // Get the appropriate declaration node
    const declNode = this.findDeclarationNode(node, entry.kind);
    if (!declNode) return null;

    const type = declNode.getType();

    // Handle constructors specially
    if (entry.kind === "Constructor") {
      const constructSignatures = type.getConstructSignatures();
      if (constructSignatures.length === 0) {
        // Try getting parent class's construct signatures
        const parentClass = declNode.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
        if (parentClass) {
          const classType = parentClass.getType();
          const classSigs = classType.getConstructSignatures();
          if (classSigs.length > 0) {
            return {
              signatures: classSigs.map((sig) => this.resolveConstructSignature(sig, parentClass)),
              resolvedAtVersion: this.cache.projectVersion,
            };
          }
        }
        return null;
      }
      return {
        signatures: constructSignatures.map((sig) => this.resolveConstructSignature(sig, declNode)),
        resolvedAtVersion: this.cache.projectVersion,
      };
    }

    // Get call signatures
    const callSignatures = type.getCallSignatures();
    if (callSignatures.length === 0) {
      // Some callable kinds might need special handling
      return null;
    }

    return {
      signatures: callSignatures.map((sig) => this.resolveCallSignature(sig, declNode)),
      resolvedAtVersion: this.cache.projectVersion,
    };
  }

  /**
   * Find the declaration node from a descendant node.
   */
  private findDeclarationNode(node: Node, kind: CallableEntry["kind"]): Node | null {
    // Walk up to find the declaration
    let current: Node | undefined = node;

    while (current) {
      const syntaxKind = current.getKind();

      switch (kind) {
        case "Function":
          if (syntaxKind === SyntaxKind.FunctionDeclaration) return current;
          break;
        case "VariableCallable":
          if (
            syntaxKind === SyntaxKind.ArrowFunction ||
            syntaxKind === SyntaxKind.FunctionExpression
          ) {
            return current;
          }
          if (syntaxKind === SyntaxKind.VariableDeclaration) return current;
          break;
        case "ClassMethod":
        case "StaticMethod":
          if (syntaxKind === SyntaxKind.MethodDeclaration) return current;
          break;
        case "Constructor":
          if (syntaxKind === SyntaxKind.Constructor) return current;
          break;
        case "InterfaceMethod":
        case "TypeLiteralMethod":
          if (syntaxKind === SyntaxKind.MethodSignature) return current;
          break;
        case "CallableProperty":
          if (syntaxKind === SyntaxKind.PropertySignature) return current;
          break;
        case "ObjectMethod":
          if (
            syntaxKind === SyntaxKind.MethodDeclaration ||
            syntaxKind === SyntaxKind.PropertyAssignment
          ) {
            return current;
          }
          break;
      }

      current = current.getParent();
    }

    return node; // Fall back to original node
  }

  /**
   * Resolve a call signature.
   */
  private resolveCallSignature(sig: Signature, contextNode: Node): ResolvedCallSignature {
    const params: ResolvedParam[] = sig.getParameters().map((param) => {
      const paramType = param.getTypeAtLocation(contextNode);
      const decl = param.getDeclarations()[0];
      const isOptional = decl ? param.isOptional() : false;
      const isRest =
        decl?.getKind() === SyntaxKind.Parameter
          ? (decl as import("ts-morph").ParameterDeclaration).isRestParameter()
          : false;

      return {
        name: param.getName(),
        type: paramType,
        typeText: paramType.getText(contextNode),
        optional: isOptional,
        rest: isRest,
      };
    });

    const returnType = sig.getReturnType();
    const returnTypeText = returnType.getText(contextNode);
    const { wrapper, unwrapped, unwrappedText } = this.detectAndUnwrapReturn(
      returnType,
      contextNode,
    );

    return {
      params,
      returnType,
      returnTypeText,
      returnWrapper: wrapper,
      unwrappedReturnType: unwrapped,
      unwrappedReturnTypeText: unwrappedText,
    };
  }

  /**
   * Resolve a construct signature (for constructors).
   */
  private resolveConstructSignature(sig: Signature, contextNode: Node): ResolvedCallSignature {
    const params: ResolvedParam[] = sig.getParameters().map((param) => {
      const paramType = param.getTypeAtLocation(contextNode);
      const decl = param.getDeclarations()[0];
      const isOptional = decl ? param.isOptional() : false;
      const isRest =
        decl?.getKind() === SyntaxKind.Parameter
          ? (decl as import("ts-morph").ParameterDeclaration).isRestParameter()
          : false;

      return {
        name: param.getName(),
        type: paramType,
        typeText: paramType.getText(contextNode),
        optional: isOptional,
        rest: isRest,
      };
    });

    const returnType = sig.getReturnType();
    const returnTypeText = returnType.getText(contextNode);

    // Constructors don't typically need unwrapping
    return {
      params,
      returnType,
      returnTypeText,
      returnWrapper: null,
      unwrappedReturnType: null,
      unwrappedReturnTypeText: null,
    };
  }

  /**
   * Detect wrapper types and unwrap if possible.
   */
  private detectAndUnwrapReturn(
    returnType: Type,
    contextNode: Node,
  ): {
    wrapper: WrapperKind;
    unwrapped: Type | null;
    unwrappedText: string | null;
  } {
    const symbol = returnType.getSymbol() ?? returnType.getAliasSymbol();
    const name = symbol?.getName();

    // Promise<T>
    if (name === "Promise" || name === "PromiseLike") {
      const typeArgs = returnType.getTypeArguments();
      if (typeArgs.length > 0) {
        const unwrapped = typeArgs[0]!;
        return {
          wrapper: name as WrapperKind,
          unwrapped,
          unwrappedText: unwrapped.getText(contextNode),
        };
      }
    }

    // Effect.Effect<A, E, R> - success type is first arg
    if (name === "Effect" || this.isEffectType(returnType)) {
      const typeArgs = returnType.getTypeArguments();
      if (typeArgs.length > 0) {
        const unwrapped = typeArgs[0]!;
        return {
          wrapper: "Effect",
          unwrapped,
          unwrappedText: unwrapped.getText(contextNode),
        };
      }
    }

    // Observable<T>
    if (name === "Observable") {
      const typeArgs = returnType.getTypeArguments();
      if (typeArgs.length > 0) {
        const unwrapped = typeArgs[0]!;
        return {
          wrapper: "Observable",
          unwrapped,
          unwrappedText: unwrapped.getText(contextNode),
        };
      }
    }

    // Task<T>
    if (name === "Task") {
      const typeArgs = returnType.getTypeArguments();
      if (typeArgs.length > 0) {
        const unwrapped = typeArgs[0]!;
        return {
          wrapper: "Task",
          unwrapped,
          unwrappedText: unwrapped.getText(contextNode),
        };
      }
    }

    return { wrapper: null, unwrapped: null, unwrappedText: null };
  }

  /**
   * Check if a type is an Effect type.
   */
  private isEffectType(type: Type): boolean {
    // Effect types have specific branded properties
    const props = type.getProperties();
    return props.some((p) => p.getName() === "_tag" || p.getName().includes("EffectTypeId"));
  }

  /**
   * Invalidate cache when project changes.
   */
  invalidate(): void {
    this.cache.cache.clear();
    this.cache.projectVersion = Date.now();
    this.cache.hits = 0;
    this.cache.misses = 0;
  }

  /**
   * Get cache statistics.
   */
  getStats(): { hits: number; misses: number; size: number } {
    return {
      hits: this.cache.hits,
      misses: this.cache.misses,
      size: this.cache.cache.size,
    };
  }
}
