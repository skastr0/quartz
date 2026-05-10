import {
  Project,
  type SourceFile,
  SyntaxKind,
  Node,
} from "ts-morph";
import { isAbsolute, join, relative } from "path";

import { getDeclarationName } from "./declarations";
import type { PackageInfo } from "./discovery";
import {
  createProjectWorkspaceState,
  getCachedProject,
  getWorkspacePackages,
  getWorkspaceSourceFiles,
  kindToString,
  markWorkspaceDirty,
  refreshAllProjects,
  refreshPackageProject,
  resolveWorkspacePackage,
  type ProjectWorkspaceState,
  workspaceRelativePath,
} from "./project-workspace";
import type {
  ListSymbolsOptions,
  SymbolInfo,
  SymbolListResult,
} from "./project-types";

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
  private readonly workspace: ProjectWorkspaceState;

  constructor(directory: string, workspace: ProjectWorkspaceState = createProjectWorkspaceState(directory)) {
    this.workspace = workspace;
  }

  private get rootDirectory(): string {
    return this.workspace.rootDirectory;
  }

  /**
   * Mark the project cache as dirty. Next getProject() call will rebuild.
   * Called by plugin hook after edit/write tool executions.
   */
  markDirty(): void {
    markWorkspaceDirty(this.workspace);
  }

  /**
   * Clear all cached projects. Use when files were modified outside of opencode tools.
   */
  refreshAll(): void {
    refreshAllProjects(this.workspace);
  }

  /**
   * Clear cached project for a specific package.
   */
  async refreshPackage(packageName: string): Promise<boolean> {
    return refreshPackageProject(this.workspace, packageName);
  }

  async getPackages(): Promise<PackageInfo[]> {
    return [...getWorkspacePackages(this.workspace)];
  }

  private async resolvePackage(packageName?: string): Promise<PackageInfo> {
    return resolveWorkspacePackage(this.workspace, packageName);
  }

  private getProject(pkg: PackageInfo): Project {
    return getCachedProject(this.workspace, pkg);
  }

  private getSourceFiles(project: Project, pkg: PackageInfo): SourceFile[] {
    return getWorkspaceSourceFiles(project, pkg);
  }

  private kindToString(kind: SyntaxKind): string {
    return kindToString(kind);
  }

  private relativePath(absolutePath: string): string {
    return workspaceRelativePath(this.workspace, absolutePath);
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

}
