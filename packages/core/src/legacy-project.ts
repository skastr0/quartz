import {
  Project,
  type SourceFile,
  type Symbol,
  SyntaxKind,
  Node,
  TypeFormatFlags,
  type MethodDeclaration,
  type FunctionDeclaration,
  type ParameterDeclaration,
} from "ts-morph";
import { isAbsolute, join, relative, dirname, resolve } from "path";
import { Effect } from "effect";

import { discoverPackages, type PackageInfo } from "./discovery";
import { getDisplayPropertySymbols } from "./display-properties";

export interface SymbolInfo {
  name: string;
  kind: string;
  file: string;
  line?: number;
  package?: string;
  isIndexExport?: boolean;
}

export interface SymbolListResult {
  symbols: SymbolInfo[];
  total: number;
  truncated: boolean;
  package: string;
}

export interface ListSymbolsOptions {
  pattern?: string;
  kind?: string;
  packageName?: string;
  file?: string;
  limit?: number;
  indexOnly?: boolean;
}

export interface TypeInfo {
  name: string;
  kind: string;
  type: string;
  signature?: string;
  properties?: Array<{ name: string; type: string; optional?: boolean }>;
  constructors?: string[];
  location: { file: string; line: number };
  package?: string;
}

export interface ExpandedType {
  original: string;
  expanded: string;
  properties?: Array<{ name: string; type: string; from?: string }>;
}

export interface RelatedInfo {
  symbol: string;
  referencedBy: Array<{ symbol: string; context: string; file: string; line: number }>;
  references: Array<{ symbol: string; context: string }>;
}

export interface FileDeclarationInfo {
  name: string;
  kind: string;
  line: number;
  exported: boolean;
  isDefaultExport: boolean;
  exportedAs?: string; // If exported under a different name (e.g., export { Foo as Bar })
  type?: string;
  signature?: string;
}

export interface FileInspectionResult {
  file: string;
  package: string;
  declarations: FileDeclarationInfo[];
  total: number;
}

interface FileExportMetadata {
  exportedNames: Set<string>;
  defaultExportNames: Set<string>;
  exportAliases: Map<string, string>;
}

export interface CompatibilityResult {
  compatible: boolean;
  from: string;
  to: string;
  reason?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface GraphResult {
  root: string;
  format: "mermaid" | "dot";
  depth: number;
  nodes: string[];
  edges: GraphEdge[];
  graph: string;
}

export interface RefactorLocation {
  file: string;
  line: number;
  column: number;
  before: string;
  after: string;
}

export interface RefactorError {
  file: string;
  line: number;
  message: string;
}

export interface StringLiteralRef {
  file: string;
  line: number;
  content: string;
}

export interface RefactorPreviewResult {
  action: "rename";
  from: string;
  to: string;
  locations: RefactorLocation[];
  totalLocations: number;
  predictedErrors: RefactorError[];
  confidence: "high" | "medium" | "low";
  safe: boolean;
  safetyNotes: string[];
  stringLiteralLocations: StringLiteralRef[];
  commentLocations: StringLiteralRef[];
}

export interface SnippetDiagnostic {
  message: string;
  line: number;
  column: number;
  severity: "error" | "warning";
}

export interface TypeAtPositionResult {
  type: string;
  expanded: string;
  nodeKind: string;
  nodeText: string;
  location: { file: string; line: number; column: number };
}

export interface SnippetCheckResult {
  valid: boolean;
  errors?: SnippetDiagnostic[];
}

interface SnippetExportSource {
  filePath: string;
  absolutePath: string;
  isDefault: boolean;
}

interface SnippetImportPlan {
  fileContent: string;
  importLineCount: number;
}

export interface ErrorExplanationIssue {
  kind: "missing_property" | "type_mismatch" | "excess_property" | "not_callable" | "other";
  property?: string;
  expectedType?: string;
  actualType?: string;
  message: string;
}

export interface ErrorExplanationResult {
  error: {
    code: number;
    message: string;
  };
  explanation: string;
  types?: {
    from?: { name: string; expanded: string };
    to?: { name: string; expanded: string };
    target?: { name: string; expanded: string };
  };
  issues: ErrorExplanationIssue[];
  suggestions: string[];
}

export interface TypeExplanationStep {
  step: number;
  description: string;
  expression: string;
  result: string;
}

export interface TypeExplanationResult {
  expression: string;
  steps: TypeExplanationStep[];
  final: string;
}

interface CachedProject {
  project: Project;
  packageInfo: PackageInfo;
  timestamp: number;
}

const CACHE_TTL = 60_000; // 60 seconds TTL for MCP environments without tool hooks
const MAX_CACHED_PROJECTS = 5; // LRU cache size limit

/**
 * Simple LRU cache using Map's insertion order.
 * Most recently used items are at the end.
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();

  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first item)
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  keys(): MapIterator<K> {
    return this.cache.keys();
  }
}

export class ProjectManager {
  private rootDirectory: string;
  private packages: PackageInfo[] | null = null;
  private projectCache = new LRUCache<string, CachedProject>(MAX_CACHED_PROJECTS);
  private projectErrors: Map<string, string> = new Map();
  private dirty = false;

  constructor(directory: string) {
    this.rootDirectory = resolve(directory);
  }

  /**
   * Mark the project cache as dirty. Next getProject() call will rebuild.
   * Called by plugin hook after edit/write tool executions.
   */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Clear all cached projects. Use when files were modified outside of opencode tools.
   */
  refreshAll(): void {
    this.projectCache.clear();
    this.projectErrors.clear();
  }

  /**
   * Clear cached project for a specific package.
   */
  async refreshPackage(packageName: string): Promise<boolean> {
    const pkg = await this.resolvePackage(packageName);
    const deleted = this.projectCache.delete(pkg.tsconfigPath);
    this.projectErrors.delete(pkg.tsconfigPath);
    return deleted;
  }

  async getPackages(): Promise<PackageInfo[]> {
    if (!this.packages) {
      this.packages = [...(await Effect.runPromise(discoverPackages(this.rootDirectory)))];
    }
    return this.packages ?? [];
  }

  private async resolvePackage(packageName?: string): Promise<PackageInfo> {
    const packages = await this.getPackages();

    if (!packageName) {
      const rootPkg = packages.find((p) => p.name === "(root)");
      if (rootPkg) return rootPkg;
      if (packages.length === 1) return packages[0]!;
      throw new Error(
        `Multiple packages found. Please specify a package: ${packages.map((p) => p.name).join(", ")}`,
      );
    }

    const pkg = packages.find(
      (p) =>
        p.name === packageName ||
        p.name === packageName.replace(/^\//, "") ||
        p.path.endsWith(packageName),
    );

    if (!pkg) {
      throw new Error(
        `Package "${packageName}" not found. Available: ${packages.map((p) => p.name).join(", ")}`,
      );
    }

    return pkg;
  }

  private getProject(pkg: PackageInfo): Project {
    // If marked dirty, clear entire cache
    if (this.dirty) {
      this.projectCache.clear();
      this.projectErrors.clear();
      this.dirty = false;
    }

    const cached = this.projectCache.get(pkg.tsconfigPath);
    if (cached) {
      // Check TTL - invalidate if expired (fallback for MCP environments)
      if (Date.now() - cached.timestamp > CACHE_TTL) {
        this.projectCache.delete(pkg.tsconfigPath);
        this.projectErrors.delete(pkg.tsconfigPath);
      } else {
        return cached.project;
      }
    }

    const error = this.projectErrors.get(pkg.tsconfigPath);
    if (error) throw new Error(error);

    try {
      const project = new Project({
        tsConfigFilePath: pkg.tsconfigPath,
        skipAddingFilesFromTsConfig: false,
      });

      this.projectCache.set(pkg.tsconfigPath, { project, packageInfo: pkg, timestamp: Date.now() });
      return project;
    } catch (err) {
      const errorMsg = `Failed to initialize TypeScript project for ${pkg.name}: ${err instanceof Error ? err.message : String(err)}`;
      this.projectErrors.set(pkg.tsconfigPath, errorMsg);
      throw new Error(errorMsg);
    }
  }

  private getSourceFiles(project: Project, pkg: PackageInfo): SourceFile[] {
    return project.getSourceFiles().filter((sf) => {
      if (sf.isInNodeModules()) return false;
      const filePath = sf.getFilePath();
      return filePath.startsWith(pkg.path);
    });
  }

  private kindToString(kind: SyntaxKind): string {
    switch (kind) {
      case SyntaxKind.InterfaceDeclaration:
        return "interface";
      case SyntaxKind.TypeAliasDeclaration:
        return "type";
      case SyntaxKind.ClassDeclaration:
        return "class";
      case SyntaxKind.FunctionDeclaration:
        return "function";
      case SyntaxKind.VariableDeclaration:
        return "variable";
      case SyntaxKind.EnumDeclaration:
        return "enum";
      case SyntaxKind.ModuleDeclaration:
        return "module";
      default:
        return SyntaxKind[kind] ?? "unknown";
    }
  }

  private relativePath(absolutePath: string): string {
    if (absolutePath.startsWith(this.rootDirectory)) {
      return absolutePath.slice(this.rootDirectory.length + 1);
    }
    return absolutePath;
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

  private findLocalVariable(
    parentNode: Node,
    varName: string,
  ): { node: Node; symbol: Symbol } | null {
    const body = this.getFunctionBody(parentNode);
    if (!body) return null;

    const varDeclarations = body.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
    for (const varDecl of varDeclarations) {
      if (varDecl.getName() === varName) {
        const symbol = varDecl.getSymbol();
        if (symbol) {
          return { node: varDecl, symbol };
        }
      }
    }

    const params = this.getFunctionParameters(parentNode);
    for (const param of params) {
      if (param.getName() === varName) {
        const symbol = param.getSymbol();
        if (symbol) {
          return { node: param, symbol };
        }
      }
    }

    return null;
  }

  private getFunctionBody(node: Node): Node | null {
    if (node.getKind() === SyntaxKind.MethodDeclaration) {
      return (node as MethodDeclaration).getBody() ?? null;
    }
    if (node.getKind() === SyntaxKind.FunctionDeclaration) {
      return (node as FunctionDeclaration).getBody() ?? null;
    }
    if (node.getKind() === SyntaxKind.ArrowFunction) {
      return node.getChildAtIndex(node.getChildCount() - 1);
    }
    return null;
  }

  private getFunctionParameters(node: Node): ParameterDeclaration[] {
    if (node.getKind() === SyntaxKind.MethodDeclaration) {
      return (node as MethodDeclaration).getParameters();
    }
    if (node.getKind() === SyntaxKind.FunctionDeclaration) {
      return (node as FunctionDeclaration).getParameters();
    }
    return [];
  }

  /**
   * Get the actual name of a declaration node (handles default exports).
   * For `export default class Foo`, returns "Foo".
   * For anonymous default exports, returns "default".
   */
  private getDeclarationName(node: Node): string | null {
    const kind = node.getKind();

    if (kind === SyntaxKind.ClassDeclaration) {
      const classDecl = node as import("ts-morph").ClassDeclaration;
      return classDecl.getName() ?? null;
    }
    if (kind === SyntaxKind.FunctionDeclaration) {
      const funcDecl = node as FunctionDeclaration;
      return funcDecl.getName() ?? null;
    }
    if (kind === SyntaxKind.InterfaceDeclaration) {
      const interfaceDecl = node as import("ts-morph").InterfaceDeclaration;
      return interfaceDecl.getName();
    }
    if (kind === SyntaxKind.TypeAliasDeclaration) {
      const typeDecl = node as import("ts-morph").TypeAliasDeclaration;
      return typeDecl.getName();
    }
    if (kind === SyntaxKind.EnumDeclaration) {
      const enumDecl = node as import("ts-morph").EnumDeclaration;
      return enumDecl.getName();
    }
    if (kind === SyntaxKind.VariableDeclaration) {
      const varDecl = node as import("ts-morph").VariableDeclaration;
      return varDecl.getName();
    }

    // For other nodes, try to get name from symbol
    const symbol = node.getSymbol();
    if (symbol) {
      const name = symbol.getName();
      // "default" means it's an anonymous default export
      return name === "default" ? null : name;
    }

    return null;
  }

  /**
   * Parse @file: syntax for file-scoped symbol lookups.
   * Format: @file:path/to/file.ts:SymbolName or @file:path/to/file.ts:SymbolName.member
   * Returns null if not in @file: format.
   */
  private parseFileReference(symbolName: string): { filePath: string; symbol: string } | null {
    if (!symbolName.startsWith("@file:")) {
      return null;
    }

    const rest = symbolName.slice(6); // Remove "@file:"
    // Find the last colon that separates file path from symbol name
    // Handle Windows paths and ensure we get the symbol part correctly
    const lastColonIndex = rest.lastIndexOf(":");

    if (lastColonIndex === -1 || lastColonIndex === rest.length - 1) {
      // No symbol specified, or colon is at the end
      return { filePath: rest.replace(/:$/, ""), symbol: "*" };
    }

    // Check if this colon is part of a Windows drive letter (e.g., C:)
    if (lastColonIndex === 1 && /^[a-zA-Z]$/.test(rest[0]!)) {
      // It's a Windows path with no symbol specified
      return { filePath: rest, symbol: "*" };
    }

    return {
      filePath: rest.slice(0, lastColonIndex),
      symbol: rest.slice(lastColonIndex + 1),
    };
  }

  /**
   * Find a symbol within a specific file (exported or not).
   * This bypasses export-based discovery for file-scoped lookups.
   */
  private findSymbolInFile(
    filePath: string,
    symbolName: string,
    project: Project,
    pkg: PackageInfo,
  ): { node: Node; symbol: Symbol } | null {
    const sourceFile = this.resolveSourceFileForLookup(filePath, project, pkg);
    if (!sourceFile) return null;
    const parts = symbolName.split(".");
    const rootName = parts[0]!;
    const root = this.findRootSymbolInSourceFile(sourceFile, rootName);

    return root ? this.navigateSymbolMembers(root.node, root.symbol, parts) : null;
  }

  private resolveSourceFileForLookup(
    filePath: string,
    project: Project,
    pkg: PackageInfo,
  ): SourceFile | null {
    const targetPath = isAbsolute(filePath) ? filePath : join(this.rootDirectory, filePath);
    const sourceFile = project.getSourceFile(targetPath);
    if (sourceFile) return sourceFile;

    return this.getSourceFiles(project, pkg).find((sf) => {
      const sfPath = sf.getFilePath();
      return sfPath.endsWith(filePath) || sfPath.includes(filePath);
    }) ?? null;
  }

  private findRootSymbolInSourceFile(
    sourceFile: SourceFile,
    rootName: string,
  ): { node: Node; symbol: Symbol } | null {
    return (
      this.findNamedNodeSymbol(sourceFile.getClasses(), rootName) ??
      this.findNamedNodeSymbol(sourceFile.getInterfaces(), rootName) ??
      this.findNamedNodeSymbol(sourceFile.getTypeAliases(), rootName) ??
      this.findNamedNodeSymbol(sourceFile.getFunctions(), rootName) ??
      this.findNamedNodeSymbol(sourceFile.getEnums(), rootName) ??
      this.findVariableDeclarationSymbol(sourceFile, rootName) ??
      this.findExportedRootSymbol(sourceFile, rootName)
    );
  }

  private findNamedNodeSymbol(nodes: Node[], rootName: string): { node: Node; symbol: Symbol } | null {
    for (const node of nodes) {
      const actualName = this.getDeclarationName(node);
      if (actualName !== rootName) continue;
      const symbol = node.getSymbol();
      if (symbol) return { node, symbol };
    }
    return null;
  }

  private findVariableDeclarationSymbol(
    sourceFile: SourceFile,
    rootName: string,
  ): { node: Node; symbol: Symbol } | null {
    for (const varStatement of sourceFile.getVariableStatements()) {
      for (const varDecl of varStatement.getDeclarations()) {
        if (varDecl.getName() !== rootName) continue;
        const symbol = varDecl.getSymbol();
        if (symbol) return { node: varDecl, symbol };
      }
    }
    return null;
  }

  private findExportedRootSymbol(
    sourceFile: SourceFile,
    rootName: string,
  ): { node: Node; symbol: Symbol } | null {
    for (const [exportName, declarations] of sourceFile.getExportedDeclarations()) {
      if (exportName === rootName || exportName === "default") {
        for (const decl of declarations) {
          const actualName = exportName === "default" ? this.getDeclarationName(decl) : exportName;
          if (actualName === rootName) {
            const symbol = decl.getSymbol();
            if (symbol) {
              return { node: decl, symbol };
            }
          }
        }
      }
    }

    return null;
  }

  private navigateSymbolMembers(
    startNode: Node,
    startSymbol: Symbol,
    parts: string[],
  ): { node: Node; symbol: Symbol } | null {
    let node = startNode;
    let symbol: Symbol | undefined = startSymbol;

    for (let i = 1; i < parts.length && symbol; i++) {
      const memberName = parts[i]!;
      const property = node.getType().getProperty(memberName);
      const propDecl = property?.getDeclarations()[0];
      if (!property || !propDecl) return null;
      node = propDecl;
      symbol = property;
    }

    return symbol ? { node, symbol } : null;
  }

  private findSymbol(
    symbolName: string,
    project: Project,
    pkg: PackageInfo,
  ): { node: Node; symbol: Symbol } | null {
    // Check for @file: syntax first - explicit file-scoped lookup
    const fileRef = this.parseFileReference(symbolName);
    if (fileRef) {
      if (fileRef.symbol === "*") {
        // Caller wants all symbols, not a specific one - return null to signal this
        return null;
      }
      return this.findSymbolInFile(fileRef.filePath, fileRef.symbol, project, pkg);
    }

    const parts = symbolName.split(".");
    const rootName = parts[0]!;
    const sourceFiles = this.getSourceFiles(project, pkg);

    // Collect ALL matches to detect ambiguity
    const matches: Array<{
      node: Node;
      symbol: Symbol;
      file: string;
      line: number;
      isDefault: boolean;
    }> = [];

    // First pass: collect direct named export matches
    for (const sourceFile of sourceFiles) {
      const exports = sourceFile.getExportedDeclarations();
      const declarations = exports.get(rootName);

      if (declarations && declarations.length > 0) {
        const node = declarations[0]!;
        const symbol = node.getSymbol();
        if (symbol) {
          matches.push({
            node,
            symbol,
            file: this.relativePath(sourceFile.getFilePath()),
            line: node.getStartLineNumber(),
            isDefault: false,
          });
        }
      }
    }

    // Second pass: check default exports whose actual name matches rootName
    for (const sourceFile of sourceFiles) {
      const exports = sourceFile.getExportedDeclarations();
      const defaultDeclarations = exports.get("default");

      if (defaultDeclarations && defaultDeclarations.length > 0) {
        for (const decl of defaultDeclarations) {
          const actualName = this.getDeclarationName(decl);
          if (actualName === rootName) {
            const symbol = decl.getSymbol();
            if (symbol) {
              matches.push({
                node: decl,
                symbol,
                file: this.relativePath(sourceFile.getFilePath()),
                line: decl.getStartLineNumber(),
                isDefault: true,
              });
            }
          }
        }
      }
    }

    // Handle match results
    if (matches.length === 0) {
      return null;
    }

    if (matches.length > 1) {
      const locations = matches
        .map((m) => `  - ${m.file}:${m.line}${m.isDefault ? " (default export)" : ""}`)
        .join("\n");
      throw new Error(
        `Ambiguous symbol "${rootName}". Found in multiple files:\n${locations}\nUse @file:path/to/file.ts:${rootName} to specify.`,
      );
    }

    // Single match - navigate to members if needed
    const match = matches[0]!;
    let node: Node = match.node;
    let symbol: Symbol | undefined = match.symbol;

    for (let i = 1; i < parts.length && symbol; i++) {
      const memberName = parts[i]!;
      const type = node.getType();
      const property = type.getProperty(memberName);

      if (property) {
        const propDecl = property.getDeclarations()[0];
        if (propDecl) {
          node = propDecl;
          symbol = property;
        } else {
          return null;
        }
      } else {
        const localVar = this.findLocalVariable(node, memberName);
        if (localVar) {
          node = localVar.node;
          symbol = localVar.symbol;
        } else {
          return null;
        }
      }
    }

    if (symbol) {
      return { node, symbol };
    }

    return null;
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

    const { node, symbol } = found;

    const result: RelatedInfo = {
      symbol: symbolName,
      referencedBy: [],
      references: [],
    };

    try {
      const languageService = project.getLanguageService();
      const referencedSymbols = languageService.findReferences(node);
      const seenRefs = new Set<string>();

      for (const refSymbol of referencedSymbols) {
        for (const ref of refSymbol.getReferences().slice(0, 100)) {
          const refNode = ref.getNode();
          const refSourceFile = refNode.getSourceFile();
          if (refSourceFile.isInNodeModules()) continue;

          const parent = refNode.getParent();
          if (!parent) continue;

          let context = "usage";
          const parentKind = parent.getKind();

          if (parentKind === SyntaxKind.HeritageClause) {
            context = "extends";
          } else if (parentKind === SyntaxKind.TypeReference) {
            context = "type reference";
          } else if (parentKind === SyntaxKind.PropertyAccessExpression) {
            context = "property access";
          } else if (parentKind === SyntaxKind.CallExpression) {
            context = "call";
          }

          let containingSymbol = "anonymous";
          let current: Node | undefined = parent;
          while (current) {
            const currentSymbol = current.getSymbol();
            if (currentSymbol && currentSymbol !== symbol) {
              containingSymbol = currentSymbol.getName();
              break;
            }
            current = current.getParent();
          }

          const key = `${containingSymbol}:${context}:${refNode.getStartLineNumber()}`;
          if (!seenRefs.has(key) && containingSymbol !== symbol.getName()) {
            seenRefs.add(key);
            result.referencedBy.push({
              symbol: containingSymbol,
              context,
              file: this.relativePath(refSourceFile.getFilePath()),
              line: refNode.getStartLineNumber(),
            });
          }
        }
      }
    } catch {
      // Ignore reference finding errors
    }

    const type = node.getType();
    const typeProperties = type.getProperties();

    for (const prop of typeProperties.slice(0, 50)) {
      const propDecl = prop.getDeclarations()[0];
      if (propDecl) {
        const propType = propDecl.getType();
        const propTypeText = propType.getText(propDecl);

        if (propTypeText !== "string" && propTypeText !== "number" && propTypeText !== "boolean") {
          const typeSymbol = propType.getSymbol() || propType.getAliasSymbol();
          if (typeSymbol) {
            result.references.push({
              symbol: typeSymbol.getName(),
              context: `property "${prop.getName()}"`,
            });
          }
        }
      }
    }

    const baseTypes = type.getBaseTypes();
    for (const baseType of baseTypes) {
      const baseSymbol = baseType.getSymbol();
      if (baseSymbol) {
        result.references.push({
          symbol: baseSymbol.getName(),
          context: "extends",
        });
      }
    }

    return result;
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

    // Create temp file inside package directory for proper module resolution
    const tempFileName = join(pkg.path, `__type_eval_${Date.now()}__.ts`);
    const tempDir = dirname(tempFileName);
    const fileContent = this.createEvalTypeContent(sourceFiles, tempDir, expression);

    try {
      const tempFile = project.createSourceFile(tempFileName, fileContent, { overwrite: true });
      const evaluated = this.evaluateTypeAlias(project, tempFile);
      project.removeSourceFile(tempFile);
      return evaluated;
    } catch (error) {
      this.removeTempSourceFile(project, tempFileName);
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private createEvalTypeContent(
    sourceFiles: SourceFile[],
    tempDir: string,
    expression: string,
  ): string {
    const exportSources = this.collectSnippetExportSources(sourceFiles);
    const fileExports = this.groupEvalImportsByFile(exportSources);
    const imports = this.createEvalTypeImports(fileExports, tempDir);
    return `${imports.join("\n")}\ntype __EvalResult__ = ${expression};`;
  }

  private groupEvalImportsByFile(
    exportSources: Map<string, SnippetExportSource[]>,
  ): Map<string, string[]> {
    const fileExports = new Map<string, string[]>();

    for (const [name, sources] of exportSources) {
      sources.forEach((source, index) => {
        const alias = sources.length === 1 ? name : `${name}_${index}`;
        const importName = source.isDefault
          ? `default as ${alias}`
          : alias === name
            ? name
            : `${name} as ${alias}`;
        const existing = fileExports.get(source.absolutePath) ?? [];
        existing.push(importName);
        fileExports.set(source.absolutePath, existing);
      });
    }

    return fileExports;
  }

  private createEvalTypeImports(
    fileExports: Map<string, string[]>,
    tempDir: string,
  ): string[] {
    const imports: string[] = [];
    for (const [absolutePath, exportList] of fileExports) {
      if (exportList.length === 0) continue;
      const modulePath = this.toSnippetModulePath(tempDir, absolutePath);
      imports.push(`import type { ${exportList.join(", ")} } from "${modulePath}";`);
    }
    return imports;
  }

  private evaluateTypeAlias(
    project: Project,
    tempFile: SourceFile,
  ): { result: string; expanded: string } | { error: string } {
    const typeAlias = tempFile.getTypeAlias("__EvalResult__");
    if (!typeAlias) {
      return { error: "Failed to parse type expression" };
    }

    const type = typeAlias.getType();
    const result = type.getText(typeAlias);
    const expanded = this.formatExpandedType(project, typeAlias, type);

    return { result, expanded };
  }

  private formatExpandedType(
    project: Project,
    typeAlias: import("ts-morph").TypeAliasDeclaration,
    type: import("ts-morph").Type,
  ): string {
    const expandFlags =
      TypeFormatFlags.NoTruncation |
      TypeFormatFlags.WriteArrayAsGenericType |
      TypeFormatFlags.UseStructuralFallback |
      TypeFormatFlags.WriteTypeArgumentsOfSignature |
      TypeFormatFlags.InTypeAlias;

    return project.getTypeChecker().compilerObject.typeToString(
      type.compilerType,
      typeAlias.compilerNode,
      expandFlags as unknown as number,
    );
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

    // Create temp file path inside package directory for proper module resolution
    const tempFileName = join(pkg.path, `__snippet_check_${Date.now()}__.ts`);
    const tempDir = dirname(tempFileName);
    const importPlan = this.createSnippetImportPlan(project, sourceFiles, tempDir, code);

    try {
      const tempFile = project.createSourceFile(tempFileName, importPlan.fileContent, { overwrite: true });

      // Get pre-emit diagnostics (type errors, syntax errors, etc.)
      const diagnostics = tempFile.getPreEmitDiagnostics();

      if (diagnostics.length === 0) {
        project.removeSourceFile(tempFile);
        return { valid: true };
      }

      const errors = diagnostics.map((diagnostic) =>
        this.toSnippetDiagnostic(diagnostic, importPlan.importLineCount),
      );

      project.removeSourceFile(tempFile);
      return { valid: false, errors };
    } catch (error) {
      this.removeTempSourceFile(project, tempFileName);
      return {
        valid: false,
        errors: [
          {
            message: error instanceof Error ? error.message : String(error),
            line: 1,
            column: 1,
            severity: "error",
          },
        ],
      };
    }
  }

  private createSnippetImportPlan(
    project: Project,
    sourceFiles: SourceFile[],
    tempDir: string,
    code: string,
  ): SnippetImportPlan {
    const exportSources = this.collectSnippetExportSources(sourceFiles);
    const fileExports = this.groupSnippetImportsByFile(exportSources, project);
    const imports = this.createSnippetImportStatements(fileExports, tempDir);
    const importBlock = imports.join("\n");

    return {
      fileContent: imports.length > 0 ? `${importBlock}\n${code}` : code,
      importLineCount: imports.length,
    };
  }

  private collectSnippetExportSources(
    sourceFiles: SourceFile[],
  ): Map<string, SnippetExportSource[]> {
    const exportSources = new Map<string, SnippetExportSource[]>();

    for (const sourceFile of sourceFiles) {
      const filePath = this.relativePath(sourceFile.getFilePath());
      const absolutePath = sourceFile.getFilePath();

      for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
        if (name === "default") {
          for (const decl of declarations) {
            const actualName = this.getDeclarationName(decl);
            if (actualName) {
              this.addSnippetExportSource(exportSources, actualName, {
                filePath,
                absolutePath,
                isDefault: true,
              });
            }
          }
        } else {
          this.addSnippetExportSource(exportSources, name, {
            filePath,
            absolutePath,
            isDefault: false,
          });
        }
      }
    }

    return exportSources;
  }

  private addSnippetExportSource(
    exportSources: Map<string, SnippetExportSource[]>,
    name: string,
    source: SnippetExportSource,
  ): void {
    const sources = exportSources.get(name) ?? [];
    sources.push(source);
    exportSources.set(name, sources);
  }

  private groupSnippetImportsByFile(
    exportSources: Map<string, SnippetExportSource[]>,
    project: Project,
  ): Map<string, { type: string[]; value: string[] }> {
    const fileExports = new Map<string, { type: string[]; value: string[] }>();

    for (const [name, sources] of exportSources) {
      sources.forEach((source, index) => {
        const alias = sources.length === 1 ? name : `${name}_${index}`;
        const importName = source.isDefault
          ? `default as ${alias}`
          : alias === name
            ? name
            : `${name} as ${alias}`;
        const existing = fileExports.get(source.absolutePath) ?? { type: [], value: [] };
        const target = this.isTypeOnlyExport(name, project, source.absolutePath)
          ? existing.type
          : existing.value;
        target.push(importName);
        fileExports.set(source.absolutePath, existing);
      });
    }

    return fileExports;
  }

  private createSnippetImportStatements(
    fileExports: Map<string, { type: string[]; value: string[] }>,
    tempDir: string,
  ): string[] {
    const imports: string[] = [];
    for (const [absolutePath, exportLists] of fileExports) {
      for (const { imports: exportList, prefix } of [
        { imports: exportLists.type, prefix: "import type" },
        { imports: exportLists.value, prefix: "import" },
      ]) {
        if (exportList.length === 0) continue;
        const modulePath = this.toSnippetModulePath(tempDir, absolutePath);
        imports.push(`${prefix} { ${exportList.join(", ")} } from "${modulePath}";`);
      }
    }
    return imports;
  }

  private toSnippetModulePath(tempDir: string, absolutePath: string): string {
    let modulePath = relative(tempDir, absolutePath);
    if (!modulePath.startsWith(".") && !modulePath.startsWith("/")) {
      modulePath = "./" + modulePath;
    }
    return modulePath.replace(/\\/g, "/").replace(/\.(ts|tsx)$/, "");
  }

  private toSnippetDiagnostic(
    diagnostic: import("ts-morph").Diagnostic,
    importLineCount: number,
  ): SnippetDiagnostic {
    const start = diagnostic.getStart();
    const sourceFile = diagnostic.getSourceFile();
    let line = 1;
    let column = 1;

    if (start !== undefined && sourceFile) {
      const pos = sourceFile.getLineAndColumnAtPos(start);
      line = Math.max(1, pos.line - importLineCount);
      column = pos.column;
    }

    const messageText = diagnostic.getMessageText();
    const message = typeof messageText === "string" ? messageText : messageText.getMessageText();
    const severity: "error" | "warning" = diagnostic.getCategory() === 1 ? "error" : "warning";

    return { message, line, column, severity };
  }

  private removeTempSourceFile(project: Project, tempFileName: string): void {
    try {
      const tempFile = project.getSourceFile(tempFileName);
      if (tempFile) {
        project.removeSourceFile(tempFile);
      }
    } catch {
      // Ignore cleanup errors
    }
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
    const symbolFilter = options.symbol ? new RegExp(options.symbol, "i") : null;
    const exportMetadata = this.getFileExportMetadata(sourceFile);
    const declarations = this.collectFileDeclarations(sourceFile, exportMetadata, {
      symbolFilter,
      includePrivate: options.includePrivate ?? false,
    });

    this.sortFileDeclarations(declarations);

    return {
      file: this.relativePath(sourceFile.getFilePath()),
      package: pkg.name,
      declarations,
      total: declarations.length,
    };
  }

  private getFileExportMetadata(sourceFile: SourceFile): FileExportMetadata {
    const exportedNames = new Set<string>();
    const defaultExportNames = new Set<string>();
    const exportAliases = new Map<string, string>();

    for (const [exportName, decls] of sourceFile.getExportedDeclarations()) {
      if (exportName === "default") {
        for (const decl of decls) {
          const actualName = this.getDeclarationName(decl);
          if (actualName) {
            defaultExportNames.add(actualName);
            exportedNames.add(actualName);
          }
        }
      } else {
        for (const decl of decls) {
          const actualName = this.getDeclarationName(decl);
          if (actualName && actualName !== exportName) {
            exportAliases.set(actualName, exportName);
            exportedNames.add(actualName);
          } else {
            exportedNames.add(exportName);
          }
        }
      }
    }

    return { exportedNames, defaultExportNames, exportAliases };
  }

  private collectFileDeclarations(
    sourceFile: SourceFile,
    exportMetadata: FileExportMetadata,
    options: { symbolFilter: RegExp | null; includePrivate: boolean },
  ): FileDeclarationInfo[] {
    const declarations: FileDeclarationInfo[] = [];
    const addDeclaration = (node: Node, name: string) => {
      const declaration = this.createFileDeclarationInfo(node, name, exportMetadata, options);
      if (declaration) declarations.push(declaration);
    };

    for (const classDecl of sourceFile.getClasses()) {
      const name = classDecl.getName();
      if (name) {
        addDeclaration(classDecl, name);
      }
    }

    for (const interfaceDecl of sourceFile.getInterfaces()) {
      addDeclaration(interfaceDecl, interfaceDecl.getName());
    }

    for (const typeAlias of sourceFile.getTypeAliases()) {
      addDeclaration(typeAlias, typeAlias.getName());
    }

    for (const funcDecl of sourceFile.getFunctions()) {
      const name = funcDecl.getName();
      if (name) {
        addDeclaration(funcDecl, name);
      }
    }

    for (const enumDecl of sourceFile.getEnums()) {
      addDeclaration(enumDecl, enumDecl.getName());
    }

    for (const varStatement of sourceFile.getVariableStatements()) {
      for (const varDecl of varStatement.getDeclarations()) {
        addDeclaration(varDecl, varDecl.getName());
      }
    }

    return declarations;
  }

  private createFileDeclarationInfo(
    node: Node,
    name: string,
    exportMetadata: FileExportMetadata,
    options: { symbolFilter: RegExp | null; includePrivate: boolean },
  ): FileDeclarationInfo | null {
    if (options.symbolFilter && !options.symbolFilter.test(name)) return null;

    const isExported = exportMetadata.exportedNames.has(name);
    if (!isExported && !options.includePrivate) return null;

    const kind = this.kindToString(node.getKind());
    const exportedAs = exportMetadata.exportAliases.get(name);
    const info: FileDeclarationInfo = {
      name,
      kind,
      line: node.getStartLineNumber(),
      exported: isExported,
      isDefaultExport: exportMetadata.defaultExportNames.has(name),
      ...(exportedAs === undefined ? {} : { exportedAs }),
    };

    const type = node.getType();
    if (kind !== "class" && kind !== "interface" && kind !== "enum") {
      info.type = type.getText(node);
    }

    const signature = this.getFileDeclarationSignature(node, name, kind, type);
    if (signature !== undefined) {
      info.signature = signature;
    }
    return info;
  }

  private getFileDeclarationSignature(
    node: Node,
    name: string,
    kind: string,
    type: import("ts-morph").Type,
  ): string | undefined {
    if (kind === "function") {
      const callSigs = type.getCallSignatures();
      if (callSigs.length === 0) return undefined;
      return callSigs
        .map((sig) => {
          const params = sig
            .getParameters()
            .map((p) => `${p.getName()}: ${p.getTypeAtLocation(node).getText(node)}`)
            .join(", ");
          const ret = sig.getReturnType().getText(node);
          return `(${params}) => ${ret}`;
        })
        .join(" | ");
    }

    if (kind !== "class") return undefined;

    const props = type.getProperties().slice(0, 20);
    const methods = props.filter((p) => {
      const decl = p.getDeclarations()[0];
      return decl && decl.getKind() === SyntaxKind.MethodDeclaration;
    });
    const methodList = methods.map((method) => method.getName() + "()").join(", ");
    const suffix = methods.length < props.length ? ", ..." : "";
    return `class ${name} { ${methodList}${suffix} }`;
  }

  private sortFileDeclarations(declarations: FileDeclarationInfo[]): void {
    declarations.sort((a, b) => {
      if (a.exported && !b.exported) return -1;
      if (!a.exported && b.exported) return 1;
      if (a.isDefaultExport && !b.isDefaultExport) return -1;
      if (!a.isDefaultExport && b.isDefaultExport) return 1;
      return a.name.localeCompare(b.name);
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
      return {
        compatible: false,
        from: fromSymbol,
        to: toSymbol,
        reason: `Symbol "${fromSymbol}" not found`,
      };
    }

    if (!toFound) {
      return {
        compatible: false,
        from: fromSymbol,
        to: toSymbol,
        reason: `Symbol "${toSymbol}" not found`,
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

    // Build detailed incompatibility reason by comparing properties
    const reasons: string[] = [];

    // Check for missing properties
    const toProperties = toType.getProperties();
    const fromProperties = fromType.getProperties();
    const fromPropNames = new Set(fromProperties.map((p) => p.getName()));

    for (const toProp of toProperties) {
      const propName = toProp.getName();
      if (!toProp.isOptional() && !fromPropNames.has(propName)) {
        const propType = toProp.getTypeAtLocation(toFound.node).getText(toFound.node);
        reasons.push(
          `Property '${propName}' is missing in type '${fromTypeText}' but required in type '${toTypeText}' (expected: ${propType})`,
        );
      }
    }

    // Check for type mismatches on existing properties
    for (const fromProp of fromProperties) {
      const propName = fromProp.getName();
      const toProp = toType.getProperty(propName);

      if (toProp) {
        const fromPropType = fromProp.getTypeAtLocation(fromFound.node);
        const toPropType = toProp.getTypeAtLocation(toFound.node);

        if (!fromPropType.isAssignableTo(toPropType)) {
          const fromPropText = fromPropType.getText(fromFound.node);
          const toPropText = toPropType.getText(toFound.node);
          reasons.push(
            `Property '${propName}' has incompatible types: '${fromPropText}' is not assignable to '${toPropText}'`,
          );
        }
      }
    }

    // Check for callable/construct signature mismatches
    const fromCallSigs = fromType.getCallSignatures();
    const toCallSigs = toType.getCallSignatures();

    if (toCallSigs.length > 0 && fromCallSigs.length === 0) {
      reasons.push(
        `Type '${fromTypeText}' is not callable but '${toTypeText}' requires call signatures`,
      );
    }

    // If no specific reasons found, provide generic message
    if (reasons.length === 0) {
      reasons.push(`Type '${fromTypeText}' is not assignable to type '${toTypeText}'`);
    }

    return {
      compatible: false,
      from: fromTypeText,
      to: toTypeText,
      reason: reasons.join("; "),
    };
  }

  async generateGraph(
    symbolName: string,
    options: { depth?: number; format?: "mermaid" | "dot"; packageName?: string } = {},
  ): Promise<GraphResult | null> {
    const { depth = 2, format = "mermaid", packageName } = options;
    const maxDepth = Math.min(depth, 4); // Cap at 4 to prevent runaway traversal

    const pkg = await this.resolvePackage(packageName);
    const project = this.getProject(pkg);

    // Find the root symbol
    const found = this.findSymbol(symbolName, project, pkg);
    if (!found) {
      return null;
    }

    const edges: GraphEdge[] = [];
    const visited = new Set<string>();
    const nodes = new Set<string>();

    // Recursive traversal to build the graph
    const traverse = async (symbol: string, currentDepth: number): Promise<void> => {
      if (currentDepth > maxDepth || visited.has(symbol)) return;
      visited.add(symbol);
      nodes.add(symbol);

      // Get related types for this symbol
      const related = await this.findRelated(symbol, packageName);
      if (!related) return;

      // Process outgoing references (types this symbol uses)
      for (const ref of related.references) {
        const targetSymbol = ref.symbol;

        // Skip primitive types and built-in types
        if (this.isPrimitiveOrBuiltin(targetSymbol)) continue;

        // Skip symbols that aren't actually defined in this project
        // (e.g., built-in string methods like toString, charAt, etc.)
        const targetFound = this.findSymbol(targetSymbol, project, pkg);
        if (!targetFound) continue;

        nodes.add(targetSymbol);
        edges.push({
          from: symbol,
          to: targetSymbol,
          label: ref.context,
        });

        // Recurse if we haven't hit depth limit
        if (currentDepth < maxDepth) {
          await traverse(targetSymbol, currentDepth + 1);
        }
      }
    };

    await traverse(symbolName, 0);

    // Generate the graph in requested format
    const graph = format === "mermaid" ? this.toMermaid(edges) : this.toDot(edges);

    return {
      root: symbolName,
      format,
      depth: maxDepth,
      nodes: Array.from(nodes),
      edges,
      graph,
    };
  }

  private isPrimitiveOrBuiltin(typeName: string): boolean {
    const primitives = new Set([
      "string",
      "number",
      "boolean",
      "undefined",
      "null",
      "void",
      "any",
      "unknown",
      "never",
      "object",
      "symbol",
      "bigint",
      "Date",
      "Array",
      "Object",
      "String",
      "Number",
      "Boolean",
      "Promise",
      "Map",
      "Set",
      "WeakMap",
      "WeakSet",
      "RegExp",
      "Error",
      "Function",
    ]);
    return primitives.has(typeName);
  }

  private toMermaid(edges: GraphEdge[]): string {
    const lines = ["graph TD"];
    const seen = new Set<string>();

    for (const edge of edges) {
      // Sanitize node names for Mermaid (remove special characters)
      const fromNode = this.sanitizeMermaidId(edge.from);
      const toNode = this.sanitizeMermaidId(edge.to);
      const key = `${fromNode}-->${toNode}`;

      if (seen.has(key)) continue;
      seen.add(key);

      if (edge.label) {
        // Sanitize label for Mermaid
        const safeLabel = edge.label.replace(/"/g, "'").replace(/[|[\]]/g, "");
        lines.push(`  ${fromNode} -->|${safeLabel}| ${toNode}`);
      } else {
        lines.push(`  ${fromNode} --> ${toNode}`);
      }
    }

    return lines.join("\n");
  }

  private toDot(edges: GraphEdge[]): string {
    const lines = ["digraph G {", "  rankdir=TB;", "  node [shape=box];"];
    const seen = new Set<string>();

    for (const edge of edges) {
      const key = `${edge.from}->${edge.to}`;

      if (seen.has(key)) continue;
      seen.add(key);

      // Escape quotes in DOT format
      const fromNode = `"${edge.from.replace(/"/g, '\\"')}"`;
      const toNode = `"${edge.to.replace(/"/g, '\\"')}"`;

      if (edge.label) {
        const safeLabel = edge.label.replace(/"/g, '\\"');
        lines.push(`  ${fromNode} -> ${toNode} [label="${safeLabel}"];`);
      } else {
        lines.push(`  ${fromNode} -> ${toNode};`);
      }
    }

    lines.push("}");
    return lines.join("\n");
  }

  private sanitizeMermaidId(name: string): string {
    // Mermaid node IDs should be alphanumeric with underscores
    // Replace problematic characters
    return name.replace(/[^a-zA-Z0-9_]/g, "_");
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

    const { node, symbol } = found;
    const languageService = project.getLanguageService();
    const symbolName = symbol.getName();

    // Get all rename locations using ts-morph's language service
    const renameLocations = languageService.findRenameLocations(node);

    const locations: RefactorLocation[] = [];
    const predictedErrors: RefactorError[] = [];
    const safetyNotes: string[] = [];
    const affectedFiles = new Set<string>(); // Track affected files for optimized scanning

    // Create regex for replacing symbol name with new name
    const replaceRegex = new RegExp(`\\b${this.escapeRegex(symbolName)}\\b`, "g");

    for (const loc of renameLocations) {
      const sourceFile = loc.getSourceFile();
      const filePath = this.relativePath(sourceFile.getFilePath());
      const absolutePath = sourceFile.getFilePath();
      const textSpan = loc.getTextSpan();
      const start = textSpan.getStart();
      const lineAndCol = sourceFile.getLineAndColumnAtPos(start);
      const line = lineAndCol.line;
      const column = lineAndCol.column;

      // Track affected files for optimized string literal/comment scanning
      affectedFiles.add(absolutePath);

      // Check for safety issues - deduplicate by file+line
      const errorKey = `${filePath}:${line}`;
      const existingError = predictedErrors.find((e) => `${e.file}:${e.line}` === errorKey);

      if (!existingError) {
        if (sourceFile.isDeclarationFile()) {
          predictedErrors.push({
            file: filePath,
            line,
            message: "Cannot rename: declaration file (.d.ts)",
          });
        } else if (!absolutePath.startsWith(pkg.path)) {
          predictedErrors.push({
            file: filePath,
            line,
            message: "Cannot rename: file is outside package boundary",
          });
        }
      }

      // Get the line text and generate before/after preview
      const fullText = sourceFile.getFullText();
      const lines = fullText.split("\n");
      const lineText = lines[line - 1] || "";
      const before = lineText.trim();
      const after = before.replace(replaceRegex, options.to);

      locations.push({ file: filePath, line, column, before, after });
    }

    // OPTIMIZATION: Only scan files that have rename locations for string literals/comments
    // This dramatically improves performance on large codebases
    const stringLiteralLocations = this.findStringLiteralReferencesInFiles(
      symbolName,
      project,
      affectedFiles,
    );

    const commentLocations = this.findCommentReferencesInFiles(symbolName, project, affectedFiles);

    // Build safety notes
    if (stringLiteralLocations.length > 0) {
      safetyNotes.push(
        `${stringLiteralLocations.length} string literal(s) contain "${symbolName}" and won't be renamed automatically`,
      );
    }

    if (commentLocations.length > 0) {
      safetyNotes.push(
        `${commentLocations.length} comment(s) contain "${symbolName}" and may need manual review`,
      );
    }

    // Calculate confidence score
    const confidence = this.calculateConfidence(
      predictedErrors.length,
      stringLiteralLocations.length,
      commentLocations.length,
    );

    const safe = predictedErrors.length === 0 && safetyNotes.length === 0;

    return {
      action: "rename",
      from: symbolName,
      to: options.to,
      locations: locations.slice(0, 100), // Limit output to prevent huge responses
      totalLocations: locations.length,
      predictedErrors,
      confidence,
      safe,
      safetyNotes,
      stringLiteralLocations: stringLiteralLocations.slice(0, 20), // Limit to first 20
      commentLocations: commentLocations.slice(0, 20), // Limit to first 20
    };
  }

  /**
   * Calculate confidence score based on potential issues.
   */
  private calculateConfidence(
    errorCount: number,
    stringLiteralCount: number,
    commentCount: number,
  ): "high" | "medium" | "low" {
    // Low confidence: any breaking errors
    if (errorCount > 0) {
      return "low";
    }

    // Medium confidence: string literals found (could break runtime behavior)
    if (stringLiteralCount > 0) {
      return "medium";
    }

    // High confidence: only comments or no issues (comments are cosmetic)
    // Comments don't affect runtime, just documentation
    return commentCount > 0 ? "high" : "high";
  }

  /**
   * Find string literals containing a symbol name in specific files only.
   * Optimized version that only scans affected files.
   */
  private findStringLiteralReferencesInFiles(
    symbolName: string,
    project: Project,
    filePaths: Set<string>,
  ): StringLiteralRef[] {
    const results: StringLiteralRef[] = [];
    const regex = new RegExp(`\\b${this.escapeRegex(symbolName)}\\b`);

    for (const absolutePath of filePaths) {
      const sf = project.getSourceFile(absolutePath);
      if (!sf) continue;

      const stringLiterals = sf.getDescendantsOfKind(SyntaxKind.StringLiteral);
      for (const lit of stringLiterals) {
        const text = lit.getLiteralText();
        if (regex.test(text)) {
          results.push({
            file: this.relativePath(sf.getFilePath()),
            line: lit.getStartLineNumber(),
            content: text.length > 50 ? text.slice(0, 50) + "..." : text,
          });
        }
      }
    }

    return results;
  }

  /**
   * Find comments containing a symbol name in specific files only.
   * Optimized version that only scans affected files.
   */
  private findCommentReferencesInFiles(
    symbolName: string,
    project: Project,
    filePaths: Set<string>,
  ): StringLiteralRef[] {
    const results: StringLiteralRef[] = [];
    const regex = new RegExp(`\\b${this.escapeRegex(symbolName)}\\b`);

    for (const absolutePath of filePaths) {
      const sf = project.getSourceFile(absolutePath);
      if (!sf) continue;

      const fullText = sf.getFullText();
      const lines = fullText.split("\n");
      const filePath = this.relativePath(sf.getFilePath());

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;

        // Check for single-line comments
        const singleLineMatch = line.match(/\/\/(.*)$/);
        if (singleLineMatch && regex.test(singleLineMatch[1]!)) {
          const content = singleLineMatch[1]!.trim();
          results.push({
            file: filePath,
            line: i + 1,
            content: content.length > 50 ? content.slice(0, 50) + "..." : content,
          });
          continue;
        }

        // Check for JSDoc/multi-line comment content
        if ((line.includes("/*") || line.includes("*")) && regex.test(line)) {
          const trimmed = line.trim();
          if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) {
            results.push({
              file: filePath,
              line: i + 1,
              content: trimmed.length > 50 ? trimmed.slice(0, 50) + "..." : trimmed,
            });
          }
        }
      }
    }

    return results;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const diagnostics = project.getPreEmitDiagnostics();

    const result: Array<{
      file: string;
      line: number;
      column: number;
      message: string;
      code: number;
    }> = [];

    for (const diag of diagnostics) {
      const sourceFile = diag.getSourceFile();
      if (!sourceFile) continue;

      const filePath = sourceFile.getFilePath();
      // Only include diagnostics from files within this package
      if (!filePath.startsWith(pkg.path)) continue;

      const start = diag.getStart();
      const lineAndCol = sourceFile.getLineAndColumnAtPos(start ?? 0);

      result.push({
        file: this.relativePath(filePath),
        line: lineAndCol.line,
        column: lineAndCol.column,
        message: diag.getMessageText().toString(),
        code: diag.getCode(),
      });
    }

    return result;
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
    const result = new Map<
      string,
      Array<{ file: string; line: number; column: number; message: string; code: number }>
    >();

    // Iterate over cached projects
    for (const tsconfigPath of this.projectCache.keys()) {
      const cached = this.projectCache.get(tsconfigPath);
      if (!cached) continue;

      const { project, packageInfo: pkg } = cached;
      const diagnostics = project.getPreEmitDiagnostics();
      const pkgDiagnostics: Array<{
        file: string;
        line: number;
        column: number;
        message: string;
        code: number;
      }> = [];

      for (const diag of diagnostics) {
        const sourceFile = diag.getSourceFile();
        if (!sourceFile) continue;

        const filePath = sourceFile.getFilePath();
        if (!filePath.startsWith(pkg.path)) continue;

        const start = diag.getStart();
        const lineAndCol = sourceFile.getLineAndColumnAtPos(start ?? 0);

        pkgDiagnostics.push({
          file: this.relativePath(filePath),
          line: lineAndCol.line,
          column: lineAndCol.column,
          message: diag.getMessageText().toString(),
          code: diag.getCode(),
        });
      }

      if (pkgDiagnostics.length > 0) {
        result.set(pkg.name, pkgDiagnostics);
      }
    }

    return result;
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

    let errorCode = options.code;
    let errorMessage = options.message ?? "";

    // If file+line provided, find the diagnostic at that location
    if (options.file && options.line && !errorMessage) {
      const diagnostics = await this.getPackageDiagnostics(options.packageName);
      const matchingDiag = diagnostics.find(
        (d) => d.file.endsWith(options.file!) && d.line === options.line,
      );
      if (matchingDiag) {
        errorCode = matchingDiag.code;
        errorMessage = matchingDiag.message;
      }
    }

    if (!errorMessage) {
      return null;
    }

    const extracted = this.extractTypesFromError(errorMessage);
    const result: ErrorExplanationResult = {
      error: { code: errorCode ?? 0, message: errorMessage },
      explanation: "",
      issues: [],
      suggestions: [],
    };

    switch (errorCode) {
      case 2322:
      case 2345:
        await this.explainAssignabilityError(result, extracted, project, pkg, options.packageName);
        break;
      case 2339:
        await this.explainMissingMemberError(result, extracted, project, pkg);
        break;
      case 2741:
        await this.explainMissingRequiredPropertyError(result, extracted, project, pkg);
        break;
      case 2551:
        await this.explainSuggestedPropertyError(result, extracted, project, pkg);
        break;
      default:
        await this.explainGenericError(result, extracted, errorMessage, project, pkg);
        break;
    }

    return result;
  }

  private async explainAssignabilityError(
    result: ErrorExplanationResult,
    extracted: { types: string[]; properties: string[] },
    project: Project,
    pkg: PackageInfo,
    packageName?: string,
  ): Promise<void> {
    if (extracted.types.length < 2) return;

    const [fromType, toType] = extracted.types;
    await this.expandResultTypes(result, [fromType!, toType!], project, pkg);

    const compat = await this.checkCompatibility(fromType!, toType!, packageName);
    if (!compat.compatible && compat.reason) {
      result.issues.push(...this.parseCompatibilityIssues(compat.reason));
    }

    result.explanation = `You're trying to use a value of type '${fromType}' where a value of type '${toType}' is expected. These types are not compatible.`;
    this.addAssignabilitySuggestions(result, toType!);
  }

  private async explainMissingMemberError(
    result: ErrorExplanationResult,
    extracted: { types: string[]; properties: string[] },
    project: Project,
    pkg: PackageInfo,
  ): Promise<void> {
    if (extracted.properties.length === 0 || extracted.types.length === 0) return;

    const [targetType] = extracted.types;
    const [missingProp] = extracted.properties;
    await this.expandTargetType(result, targetType!, project, pkg);

    result.issues.push({
      kind: "missing_property",
      ...(missingProp === undefined ? {} : { property: missingProp }),
      message: `Property '${missingProp}' does not exist on type '${targetType}'`,
    });
    result.explanation = `You're trying to access property '${missingProp}' on type '${targetType}', but this property doesn't exist.`;
    result.suggestions.push(`Add property '${missingProp}' to the ${targetType} type`);
    result.suggestions.push("Check for typos in the property name");
    result.suggestions.push("Use optional chaining (?.) if the property might not exist");
  }

  private async explainMissingRequiredPropertyError(
    result: ErrorExplanationResult,
    extracted: { types: string[]; properties: string[] },
    project: Project,
    pkg: PackageInfo,
  ): Promise<void> {
    if (extracted.properties.length === 0 || extracted.types.length < 2) return;

    const [fromType, toType] = extracted.types;
    const [missingProp] = extracted.properties;
    await this.expandResultTypes(result, [fromType!, toType!], project, pkg);

    result.issues.push({
      kind: "missing_property",
      ...(missingProp === undefined ? {} : { property: missingProp }),
      message: `Property '${missingProp}' is required but missing`,
    });
    result.explanation = `Type '${fromType}' is missing required property '${missingProp}' that '${toType}' expects.`;
    result.suggestions.push(`Add property '${missingProp}' to your object`);
    result.suggestions.push(`Make '${missingProp}' optional in ${toType} using '${missingProp}?:'`);
  }

  private async explainSuggestedPropertyError(
    result: ErrorExplanationResult,
    extracted: { types: string[]; properties: string[] },
    project: Project,
    pkg: PackageInfo,
  ): Promise<void> {
    if (extracted.properties.length < 2 || extracted.types.length === 0) return;

    const [targetType] = extracted.types;
    const [wrongProp, suggestedProp] = extracted.properties;
    await this.expandTargetType(result, targetType!, project, pkg);

    result.issues.push({
      kind: "missing_property",
      ...(wrongProp === undefined ? {} : { property: wrongProp }),
      message: `Property '${wrongProp}' doesn't exist, did you mean '${suggestedProp}'?`,
    });
    result.explanation = `You typed '${wrongProp}' but this property doesn't exist on '${targetType}'. TypeScript suggests '${suggestedProp}' instead.`;
    result.suggestions.push(`Replace '${wrongProp}' with '${suggestedProp}'`);
  }

  private async explainGenericError(
    result: ErrorExplanationResult,
    extracted: { types: string[]; properties: string[] },
    errorMessage: string,
    project: Project,
    pkg: PackageInfo,
  ): Promise<void> {
    if (extracted.types.length > 0) {
      await this.expandResultTypes(result, extracted.types.slice(0, 2), project, pkg);
    }
    result.explanation = errorMessage;
    result.issues.push({ kind: "other", message: errorMessage });
    result.suggestions.push("Review the types involved using type_expand");
    result.suggestions.push("Check type compatibility using type_compatible");
  }

  private async expandResultTypes(
    result: ErrorExplanationResult,
    typeNames: string[],
    project: Project,
    pkg: PackageInfo,
  ): Promise<void> {
    for (let i = 0; i < Math.min(typeNames.length, 2); i++) {
      const typeName = typeNames[i]!;
      const expanded = await this.safeExpandType(typeName, project, pkg);
      if (!expanded) continue;
      result.types ??= {};
      if (i === 0) {
        result.types.from = { name: typeName, expanded };
      } else {
        result.types.to = { name: typeName, expanded };
      }
    }
  }

  private async expandTargetType(
    result: ErrorExplanationResult,
    typeName: string,
    project: Project,
    pkg: PackageInfo,
  ): Promise<void> {
    const expanded = await this.safeExpandType(typeName, project, pkg);
    if (expanded) {
      result.types ??= {};
      result.types.target = { name: typeName, expanded };
    }
  }

  private parseCompatibilityIssues(reason: string): ErrorExplanationIssue[] {
    return reason.split("; ").map((part) => {
      if (part.includes("missing")) {
        const propMatch = part.match(/Property '(\w+)'/);
        const typeMatch = part.match(/expected: ([^)]+)/);
        return {
          kind: "missing_property",
          ...(propMatch?.[1] === undefined ? {} : { property: propMatch[1] }),
          ...(typeMatch?.[1] === undefined ? {} : { expectedType: typeMatch[1] }),
          message: part,
        };
      }

      if (part.includes("incompatible types")) {
        const propMatch = part.match(/Property '(\w+)'/);
        const typesMatch = part.match(/'([^']+)' is not assignable to '([^']+)'/);
        return {
          kind: "type_mismatch",
          ...(propMatch?.[1] === undefined ? {} : { property: propMatch[1] }),
          ...(typesMatch?.[1] === undefined ? {} : { actualType: typesMatch[1] }),
          ...(typesMatch?.[2] === undefined ? {} : { expectedType: typesMatch[2] }),
          message: part,
        };
      }

      return { kind: "other", message: part };
    });
  }

  private addAssignabilitySuggestions(result: ErrorExplanationResult, toType: string): void {
    const missingProps = result.issues.filter((issue) => issue.kind === "missing_property");
    if (missingProps.length > 0) {
      const propNames = missingProps.map((issue) => issue.property).filter(Boolean).join(", ");
      result.suggestions.push(`Add missing properties: ${propNames}`);
      result.suggestions.push(`Use Partial<${toType}> if properties should be optional`);
      result.suggestions.push(`Use Omit<${toType}, '${propNames}'> to create a type without these properties`);
    }

    for (const mismatch of result.issues.filter((issue) => issue.kind === "type_mismatch")) {
      result.suggestions.push(
        `Fix property '${mismatch.property}': change from '${mismatch.actualType}' to '${mismatch.expectedType}'`,
      );
    }
  }

  /**
   * Extract type and property names from a TypeScript error message.
   */
  private extractTypesFromError(message: string): { types: string[]; properties: string[] } {
    const types: string[] = [];
    const properties: string[] = [];

    // Patterns for extracting types
    const typePatterns = [
      /Type '([^']+)' is not assignable to type '([^']+)'/,
      /Argument of type '([^']+)' is not assignable to parameter of type '([^']+)'/,
      /Type ([\w$]+(?:\.[\w$]+)*) is not assignable to type ([\w$]+(?:\.[\w$]+)*)/,
      /Argument of type ([\w$]+(?:\.[\w$]+)*) is not assignable to parameter of type ([\w$]+(?:\.[\w$]+)*)/,
      /Property '[^']+' does not exist on type '([^']+)'/,
      /Property '[^']+' is missing in type '([^']+)' but required in type '([^']+)'/,
      /Property ([\w$]+) is missing in type ([\w$]+(?:\.[\w$]+)*) but required in type ([\w$]+(?:\.[\w$]+)*)/,
      /Cannot find name '([^']+)'/,
      /Type '([^']+)' has no properties in common with type '([^']+)'/,
      /Type ([\w$]+(?:\.[\w$]+)*) has no properties in common with type ([\w$]+(?:\.[\w$]+)*)/,
    ];

    // Patterns for extracting properties
    const propPatterns = [
      /Property '([^']+)' does not exist/,
      /Property '([^']+)' is missing/,
      /Property ([\w$]+) does not exist/,
      /Property ([\w$]+) is missing/,
      /Did you mean '([^']+)'\?/,
    ];

    for (const pattern of typePatterns) {
      const match = message.match(pattern);
      if (match) {
        for (let i = 1; i < match.length; i++) {
          const typeName = match[i];
          if (typeName && !this.isInlineObjectType(typeName)) {
            types.push(typeName);
          }
        }
        break;
      }
    }

    for (const pattern of propPatterns) {
      const match = message.match(pattern);
      if (match && match[1]) {
        properties.push(match[1]);
      }
    }

    return { types, properties };
  }

  /**
   * Check if a type string is an inline object type (not a named type).
   */
  private isInlineObjectType(typeName: string): boolean {
    return typeName.startsWith("{") && typeName.endsWith("}");
  }

  private isTypeOnlyExport(name: string, project: Project, absolutePath: string): boolean {
    const sourceFile = project.getSourceFile(absolutePath);
    const declarations = sourceFile?.getExportedDeclarations().get(name) ?? [];
    return declarations.length > 0 && declarations.every((declaration) =>
      Node.isInterfaceDeclaration(declaration) || Node.isTypeAliasDeclaration(declaration)
    );
  }

  /**
   * Safely expand a type, returning null if it fails.
   * For interface types, shows the structural expansion with properties.
   */
  private async safeExpandType(
    typeName: string,
    project: Project,
    pkg: PackageInfo,
  ): Promise<string | null> {
    try {
      const found = this.findSymbol(typeName, project, pkg);
      if (!found) return null;

      const { node } = found;
      const type = node.getType();
      const checker = project.getTypeChecker();

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

      // For interfaces/types that don't fully expand, build a structural representation
      if (expanded === typeName || !expanded.startsWith("{")) {
        const properties = type.getProperties();
        if (properties.length > 0 && properties.length <= 20) {
          const propStrings = properties.map((prop) => {
            const propDecl = prop.getDeclarations()[0];
            const propType = propDecl ? propDecl.getType() : prop.getTypeAtLocation(node);
            const optional = prop.isOptional() ? "?" : "";
            return `${prop.getName()}${optional}: ${propType.getText(propDecl ?? node)}`;
          });
          return `{ ${propStrings.join("; ")} }`;
        }
      }

      return expanded;
    } catch {
      return null;
    }
  }

  /**
   * Explain a complex type expression step by step.
   * Shows how utility types and generics are resolved.
   */
  async explainType(expression: string, packageName?: string): Promise<TypeExplanationResult> {
    const _pkg = await this.resolvePackage(packageName);
    this.getProject(_pkg); // Ensure project is loaded for evalType
    const steps: TypeExplanationStep[] = [];

    // First, get the final result
    const evalResult = await this.evalType(expression, packageName);
    const finalResult = "error" in evalResult ? `Error: ${evalResult.error}` : evalResult.expanded;

    // Parse the expression to identify components
    const components = this.parseTypeExpression(expression);

    if (components.length === 0) {
      // Simple type, just show the expansion
      steps.push({
        step: 1,
        description: `Expand ${expression}`,
        expression: expression,
        result: finalResult,
      });
    } else {
      // Complex type with nested components
      let stepNum = 1;

      for (const component of components) {
        if (component.type === "keyof") {
          // Evaluate keyof
          const keyofResult = await this.evalType(`keyof ${component.target}`, packageName);
          const result =
            "error" in keyofResult ? `Error: ${keyofResult.error}` : keyofResult.expanded;
          steps.push({
            step: stepNum++,
            description: `Resolve keyof ${component.target}`,
            expression: `keyof ${component.target}`,
            result,
          });
        } else if (component.type === "utility") {
          // Evaluate the utility type with its resolved arguments
          const utilityExpr = `${component.utility}<${component.args.join(", ")}>`;
          const utilityResult = await this.evalType(utilityExpr, packageName);
          const result =
            "error" in utilityResult ? `Error: ${utilityResult.error}` : utilityResult.expanded;

          let description = `Apply ${component.utility}`;
          if (component.utility === "Pick") {
            description = `Pick properties ${component.args[1]} from ${component.args[0]}`;
          } else if (component.utility === "Omit") {
            description = `Omit properties ${component.args[1]} from ${component.args[0]}`;
          } else if (component.utility === "Partial") {
            description = `Make all properties of ${component.args[0]} optional`;
          } else if (component.utility === "Required") {
            description = `Make all properties of ${component.args[0]} required`;
          } else if (component.utility === "Readonly") {
            description = `Make all properties of ${component.args[0]} readonly`;
          } else if (component.utility === "ReturnType") {
            description = `Get return type of ${component.args[0]}`;
          } else if (component.utility === "Parameters") {
            description = `Get parameter types of ${component.args[0]}`;
          }

          steps.push({
            step: stepNum++,
            description,
            expression: utilityExpr,
            result,
          });
        } else if (component.type === "base") {
          // Resolve base type
          const baseResult = await this.evalType(component.name, packageName);
          const result = "error" in baseResult ? `Error: ${baseResult.error}` : baseResult.expanded;
          steps.push({
            step: stepNum++,
            description: `Resolve ${component.name}`,
            expression: component.name,
            result,
          });
        }
      }

      // Add final step if we have intermediate steps
      if (steps.length > 0 && steps[steps.length - 1]!.result !== finalResult) {
        steps.push({
          step: stepNum,
          description: "Final result",
          expression,
          result: finalResult,
        });
      }
    }

    // If no steps were generated, at least show the final result
    if (steps.length === 0) {
      steps.push({
        step: 1,
        description: "Evaluate expression",
        expression,
        result: finalResult,
      });
    }

    return {
      expression,
      steps,
      final: finalResult,
    };
  }

  /**
   * Parse a type expression to identify its components for step-by-step explanation.
   * Returns an ordered list of components from innermost to outermost.
   */
  private parseTypeExpression(
    expression: string,
  ): Array<
    | { type: "keyof"; target: string }
    | { type: "utility"; utility: string; args: string[] }
    | { type: "base"; name: string }
  > {
    const components: Array<
      | { type: "keyof"; target: string }
      | { type: "utility"; utility: string; args: string[] }
      | { type: "base"; name: string }
    > = [];

    const trimmed = expression.trim();

    // Check for keyof
    if (trimmed.startsWith("keyof ")) {
      const target = trimmed.slice(6).trim();
      components.push({ type: "keyof", target });
      return components;
    }

    // Check for utility types: Name<Args>
    const utilityMatch = trimmed.match(/^(\w+)<(.+)>$/);
    if (utilityMatch) {
      const utilityName = utilityMatch[1]!;
      const argsString = utilityMatch[2]!;

      // Parse args, handling nested generics
      const args = this.parseTypeArgs(argsString);

      // Check if first arg contains nested utilities
      for (const arg of args) {
        const nestedComponents = this.parseTypeExpression(arg);
        components.push(...nestedComponents);
      }

      // Add this utility
      components.push({
        type: "utility",
        utility: utilityName,
        args,
      });

      return components;
    }

    // Simple type name
    if (/^[\w.]+$/.test(trimmed)) {
      components.push({ type: "base", name: trimmed });
    }

    return components;
  }

  /**
   * Parse type arguments, handling nested generics.
   */
  private parseTypeArgs(argsString: string): string[] {
    const args: string[] = [];
    let current = "";
    let depth = 0;

    for (const char of argsString) {
      if (char === "<") {
        depth++;
        current += char;
      } else if (char === ">") {
        depth--;
        current += char;
      } else if (char === "," && depth === 0) {
        args.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      args.push(current.trim());
    }

    return args;
  }
}
