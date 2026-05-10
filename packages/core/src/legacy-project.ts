import {
  Project,
  type SourceFile,
  type Symbol,
  SyntaxKind,
  Node,
  TypeFormatFlags,
} from "ts-morph";
import { isAbsolute, join, relative } from "path";

import { getDeclarationName } from "./declarations";
import type { PackageInfo } from "./discovery";
import { getDisplayPropertySymbols } from "./display-properties";
import { inspectSourceFile } from "./file-inspection";
import { collectLoadedPackageDiagnostics, collectPackageDiagnostics } from "./project-diagnostics";
import { kindToString, ProjectWorkspace } from "./project-workspace";
import { previewRenameRefactor } from "./refactor-preview";
import type {
  CompatibilityResult,
  ErrorExplanationIssue,
  ErrorExplanationResult,
  ExpandedType,
  FileInspectionResult,
  GraphResult,
  ListSymbolsOptions,
  RefactorPreviewResult,
  RelatedInfo,
  SnippetCheckResult,
  SymbolInfo,
  SymbolListResult,
  TypeAtPositionResult,
  TypeExplanationResult,
  TypeInfo,
} from "./project-types";
import { SnippetEvaluator } from "./snippet-evaluation";
import { SymbolLookup } from "./symbol-lookup";
import { generateTypeGraph } from "./type-graph";
import { TypeExplainer } from "./type-explanations";
import { TypeRelationExplorer } from "./type-relations";

export type {
  CompatibilityResult,
  ErrorExplanationIssue,
  ErrorExplanationResult,
  ExpandedType,
  FileDeclarationInfo,
  FileInspectionResult,
  GraphEdge,
  GraphResult,
  ListSymbolsOptions,
  RefactorError,
  RefactorLocation,
  RefactorPreviewResult,
  RelatedInfo,
  SnippetCheckResult,
  SnippetDiagnostic,
  StringLiteralRef,
  SymbolInfo,
  SymbolListResult,
  TypeAtPositionResult,
  TypeExplanationResult,
  TypeExplanationStep,
  TypeInfo,
} from "./project-types";

export class ProjectManager {
  private readonly workspace: ProjectWorkspace;
  private readonly symbolLookup: SymbolLookup;
  private readonly snippetEvaluator: SnippetEvaluator;
  private readonly typeRelations: TypeRelationExplorer;
  private readonly typeExplainer: TypeExplainer;

  constructor(directory: string) {
    this.workspace = new ProjectWorkspace(directory);
    this.symbolLookup = new SymbolLookup(this.workspace);
    this.snippetEvaluator = new SnippetEvaluator();
    this.typeRelations = new TypeRelationExplorer({
      relativePath: this.relativePath.bind(this),
    });
    this.typeExplainer = new TypeExplainer({
      getPackageDiagnostics: this.getPackageDiagnostics.bind(this),
      checkCompatibility: this.checkCompatibility.bind(this),
      findSymbol: this.findSymbol.bind(this),
      evalType: this.evalType.bind(this),
    });
  }

  private get rootDirectory(): string {
    return this.workspace.rootDirectory;
  }

  /**
   * Mark the project cache as dirty. Next getProject() call will rebuild.
   * Called by plugin hook after edit/write tool executions.
   */
  markDirty(): void {
    this.workspace.markDirty();
  }

  /**
   * Clear all cached projects. Use when files were modified outside of opencode tools.
   */
  refreshAll(): void {
    this.workspace.refreshAll();
  }

  /**
   * Clear cached project for a specific package.
   */
  async refreshPackage(packageName: string): Promise<boolean> {
    return this.workspace.refreshPackage(packageName);
  }

  async getPackages(): Promise<PackageInfo[]> {
    return this.workspace.getPackages();
  }

  private async resolvePackage(packageName?: string): Promise<PackageInfo> {
    return this.workspace.resolvePackage(packageName);
  }

  private getProject(pkg: PackageInfo): Project {
    return this.workspace.getProject(pkg);
  }

  private getSourceFiles(project: Project, pkg: PackageInfo): SourceFile[] {
    return this.workspace.getSourceFiles(project, pkg);
  }

  private kindToString(kind: SyntaxKind): string {
    return kindToString(kind);
  }

  private relativePath(absolutePath: string): string {
    return this.workspace.relativePath(absolutePath);
  }

  async listSymbols(options: ListSymbolsOptions = {}): Promise<SymbolListResult> {
    const { pattern, kind, packageName, file, limit = 50, indexOnly = false } = options;

    const pkg = await this.resolvePackage(packageName);
    const project = this.getProject(pkg);
    const sourceFiles = this.getSourceFiles(project, pkg);
    const symbols: SymbolInfo[] = [];
    const regex = pattern ? new RegExp(pattern, "i") : null;
    const fileRegex = file ? new RegExp(file, "i") : null;

    for (const sourceFile of sourceFiles) {
      const filePath = this.relativePath(sourceFile.getFilePath());
      const isIndexFile =
        filePath.endsWith("/index") ||
        filePath.endsWith("/index.tsx") ||
        filePath === "index" ||
        filePath === "index.tsx";

      if (indexOnly && !isIndexFile) {
        continue;
      }

      if (fileRegex && !fileRegex.test(filePath)) {
        continue;
      }

      for (const [exportName, declarations] of sourceFile.getExportedDeclarations()) {
        for (const decl of declarations) {
          // Use actual name for default exports (e.g., "ServiceBusSenderService" instead of "default")
          const name =
            exportName === "default" ? (this.getDeclarationName(decl) ?? "default") : exportName;

          const symbolKind = this.kindToString(decl.getKind());

          if (kind && kind !== "all" && symbolKind !== kind) {
            continue;
          }

          if (regex && !regex.test(name)) {
            continue;
          }

          symbols.push({
            name,
            kind: symbolKind,
            file: filePath,
            line: decl.getStartLineNumber(),
            package: pkg.name,
            isIndexExport: isIndexFile,
          });
        }
      }
    }

    symbols.sort((a, b) => {
      if (a.isIndexExport && !b.isIndexExport) return -1;
      if (!a.isIndexExport && b.isIndexExport) return 1;
      return a.name.localeCompare(b.name);
    });

    const total = symbols.length;
    const truncated = total > limit;
    const resultSymbols = truncated ? symbols.slice(0, limit) : symbols;

    return {
      symbols: resultSymbols,
      total,
      truncated,
      package: pkg.name,
    };
  }

  /**
   * Get the actual name of a declaration node (handles default exports).
   * For `export default class Foo`, returns "Foo".
   * For anonymous default exports, returns "default".
   */
  private getDeclarationName(node: Node): string | null {
    return getDeclarationName(node);
  }

  private findSymbol(
    symbolName: string,
    project: Project,
    pkg: PackageInfo,
  ): { node: Node; symbol: Symbol } | null {
    return this.symbolLookup.findSymbol(symbolName, project, pkg);
  }

  async getTypeInfo(symbolName: string, packageName?: string): Promise<TypeInfo | null> {
    const pkg = await this.resolvePackage(packageName);
    const project = this.getProject(pkg);
    const found = this.findSymbol(symbolName, project, pkg);

    if (!found) {
      return null;
    }

    const { node, symbol } = found;
    const type = node.getType();
    const sourceFile = node.getSourceFile();

    const info: TypeInfo = {
      name: symbol.getName(),
      kind: this.kindToString(node.getKind()),
      type: type.getText(node),
      location: {
        file: this.relativePath(sourceFile.getFilePath()),
        line: node.getStartLineNumber(),
      },
      package: pkg.name,
    };

    if (node.getKind() === SyntaxKind.ClassDeclaration) {
      info.signature = `class ${symbol.getName()}`;
    } else if (node.getKind() === SyntaxKind.InterfaceDeclaration) {
      info.signature = `interface ${symbol.getName()}`;
    } else if (node.getKind() === SyntaxKind.TypeAliasDeclaration) {
      info.signature = `type ${symbol.getName()}`;
    } else if (node.getKind() === SyntaxKind.FunctionDeclaration) {
      const callSignatures = type.getCallSignatures();
      if (callSignatures.length > 0) {
        info.signature = callSignatures.map((sig) => sig.getDeclaration().getText()).join("\n");
      }
    }

    const properties = getDisplayPropertySymbols(type, this.rootDirectory);
    if (properties.length > 0) {
      info.properties = properties.map((prop) => {
        const propDecl = prop.getDeclarations()[0];
        const propType = propDecl ? propDecl.getType() : prop.getTypeAtLocation(node);
        return {
          name: prop.getName(),
          type: propType.getText(propDecl ?? node),
          optional: prop.isOptional(),
        };
      });
    }

    if (node.getKind() === SyntaxKind.ClassDeclaration) {
      const constructSignatures = type.getConstructSignatures();
      if (constructSignatures.length > 0) {
        info.constructors = constructSignatures.map((sig) => {
          const params = sig
            .getParameters()
            .map((p) => {
              const paramType = p.getTypeAtLocation(node);
              return `${p.getName()}: ${paramType.getText(node)}`;
            })
            .join(", ");
          const returnType = sig.getReturnType().getText(node);
          return `new (${params}) => ${returnType}`;
        });
      }
    }

    return info;
  }

  async expandType(symbolName: string, packageName?: string): Promise<ExpandedType | null> {
    const pkg = await this.resolvePackage(packageName);
    const project = this.getProject(pkg);
    const found = this.findSymbol(symbolName, project, pkg);

    if (!found) {
      return null;
    }

    const { node } = found;
    const type = node.getType();
    const checker = project.getTypeChecker();

    const original = type.getText(node);
    const expandFlags =
      TypeFormatFlags.NoTruncation |
      TypeFormatFlags.WriteArrayAsGenericType |
      TypeFormatFlags.UseStructuralFallback |
      TypeFormatFlags.WriteTypeArgumentsOfSignature |
      TypeFormatFlags.InTypeAlias |
      TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

    const expanded = checker.compilerObject.typeToString(
      type.compilerType,
      node.compilerNode,
      expandFlags as unknown as number,
    );

    const result: ExpandedType = {
      original,
      expanded,
    };

    const properties = getDisplayPropertySymbols(type, this.rootDirectory);
    if (properties.length > 0) {
      result.properties = properties.map((prop) => {
        const propDecl = prop.getDeclarations()[0];
        const propType = propDecl ? propDecl.getType() : prop.getTypeAtLocation(node);

        let from: string | undefined;
        if (propDecl) {
          const propSourceFile = propDecl.getSourceFile();
          if (!propSourceFile.isInNodeModules()) {
            from = this.relativePath(propSourceFile.getFilePath());
          }
        }

        return {
          name: prop.getName(),
          type: propType.getText(propDecl ?? node),
          ...(from === undefined ? {} : { from }),
        };
      });
    }

    return result;
  }

  async findRelated(symbolName: string, packageName?: string): Promise<RelatedInfo | null> {
    const pkg = await this.resolvePackage(packageName);
    const project = this.getProject(pkg);
    const found = this.findSymbol(symbolName, project, pkg);

    if (!found) {
      return null;
    }

    return this.typeRelations.findRelated(symbolName, project, found);
  }

  async searchTypes(
    options: { pattern?: string; hasProperty?: string; extends?: string; limit?: number },
    packageName?: string,
  ): Promise<SymbolListResult> {
    const limit = options.limit ?? 50;
    const listOptions: ListSymbolsOptions = { kind: "all", limit: 1000 };
    if (options.pattern !== undefined) listOptions.pattern = options.pattern;
    if (packageName !== undefined) listOptions.packageName = packageName;
    const listResult = await this.listSymbols(listOptions);

    const pkg = await this.resolvePackage(packageName);
    const project = this.getProject(pkg);
    const results: SymbolInfo[] = [];

    for (const sym of listResult.symbols) {
      const found = this.findSymbol(sym.name, project, pkg);
      if (!found) continue;

      const { node } = found;
      const type = node.getType();

      if (options.hasProperty) {
        const prop = type.getProperty(options.hasProperty);
        if (!prop) continue;
      }

      if (options.extends) {
        const baseTypes = type.getBaseTypes();
        const hasBase = baseTypes.some((bt) => {
          const baseSymbol = bt.getSymbol();
          return baseSymbol && baseSymbol.getName() === options.extends;
        });
        if (!hasBase) continue;
      }

      results.push(sym);

      if (results.length >= limit) break;
    }

    return {
      symbols: results,
      total: results.length,
      truncated: results.length >= limit,
      package: pkg.name,
    };
  }

  async evalType(
    expression: string,
    packageName?: string,
  ): Promise<{ result: string; expanded: string } | { error: string }> {
    const pkg = await this.resolvePackage(packageName);
    const project = this.getProject(pkg);
    const sourceFiles = this.getSourceFiles(project, pkg);
    return this.snippetEvaluator.evalType(expression, project, pkg, sourceFiles);
  }

  /**
   * Type-check a code snippet without writing to disk.
   * Creates a temporary in-memory source file, collects diagnostics, and cleans up.
   * Useful for validating code before committing to edits.
   */
  async checkSnippet(code: string, packageName?: string): Promise<SnippetCheckResult> {
    const pkg = await this.resolvePackage(packageName);
    const project = this.getProject(pkg);
    const sourceFiles = this.getSourceFiles(project, pkg);
    return this.snippetEvaluator.checkSnippet(code, project, pkg, sourceFiles);
  }

  async getFileDeclarations(
    filePath: string,
    options: { symbol?: string; includePrivate?: boolean; packageName?: string } = {},
  ): Promise<FileInspectionResult | null> {
    const pkg = await this.resolvePackage(options.packageName);
    const project = this.getProject(pkg);

    // Normalize the file path - support both relative and absolute
    const targetPath = isAbsolute(filePath) ? filePath : join(this.rootDirectory, filePath);

    // Find the source file
    const sourceFile = project.getSourceFile(targetPath);
    if (!sourceFile) {
      // Try finding by partial match
      const allFiles = this.getSourceFiles(project, pkg);
      const matchingFile = allFiles.find((sf) => {
        const sfPath = sf.getFilePath();
        return sfPath.endsWith(filePath) || sfPath.includes(filePath);
      });

      if (!matchingFile) {
        return null;
      }

      return this.inspectSourceFile(matchingFile, pkg, options);
    }

    return this.inspectSourceFile(sourceFile, pkg, options);
  }

  private inspectSourceFile(
    sourceFile: SourceFile,
    pkg: PackageInfo,
    options: { symbol?: string; includePrivate?: boolean },
  ): FileInspectionResult {
    return inspectSourceFile(sourceFile, pkg, options, {
      kindToString: this.kindToString.bind(this),
      relativePath: this.relativePath.bind(this),
    });
  }

  async checkCompatibility(
    fromSymbol: string,
    toSymbol: string,
    packageName?: string,
  ): Promise<CompatibilityResult> {
    const pkg = await this.resolvePackage(packageName);
    const project = this.getProject(pkg);

    const fromFound = this.findSymbol(fromSymbol, project, pkg);
    const toFound = this.findSymbol(toSymbol, project, pkg);

    if (!fromFound) {
      const message = `Symbol "${fromSymbol}" not found`;
      return {
        compatible: false,
        from: fromSymbol,
        to: toSymbol,
        reason: message,
        issues: [{ kind: "other", message }],
      };
    }

    if (!toFound) {
      const message = `Symbol "${toSymbol}" not found`;
      return {
        compatible: false,
        from: fromSymbol,
        to: toSymbol,
        reason: message,
        issues: [{ kind: "other", message }],
      };
    }

    const fromType = fromFound.node.getType();
    const toType = toFound.node.getType();

    const fromTypeText = fromType.getText(fromFound.node);
    const toTypeText = toType.getText(toFound.node);

    // Check assignability using ts-morph's isAssignableTo
    const isAssignable = fromType.isAssignableTo(toType);

    if (isAssignable) {
      return {
        compatible: true,
        from: fromTypeText,
        to: toTypeText,
      };
    }

    const reasons: string[] = [];
    const issues: ErrorExplanationIssue[] = [];

    const toProperties = toType.getProperties();
    const fromProperties = fromType.getProperties();
    const fromPropNames = new Set(fromProperties.map((p) => p.getName()));

    for (const toProp of toProperties) {
      const propName = toProp.getName();
      if (!toProp.isOptional() && !fromPropNames.has(propName)) {
        const propType = toProp.getTypeAtLocation(toFound.node).getText(toFound.node);
        const message = `Property '${propName}' is missing in type '${fromTypeText}' but required in type '${toTypeText}' (expected: ${propType})`;
        reasons.push(message);
        issues.push({
          kind: "missing_property",
          property: propName,
          expectedType: propType,
          message,
        });
      }
    }

    for (const fromProp of fromProperties) {
      const propName = fromProp.getName();
      const toProp = toType.getProperty(propName);

      if (toProp) {
        const fromPropType = fromProp.getTypeAtLocation(fromFound.node);
        const toPropType = toProp.getTypeAtLocation(toFound.node);

        if (!fromPropType.isAssignableTo(toPropType)) {
          const fromPropText = fromPropType.getText(fromFound.node);
          const toPropText = toPropType.getText(toFound.node);
          const message = `Property '${propName}' has incompatible types: '${fromPropText}' is not assignable to '${toPropText}'`;
          reasons.push(message);
          issues.push({
            kind: "type_mismatch",
            property: propName,
            actualType: fromPropText,
            expectedType: toPropText,
            message,
          });
        }
      }
    }

    const fromCallSigs = fromType.getCallSignatures();
    const toCallSigs = toType.getCallSignatures();

    if (toCallSigs.length > 0 && fromCallSigs.length === 0) {
      const message = `Type '${fromTypeText}' is not callable but '${toTypeText}' requires call signatures`;
      reasons.push(message);
      issues.push({ kind: "not_callable", message });
    }

    if (reasons.length === 0) {
      const message = `Type '${fromTypeText}' is not assignable to type '${toTypeText}'`;
      reasons.push(message);
      issues.push({ kind: "other", message });
    }

    return {
      compatible: false,
      from: fromTypeText,
      to: toTypeText,
      reason: reasons.join("; "),
      issues,
    };
  }

  async generateGraph(
    symbolName: string,
    options: { depth?: number; format?: "mermaid" | "dot"; packageName?: string } = {},
  ): Promise<GraphResult | null> {
    const { packageName } = options;
    const pkg = await this.resolvePackage(packageName);
    const project = this.getProject(pkg);
    return generateTypeGraph(symbolName, options, project, pkg, {
      findSymbol: this.findSymbol.bind(this),
      findRelated: this.findRelated.bind(this),
    });
  }

  async previewRefactor(options: {
    action: "rename";
    symbol: string;
    to: string;
    packageName?: string;
  }): Promise<RefactorPreviewResult> {
    const pkg = await this.resolvePackage(options.packageName);
    const project = this.getProject(pkg);

    const found = this.findSymbol(options.symbol, project, pkg);
    if (!found) {
      throw new Error(`Symbol "${options.symbol}" not found`);
    }

    return previewRenameRefactor(options, project, pkg, found, {
      relativePath: this.relativePath.bind(this),
    });
  }

  /**
   * Get the type of an expression at a specific file position.
   * Useful for understanding inferred types without needing a named symbol.
   */
  async getTypeAtPosition(
    filePath: string,
    line: number,
    column: number,
    packageName?: string,
  ): Promise<TypeAtPositionResult | null> {
    const pkg = await this.resolvePackage(packageName);
    const project = this.getProject(pkg);
    const checker = project.getTypeChecker();

    // Normalize the file path
    const targetPath = isAbsolute(filePath) ? filePath : join(this.rootDirectory, filePath);

    // Find the source file
    let sourceFile = project.getSourceFile(targetPath);
    if (!sourceFile) {
      // Try finding by partial match
      const allFiles = this.getSourceFiles(project, pkg);
      const matchingFile = allFiles.find((sf) => {
        const sfPath = sf.getFilePath();
        return sfPath.endsWith(filePath) || sfPath.includes(filePath);
      });

      if (!matchingFile) {
        return null;
      }
      sourceFile = matchingFile;
    }

    // Convert line/column to position (0-based internally)
    const pos = sourceFile.compilerNode.getPositionOfLineAndCharacter(line - 1, column - 1);

    // Find the node at this position
    const node = this.getDescendantAtPos(sourceFile, pos);
    if (!node) {
      return null;
    }

    // Get the type at this location
    const type = node.getType();
    const nodeText = node.getText();

    // Get both simple and expanded type representations
    const simpleType = type.getText(node);

    const expandFlags =
      TypeFormatFlags.NoTruncation |
      TypeFormatFlags.WriteArrayAsGenericType |
      TypeFormatFlags.UseStructuralFallback |
      TypeFormatFlags.WriteTypeArgumentsOfSignature |
      TypeFormatFlags.InTypeAlias;

    const expanded = checker.compilerObject.typeToString(
      type.compilerType,
      node.compilerNode,
      expandFlags as unknown as number,
    );

    return {
      type: simpleType,
      expanded,
      nodeKind: this.kindToString(node.getKind()),
      nodeText: nodeText.length > 100 ? nodeText.slice(0, 100) + "..." : nodeText,
      location: {
        file: this.relativePath(sourceFile.getFilePath()),
        line: node.getStartLineNumber(),
        column: node.getStartLineNumber() === line ? column : 1,
      },
    };
  }

  /**
   * Find the most specific node at a given position.
   * Walks down the AST to find the innermost node containing the position.
   */
  private getDescendantAtPos(sourceFile: SourceFile, pos: number): Node | null {
    let result: Node | null = null;

    const visit = (node: Node): void => {
      const start = node.getStart();
      const end = node.getEnd();

      if (pos >= start && pos <= end) {
        result = node;
        // Continue to children to find more specific node
        node.forEachChild(visit);
      }
    };

    sourceFile.forEachChild(visit);
    return result;
  }

  // === Public API for Transform Search ===

  /**
   * Public wrapper for resolvePackage.
   */
  async resolvePackagePublic(packageName?: string): Promise<PackageInfo> {
    return this.resolvePackage(packageName);
  }

  /**
   * Public wrapper for getProject.
   */
  getProjectPublic(pkg: PackageInfo): Project {
    return this.getProject(pkg);
  }

  /**
   * Public wrapper for getSourceFiles.
   */
  getSourceFilesPublic(project: Project, pkg: PackageInfo): SourceFile[] {
    return this.getSourceFiles(project, pkg);
  }

  /**
   * Resolve which package a file belongs to based on its path.
   * Returns undefined if the file doesn't belong to any known package.
   */
  async resolvePackageForFile(filePath: string): Promise<PackageInfo | undefined> {
    const packages = await this.getPackages();
    const absolutePath = isAbsolute(filePath) ? filePath : join(this.rootDirectory, filePath);

    // Find the package whose path is a prefix of the file path
    // Sort by path length descending to match the most specific package first
    const sortedPackages = [...packages].sort((a, b) => b.path.length - a.path.length);

    for (const pkg of sortedPackages) {
      if (absolutePath.startsWith(pkg.path)) {
        return pkg;
      }
    }

    return undefined;
  }

  /**
   * Get all pre-emit diagnostics (type errors) for a specific package.
   * Returns an array of diagnostic info with file, line, and message.
   */
  async getPackageDiagnostics(
    packageName?: string,
  ): Promise<Array<{ file: string; line: number; column: number; message: string; code: number }>> {
    const pkg = await this.resolvePackage(packageName);
    const project = this.getProject(pkg);
    return collectPackageDiagnostics(project, pkg, {
      relativePath: this.relativePath.bind(this),
    });
  }

  /**
   * Get diagnostics for all loaded/touched packages.
   * Only checks packages that have been loaded into the cache.
   */
  async getDiagnosticsForLoadedPackages(): Promise<
    Map<
      string,
      Array<{ file: string; line: number; column: number; message: string; code: number }>
    >
  > {
    return collectLoadedPackageDiagnostics(this.workspace.getCachedProjects(), {
      relativePath: this.relativePath.bind(this),
    });
  }

  /**
   * Explain a TypeScript error in human terms.
   * Provides context about what went wrong, why, and how to fix it.
   */
  async explainError(options: {
    code?: number;
    message?: string;
    file?: string;
    line?: number;
    packageName?: string;
  }): Promise<ErrorExplanationResult | null> {
    const pkg = await this.resolvePackage(options.packageName);
    const project = this.getProject(pkg);
    return this.typeExplainer.explainError(options, project, pkg);
  }

  /**
   * Explain a complex type expression step by step.
   * Shows how utility types and generics are resolved.
   */
  async explainType(expression: string, packageName?: string): Promise<TypeExplanationResult> {
    const _pkg = await this.resolvePackage(packageName);
    this.getProject(_pkg); // Ensure project is loaded for evalType
    return this.typeExplainer.explainType(expression, packageName);
  }
}
