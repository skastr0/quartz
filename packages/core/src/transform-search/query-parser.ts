/**
 * Query Parser
 *
 * Parse and resolve query type expressions including inline structural types.
 * Supports both named type references and inline type expressions.
 *
 * Examples:
 * - Named: "User", "Namespace.Type", "Promise<User>"
 * - Inline: "{ id: string; name: string }", "User | Admin"
 */

import { type Project, type SourceFile, type Type, ts } from "ts-morph";
import { join, relative } from "path";

/**
 * Whether the query type is a symbol reference or an inline expression.
 */
export type QueryTypeKind = "symbol" | "expression";

/**
 * A parsed and resolved query type.
 */
export interface QueryType {
  /** Whether this is a symbol reference or inline expression */
  kind: QueryTypeKind;

  /** Original input from user */
  raw: string;

  /** Resolved TypeScript type (null if resolution failed) */
  resolvedType: Type | null;

  /** Error message if resolution failed */
  error: string | null;

  /** Extracted tokens for Layer B filtering (works even if resolution fails) */
  tokens: string[];

  /** Extracted property keys for filtering */
  propKeys: string[];
}

/**
 * A fully parsed query ready for search.
 */
export interface ParsedQuery {
  /** Parsed "from" type constraint */
  from: QueryType | null;

  /** Parsed "to" type constraint */
  to: QueryType | null;

  /** Which parameter position to match (default: 0) */
  paramPosition: number | "any";

  /** Whether to consider unwrapped return types */
  unwrapReturn: boolean;

  /** Only search exported functions */
  exportedOnly: boolean;

  /** Maximum results to return */
  limit: number;

  /** Whether the query is valid */
  isValid: boolean;

  /** Validation errors if invalid */
  validationErrors: string[];
}

/**
 * Options for parsing a query.
 */
export interface QueryParseOptions {
  from?: string;
  to?: string;
  paramPosition?: number | "any";
  unwrapReturn?: boolean;
  exportedOnly?: boolean;
  limit?: number;
}

/**
 * Parses type expressions for transform search queries.
 */
export class QueryParser {
  private project: Project;
  private packagePath: string;
  private tempFileCounter = 0;
  private useJsExtension: boolean;

  /**
   * Temp files created during query parsing.
   * Must be cleaned up after the search is complete via cleanup().
   */
  private tempFiles: SourceFile[] = [];

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
      // These require .js extensions for ESM imports
      if (moduleResolution === 99 || moduleResolution === 3) {
        return true;
      }

      // Also check the module setting
      const module = compilerOptions.module;
      // ts.ModuleKind values for ESM that need extensions:
      // NodeNext = 199, Node16 = 100
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
    let modulePath = relative(this.packagePath, filePath);
    modulePath = modulePath.replace(/\\/g, "/");

    if (this.useJsExtension) {
      // NodeNext/Node16: replace .ts/.tsx with .js
      modulePath = modulePath.replace(/\.tsx?$/, ".js");
    } else {
      // Bundler/Classic: strip extension entirely
      modulePath = modulePath.replace(/\.(ts|tsx)$/, "");
    }

    if (!modulePath.startsWith(".")) {
      modulePath = "./" + modulePath;
    }

    return modulePath;
  }

  /**
   * Clean up any temp files created during query parsing.
   * Call this after the search is complete.
   */
  cleanup(): void {
    for (const tempFile of this.tempFiles) {
      try {
        this.project.removeSourceFile(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
    this.tempFiles = [];
  }

  /**
   * Parse and resolve a transform search query.
   */
  parseQuery(input: QueryParseOptions): ParsedQuery {
    const errors: string[] = [];

    // Validate at least one constraint
    if (!input.from && !input.to) {
      errors.push("At least one of 'from' or 'to' is required");
    }

    // Parse type expressions
    const fromQuery = input.from ? this.parseTypeExpression(input.from) : null;
    const toQuery = input.to ? this.parseTypeExpression(input.to) : null;

    // Collect resolution errors
    if (fromQuery?.error) errors.push(`from: ${fromQuery.error}`);
    if (toQuery?.error) errors.push(`to: ${toQuery.error}`);

    return {
      from: fromQuery,
      to: toQuery,
      paramPosition: input.paramPosition ?? 0,
      unwrapReturn: input.unwrapReturn ?? true,
      exportedOnly: input.exportedOnly ?? true,
      limit: input.limit ?? 25,
      isValid: errors.length === 0,
      validationErrors: errors,
    };
  }

  /**
   * Parse a single type expression.
   */
  private parseTypeExpression(expr: string): QueryType {
    const trimmed = expr.trim();

    // Detect if this is an inline expression or a symbol reference
    const kind = this.detectExpressionKind(trimmed);

    // Extract tokens for filtering (works even if resolution fails)
    const { tokens, propKeys } = this.extractTokensFromExpression(trimmed);

    // Try to resolve to an actual type
    const resolution =
      kind === "symbol" ? this.resolveSymbol(trimmed) : this.resolveInlineExpression(trimmed);

    return {
      kind,
      raw: trimmed,
      resolvedType: resolution.type,
      error: resolution.error,
      tokens,
      propKeys,
    };
  }

  /**
   * Detect whether an expression is a symbol reference or inline type.
   */
  private detectExpressionKind(expr: string): QueryTypeKind {
    // Object literal
    if (expr.startsWith("{")) {
      return "expression";
    }

    // Parenthesized or tuple
    if (expr.startsWith("(") || expr.startsWith("[")) {
      return "expression";
    }

    // Function type
    if (expr.includes("=>")) {
      return "expression";
    }

    // Union or intersection without being a generic
    if ((expr.includes("|") || expr.includes("&")) && !expr.includes("<")) {
      return "expression";
    }

    // Check for generic with union/intersection inside
    if (expr.includes("<") && (expr.includes("|") || expr.includes("&"))) {
      // e.g., "Map<string, User | Admin>" - still a symbol
      const beforeAngle = expr.split("<")[0];
      if (beforeAngle && /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(beforeAngle)) {
        return "symbol";
      }
      return "expression";
    }

    // Simple identifier or qualified name (with or without generics)
    if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*(<.*>)?$/.test(expr)) {
      return "symbol";
    }

    // Array type
    if (expr.endsWith("[]")) {
      return "expression";
    }

    // Default to expression for safety
    return "expression";
  }

  // Built-in primitive types (lowercase keywords)
  private static readonly PRIMITIVE_TYPES = new Set([
    "string",
    "number",
    "boolean",
    "symbol",
    "undefined",
    "null",
    "void",
    "never",
    "unknown",
    "any",
    "object",
    "bigint",
  ]);

  // Global object types available in TypeScript
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
   * Resolve a symbol reference to a type.
   */
  private resolveSymbol(symbolName: string): { type: Type | null; error: string | null } {
    try {
      // Handle built-in primitive types (string, number, etc.)
      if (QueryParser.PRIMITIVE_TYPES.has(symbolName)) {
        return this.resolveInlineExpression(symbolName);
      }

      // Handle global types (Date, Array, Map, etc.)
      // Also check the base name for generics like Array<T>
      const baseName = symbolName.split("<")[0] ?? symbolName;
      if (QueryParser.GLOBAL_TYPES.has(baseName)) {
        return this.resolveInlineExpression(symbolName);
      }

      // Handle generic instantiations like Promise<User>
      const genericMatch = symbolName.match(/^([A-Za-z_][A-Za-z0-9_.]*)<(.+)>$/);
      if (genericMatch) {
        // Treat as expression to properly instantiate the generic
        return this.resolveInlineExpression(symbolName);
      }

      // Find the symbol in source files
      const sourceFiles = this.getSourceFiles();

      for (const sf of sourceFiles) {
        const exports = sf.getExportedDeclarations();

        // Check for exact match
        const decls = exports.get(symbolName);
        if (decls && decls.length > 0) {
          const node = decls[0]!;
          return { type: node.getType(), error: null };
        }

        // Check for qualified name (e.g., Namespace.Type)
        if (symbolName.includes(".")) {
          const parts = symbolName.split(".");
          const rootName = parts[0]!;
          const rootDecls = exports.get(rootName);

          if (rootDecls && rootDecls.length > 0) {
            let currentType = rootDecls[0]!.getType();

            for (let i = 1; i < parts.length; i++) {
              const prop = currentType.getProperty(parts[i]!);
              if (!prop) {
                return {
                  type: null,
                  error: `Property '${parts[i]}' not found on '${parts.slice(0, i).join(".")}'`,
                };
              }
              const propDecl = prop.getDeclarations()[0];
              if (propDecl) {
                currentType = propDecl.getType();
              } else {
                return { type: null, error: `Cannot resolve '${parts[i]}'` };
              }
            }

            return { type: currentType, error: null };
          }
        }
      }

      return { type: null, error: `Symbol '${symbolName}' not found` };
    } catch (e) {
      return {
        type: null,
        error: `Failed to resolve '${symbolName}': ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Resolve an inline type expression.
   *
   * Note: Temp files are kept alive until cleanup() is called.
   * This is necessary because the resolved Type objects need their
   * source file context for assignability checking.
   *
   * We use `declare const` instead of `type alias` to get the raw type
   * without alias wrapping. This ensures assignability checks work correctly
   * since TypeScript treats type aliases as distinct types in some contexts.
   */
  private resolveInlineExpression(expr: string): { type: Type | null; error: string | null } {
    // Use unique identifiers for both file name and variable
    // This prevents "Duplicate identifier" errors when multiple queries are parsed
    const uniqueId = `${this.tempFileCounter++}_${Date.now()}`;
    const tempFileName = join(this.packagePath, `__query_type_${uniqueId}.ts`);
    const varName = `__queryValue_${uniqueId}`;

    // Extract identifiers used in the expression for lazy import resolution
    const usedIdentifiers = this.extractIdentifiersFromExpression(expr);

    // Generate imports only for referenced types (prevents duplicate identifier errors)
    const imports = this.generateImports(usedIdentifiers);

    // Use declare const to get the raw type without alias wrapping
    const tempCode = `${imports}

declare const ${varName}: ${expr};
`;

    try {
      const tempFile = this.project.createSourceFile(tempFileName, tempCode, {
        overwrite: true,
      });

      // Check for syntax/semantic errors
      const diagnostics = tempFile.getPreEmitDiagnostics();
      const errors = diagnostics.filter((d) => d.getCategory() === ts.DiagnosticCategory.Error);

      if (errors.length > 0) {
        // On error, we can remove the temp file immediately
        this.project.removeSourceFile(tempFile);
        const messages = errors.map((e) => {
          const text = e.getMessageText();
          return typeof text === "string" ? text : text.getMessageText();
        });
        return { type: null, error: `Invalid type expression: ${messages.join("; ")}` };
      }

      // Get the resolved type from the variable declaration
      const varDecl = tempFile.getVariableDeclaration(varName);
      if (!varDecl) {
        this.project.removeSourceFile(tempFile);
        return { type: null, error: "Failed to create variable declaration" };
      }

      // IMPORTANT: Keep the temp file alive for assignability checking.
      // It will be cleaned up when cleanup() is called.
      this.tempFiles.push(tempFile);

      // Return the type of the variable, which is the raw type without alias
      return { type: varDecl.getType(), error: null };
    } catch (e) {
      return {
        type: null,
        error: `Failed to parse expression: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Extract identifiers that might need to be imported from an expression.
   * Returns PascalCase identifiers that could be type references.
   */
  private extractIdentifiersFromExpression(expr: string): Set<string> {
    const identifiers = new Set<string>();

    // Extract PascalCase identifiers (likely type names)
    const typePattern = /\b([A-Z][A-Za-z0-9]*)\b/g;
    let match;
    while ((match = typePattern.exec(expr)) !== null) {
      const name = match[1]!;
      // Skip built-in types
      if (!QueryParser.GLOBAL_TYPES.has(name)) {
        identifiers.add(name);
      }
    }

    return identifiers;
  }

  /**
   * Generate imports for package types.
   * @param neededIdentifiers If provided, only import these specific identifiers.
   *                          This prevents duplicate identifier errors when multiple
   *                          files export the same type name.
   */
  private generateImports(neededIdentifiers?: Set<string>): string {
    const lines: string[] = [];
    const sourceFiles = this.getSourceFiles();
    const importedNames = new Set<string>(); // Track imported names to avoid duplicates

    // Collect exports from each file
    for (const sf of sourceFiles) {
      const exports = sf.getExportedDeclarations();
      const typeNames: string[] = [];

      for (const [name, decls] of exports) {
        if (name === "default") continue;

        // Skip if we've already imported this name from another file
        if (importedNames.has(name)) continue;

        // Skip if we have a filter and this name isn't needed
        if (neededIdentifiers && !neededIdentifiers.has(name)) continue;

        const decl = decls[0];
        if (decl && this.isTypeDeclaration(decl)) {
          typeNames.push(name);
          importedNames.add(name);
        }
      }

      if (typeNames.length > 0 && typeNames.length < 50) {
        const modulePath = this.getModuleSpecifier(sf.getFilePath());
        lines.push(`import type { ${typeNames.join(", ")} } from "${modulePath}"`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Check if a node is a type declaration.
   */
  private isTypeDeclaration(node: import("ts-morph").Node): boolean {
    const kind = node.getKind();
    return (
      kind === ts.SyntaxKind.InterfaceDeclaration ||
      kind === ts.SyntaxKind.TypeAliasDeclaration ||
      kind === ts.SyntaxKind.EnumDeclaration ||
      kind === ts.SyntaxKind.ClassDeclaration
    );
  }

  /**
   * Extract tokens from an expression for filtering.
   */
  private extractTokensFromExpression(expr: string): { tokens: string[]; propKeys: string[] } {
    const tokens: string[] = [];
    const propKeys: string[] = [];

    // Extract identifiers that look like type names (PascalCase)
    const typePattern = /\b([A-Z][A-Za-z0-9]*)\b/g;
    let match;
    while ((match = typePattern.exec(expr)) !== null) {
      if (!tokens.includes(match[1]!)) {
        tokens.push(match[1]!);
      }
    }

    // Extract property keys from object literals
    const propPattern = /([a-zA-Z_][a-zA-Z0-9_]*)\s*[?]?\s*:/g;
    while ((match = propPattern.exec(expr)) !== null) {
      const key = match[1]!;
      // Skip if it looks like a type name (PascalCase)
      if (!/^[A-Z]/.test(key) && !propKeys.includes(key)) {
        propKeys.push(key);
      }
    }

    return { tokens, propKeys };
  }

  /**
   * Get source files in the package (excluding node_modules and temp query files).
   */
  private getSourceFiles(): SourceFile[] {
    return this.project.getSourceFiles().filter((sf) => {
      if (sf.isInNodeModules()) return false;
      const filePath = sf.getFilePath();
      // Exclude temp query files (which are created by this class)
      if (filePath.includes("__query_type_")) return false;
      return filePath.startsWith(this.packagePath);
    });
  }
}
