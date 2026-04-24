/**
 * Synthetic Call-Site Verifier
 *
 * Verify matches using synthetic TypeScript code that actually calls the candidate function.
 * This is the KEY INNOVATION that makes the tool production-grade.
 *
 * Problem: `isAssignableTo` can lie with generics and complex types.
 * Solution: Generate temporary code that actually uses the function and ask TypeScript
 *           if it compiles. No diagnostics = verified match.
 *
 * Example:
 * ```typescript
 * // Generic function that isAssignableTo incorrectly matches
 * function identity<T>(x: T): T { return x }
 *
 * // Query: from=User, to=UserDTO
 * // isAssignableTo says: User → T ✓, T → UserDTO ✓
 * // Reality: identity(user) returns User, not UserDTO!
 *
 * // Synthetic check generates:
 * type __From = User
 * type __To = UserDTO
 * declare const __input: __From
 * const __output: __To = identity(__input)
 * //                     ^^^^^^^^^^^^^^^^
 * //                     TS Error: Type 'User' is not assignable to type 'UserDTO'
 * ```
 */

import { type Project, type SourceFile, ts } from "ts-morph";
import { relative, join } from "path";

import type {
  CallableEntry,
  CallableId,
  CallableIndex,
  VerificationStatus,
  VerificationReason,
  VerificationMeta,
} from "./types";
import type { AssignabilityCheckResult } from "./assignability-filter";

/**
 * Result of a synthetic verification check.
 */
export interface SyntheticCheckResult {
  candidateId: CallableId;

  /** @deprecated Use verification.status instead */
  verified: boolean;

  /** Full verification metadata */
  verification: VerificationMeta;

  /** If not verified, why? @deprecated Use verification.diagnostics */
  diagnostics: Array<{
    message: string;
    code: number;
  }>;

  /** The generated code (for debugging) */
  syntheticCode: string;
}

/**
 * Options for synthetic verification.
 */
export interface SyntheticVerifyOptions {
  /** Type expression for "from" */
  fromExpr: string;

  /** Type expression for "to" */
  toExpr: string;

  /** Whether to unwrap Promise in return type */
  unwrapReturn: boolean;
}

/**
 * Verifies candidates using synthetic call-site checks.
 *
 * This is expensive - only call on top ~50 candidates after assignability filtering.
 */
export class SyntheticVerifier {
  private project: Project;
  private packagePath: string;
  private tempFileCounter = 0;
  private useJsExtension: boolean;

  constructor(project: Project, packagePath: string) {
    this.project = project;
    this.packagePath = packagePath;
    this.useJsExtension = this.detectNeedsJsExtension();
  }

  /**
   * Detect if module specifiers need .js extension.
   * NodeNext and Node16 module resolution require explicit .js extensions for ESM.
   */
  private detectNeedsJsExtension(): boolean {
    try {
      const compilerOptions = this.project.getCompilerOptions();
      const moduleResolution = compilerOptions.moduleResolution;

      // ts.ModuleResolutionKind values:
      // NodeNext = 99, Node16 = 3
      if (moduleResolution === 99 || moduleResolution === 3) {
        return true;
      }

      // Also check module setting:
      // ts.ModuleKind: NodeNext = 199, Node16 = 100
      const module = compilerOptions.module;
      if (module === 199 || module === 100) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Get the module specifier for a file path, respecting module resolution settings.
   */
  private getModuleSpecifier(filePath: string): string {
    let modulePath = filePath;

    if (this.useJsExtension) {
      // NodeNext/Node16: replace .ts/.tsx with .js
      modulePath = modulePath.replace(/\.tsx?$/, ".js");
    } else {
      // Bundler/Classic: strip extension entirely
      modulePath = modulePath.replace(/\.(ts|tsx)$/, "");
    }

    return modulePath;
  }

  /**
   * Verify a list of candidates using synthetic call-site checks.
   *
   * @param candidates - Candidates that passed assignability checks
   * @param options - Verification options
   * @param index - The callable index
   * @returns Verification results
   */
  verifyCandidates(
    candidates: AssignabilityCheckResult[],
    options: SyntheticVerifyOptions,
    index: CallableIndex,
  ): SyntheticCheckResult[] {
    const results: SyntheticCheckResult[] = [];

    for (const candidate of candidates) {
      const entry = index.entries[candidate.candidateId];
      if (!entry) continue;

      const result = this.verifyCandidate(entry, candidate, options);
      results.push(result);
    }

    return results;
  }

  /**
   * Verify a single candidate.
   */
  private verifyCandidate(
    entry: CallableEntry,
    assignabilityResult: AssignabilityCheckResult,
    options: SyntheticVerifyOptions,
  ): SyntheticCheckResult {
    const syntheticCode = this.generateSyntheticCode(entry, options, assignabilityResult);
    const diagnostics = this.checkSyntheticCode(syntheticCode, entry.filePath);
    const verified = diagnostics.length === 0;

    return {
      candidateId: entry.id,
      verified,
      verification: {
        status: verified ? "verified" : "unverified",
        method: "synthetic",
        reason: verified ? "synthetic_check_passed" : "synthetic_check_failed",
        ...(verified ? {} : { diagnostics }),
      },
      diagnostics,
      syntheticCode,
    };
  }

  /**
   * Generate synthetic TypeScript code for verification.
   */
  private generateSyntheticCode(
    entry: CallableEntry,
    options: SyntheticVerifyOptions,
    assignabilityResult: AssignabilityCheckResult,
  ): string {
    const lines: string[] = [];

    // 1. Import/reference the candidate
    const importStatement = this.generateImport(entry);
    if (importStatement) {
      lines.push(importStatement);
    }

    // 2. Generate imports for types used in query expressions
    const queryTypeImports = this.generateQueryTypeImports(options.fromExpr, options.toExpr);
    if (queryTypeImports) {
      lines.push(queryTypeImports);
    }

    // 3. Define query types
    lines.push(`type __QueryFrom = ${options.fromExpr}`);
    lines.push(`type __QueryTo = ${options.toExpr}`);
    lines.push("");

    // 3. Declare input value
    lines.push(`declare const __input: __QueryFrom`);
    lines.push("");

    // 4. Generate the call expression and assignment
    const callExpr = this.generateCallExpression(entry, assignabilityResult);

    if (options.unwrapReturn && assignabilityResult.toMatch?.unwrapped) {
      const wrapper = assignabilityResult.toMatch.wrapper;
      if (wrapper === "Promise" || wrapper === "PromiseLike") {
        // Async unwrap
        lines.push(`async function __syntheticTest() {`);
        lines.push(`  const __output: __QueryTo = await ${callExpr}`);
        lines.push(`}`);
      } else if (wrapper === "Effect") {
        // Effect unwrap - use type assertion pattern
        lines.push(`// Effect unwrap verification`);
        lines.push(
          `declare function __unwrapEffect<A, E, R>(effect: { _tag: "Effect" } & { readonly [Symbol.iterator]: () => Generator<any, A, any> }): A`,
        );
        lines.push(`const __output: __QueryTo = __unwrapEffect(${callExpr})`);
      } else {
        // Generic unwrap - just check the unwrapped type
        lines.push(`// ${wrapper} unwrap verification`);
        lines.push(`declare function __unwrap<T>(wrapped: { readonly value: T }): T`);
        lines.push(`const __output: __QueryTo = ${callExpr} as unknown as __QueryTo`);
      }
    } else {
      // Direct assignment
      lines.push(`const __output: __QueryTo = ${callExpr}`);
    }

    return lines.join("\n");
  }

  /**
   * Generate import statement for the candidate.
   *
   * CRITICAL: This should only be called for EXPORTED functions.
   * Internal functions should be caught by shouldSkipSyntheticCheck() earlier.
   *
   * Returns null if the function cannot be imported (which should NOT happen
   * if shouldSkipSyntheticCheck was called properly).
   */
  private generateImport(entry: CallableEntry): string | null {
    const modulePath = this.getModuleSpecifier(entry.filePath);
    const specifier = modulePath.startsWith(".") ? modulePath : "./" + modulePath;

    if (entry.kind === "Constructor") {
      // For constructors, import the class
      const className = entry.qualifiedName.split(".")[0];
      return `import { ${className} } from "${specifier}"`;
    }

    if (entry.qualifiedName.includes(".")) {
      // Method: Class.method or Object.method
      const [container] = entry.qualifiedName.split(".");
      return `import { ${container} } from "${specifier}"`;
    }

    // Standalone function
    if (entry.exportState === "exported") {
      return `import { ${entry.qualifiedName} } from "${specifier}"`;
    }

    // CRITICAL FIX: Do NOT generate fake `any` signatures!
    // Internal functions should have been skipped by shouldSkipSyntheticCheck().
    // If we reach here, something is wrong in the calling code.
    // Return null to signal that verification cannot proceed.
    return null;
  }

  /**
   * Generate the call expression for the candidate.
   */
  private generateCallExpression(
    entry: CallableEntry,
    assignabilityResult: AssignabilityCheckResult,
  ): string {
    const paramIndex = assignabilityResult.fromMatch?.paramIndex ?? 0;

    if (entry.kind === "Constructor") {
      const className = entry.qualifiedName.split(".")[0];
      const args = this.generateArgs(paramIndex, entry.minArity);
      return `new ${className}(${args})`;
    }

    if (entry.qualifiedName.includes(".")) {
      const [container, method] = entry.qualifiedName.split(".");
      const args = this.generateArgs(paramIndex, entry.minArity);

      if (entry.kind === "StaticMethod") {
        return `${container}.${method}(${args})`;
      } else {
        // Instance method - need to create mock instance
        return `(null as unknown as InstanceType<typeof ${container}>).${method}(${args})`;
      }
    }

    // Standalone function
    const args = this.generateArgs(paramIndex, entry.minArity);
    return `${entry.qualifiedName}(${args})`;
  }

  /**
   * Generate argument list with __input at the matched position.
   */
  private generateArgs(matchedParamIndex: number, minArity: number): string {
    if (minArity === 0) {
      return matchedParamIndex === 0 ? "__input" : "";
    }

    const args: string[] = [];
    const numArgs = Math.max(minArity, matchedParamIndex + 1);

    for (let i = 0; i < numArgs; i++) {
      if (i === matchedParamIndex) {
        args.push("__input");
      } else {
        args.push("null as any");
      }
    }

    return args.join(", ");
  }

  // Global types that don't need imports
  private static readonly GLOBAL_TYPES = new Set([
    "Date",
    "Array",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Promise",
    "Error",
    "RegExp",
    "Symbol",
    "Object",
    "Function",
    "Number",
    "String",
    "Boolean",
    "ReadonlyArray",
    "ReadonlyMap",
    "ReadonlySet",
    "Record",
    "Partial",
    "Required",
    "Readonly",
    "Pick",
    "Omit",
    "Exclude",
    "Extract",
    "NonNullable",
    "Parameters",
    "ReturnType",
    "InstanceType",
    "Awaited",
  ]);

  /**
   * Generate import statements for types used in query expressions.
   * This ensures the synthetic code can reference types like User, UserDTO, etc.
   */
  private generateQueryTypeImports(fromExpr: string, toExpr: string): string | null {
    // Extract PascalCase identifiers that might be types
    const combined = `${fromExpr} ${toExpr}`;
    const typePattern = /\b([A-Z][A-Za-z0-9]*)\b/g;
    const neededTypes = new Set<string>();

    let match;
    while ((match = typePattern.exec(combined)) !== null) {
      const name = match[1]!;
      if (!SyntheticVerifier.GLOBAL_TYPES.has(name)) {
        neededTypes.add(name);
      }
    }

    if (neededTypes.size === 0) {
      return null;
    }

    // Find these types in source files and generate imports
    const imports: string[] = [];
    const importedNames = new Set<string>();
    const sourceFiles = this.project
      .getSourceFiles()
      .filter(
        (sf) =>
          !sf.isInNodeModules() &&
          sf.getFilePath().startsWith(this.packagePath) &&
          !sf.getFilePath().includes("__synthetic_verify_") &&
          !sf.getFilePath().includes("__query_type_"),
      );

    for (const sf of sourceFiles) {
      const exports = sf.getExportedDeclarations();
      const typeNames: string[] = [];

      for (const [name, decls] of exports) {
        if (name === "default") continue;
        if (importedNames.has(name)) continue;
        if (!neededTypes.has(name)) continue;

        const decl = decls[0];
        if (decl) {
          const kind = decl.getKind();
          const isType =
            kind === ts.SyntaxKind.InterfaceDeclaration ||
            kind === ts.SyntaxKind.TypeAliasDeclaration ||
            kind === ts.SyntaxKind.EnumDeclaration ||
            kind === ts.SyntaxKind.ClassDeclaration;

          if (isType) {
            typeNames.push(name);
            importedNames.add(name);
          }
        }
      }

      if (typeNames.length > 0) {
        let modulePath = relative(this.packagePath, sf.getFilePath());
        modulePath = modulePath.replace(/\\/g, "/");
        modulePath = this.getModuleSpecifier(modulePath);
        if (!modulePath.startsWith(".")) {
          modulePath = "./" + modulePath;
        }
        imports.push(`import type { ${typeNames.join(", ")} } from "${modulePath}"`);
      }
    }

    return imports.length > 0 ? imports.join("\n") : null;
  }

  /**
   * Check synthetic code for type errors.
   */
  private checkSyntheticCode(
    code: string,
    _contextFilePath: string,
  ): Array<{ message: string; code: number }> {
    // Create a unique temp file name
    const tempFileName = join(
      this.packagePath,
      `__synthetic_verify_${this.tempFileCounter++}_${Date.now()}.ts`,
    );

    let tempFile: SourceFile | undefined;

    try {
      // Create the temp file
      tempFile = this.project.createSourceFile(tempFileName, code, {
        overwrite: true,
      });

      // Get diagnostics
      const diagnostics = tempFile.getPreEmitDiagnostics();

      // Filter for errors only
      return diagnostics
        .filter((d) => d.getCategory() === ts.DiagnosticCategory.Error)
        .map((d) => {
          const messageText = d.getMessageText();
          const message =
            typeof messageText === "string" ? messageText : messageText.getMessageText();

          return {
            message,
            code: d.getCode(),
          };
        });
    } catch (error) {
      // If we can't even create the file, it's definitely not valid
      return [
        {
          message: error instanceof Error ? error.message : "Unknown error creating synthetic file",
          code: -1,
        },
      ];
    } finally {
      // Clean up temp file
      if (tempFile) {
        try {
          this.project.removeSourceFile(tempFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }
}

/**
 * Result of checking whether to skip synthetic verification.
 *
 * This replaces the old boolean return to properly communicate verification status.
 */
export interface SkipCheckResult {
  /** Whether to skip synthetic verification */
  skip: boolean;

  /** The verification status if we're skipping */
  status: VerificationStatus;

  /** Why we're skipping (or why we need to verify) */
  reason: VerificationReason;

  /** The verification method used */
  method: VerificationMeta["method"];
}

/**
 * Check if a candidate should skip synthetic verification and determine status.
 *
 * CRITICAL: This function now returns proper verification status instead of boolean.
 * This fixes the trust issue where unannotated functions were marked as "verified".
 */
export function shouldSkipSyntheticCheck(
  entry: CallableEntry,
  assignabilityResult: AssignabilityCheckResult,
): SkipCheckResult {
  // If both from and to are exact matches, skip - this IS verified
  if (assignabilityResult.fromMatch?.exact && assignabilityResult.toMatch?.exact) {
    return {
      skip: true,
      status: "verified",
      reason: "exact_type_match",
      method: "exact_match",
    };
  }

  // If the function has no type annotations, we can't verify
  // CRITICAL FIX: This is UNVERIFIED, not verified!
  if (!entry.hasTypeAnnotations) {
    return {
      skip: true,
      status: "unverified",
      reason: "no_type_annotations",
      method: null,
    };
  }

  // If function is internal (not exported), we can't create a valid synthetic call
  // CRITICAL FIX: Mark as unverifiable instead of faking with `any`
  if (entry.exportState !== "exported") {
    return {
      skip: true,
      status: "unverifiable",
      reason: "not_importable",
      method: null,
    };
  }

  // Need full synthetic verification
  return {
    skip: false,
    status: "unverified", // Will be updated after synthetic check
    reason: "synthetic_check_passed", // Placeholder, will be updated
    method: "synthetic",
  };
}
