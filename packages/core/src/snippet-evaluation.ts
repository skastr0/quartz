import { dirname, join, relative } from "path";
import { Node, type Project, type SourceFile, TypeFormatFlags } from "ts-morph";
import { getDeclarationName } from "./declarations";
import type { PackageInfo } from "./discovery";
import type { SnippetCheckResult, SnippetDiagnostic, SnippetExportSource, SnippetImportPlan } from "./project-types";

export class SnippetEvaluator {
  evalType(
    expression: string,
    project: Project,
    pkg: PackageInfo,
    sourceFiles: readonly SourceFile[],
  ): { result: string; expanded: string } | { error: string } {
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
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  checkSnippet(
    code: string,
    project: Project,
    pkg: PackageInfo,
    sourceFiles: readonly SourceFile[],
  ): SnippetCheckResult {
    const tempFileName = join(this.getSnippetTempDirectory(project, pkg), `__snippet_check_${Date.now()}__.ts`);
    const tempDir = dirname(tempFileName);
    const importPlan = this.createSnippetImportPlan(project, sourceFiles, tempDir, code);

    try {
      const tempFile = project.createSourceFile(tempFileName, importPlan.fileContent, { overwrite: true });
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

  private createEvalTypeContent(sourceFiles: readonly SourceFile[], tempDir: string, expression: string): string {
    const exportSources = this.collectSnippetExportSources(sourceFiles);
    const fileExports = this.groupEvalImportsByFile(exportSources);
    const imports = this.createEvalTypeImports(fileExports, tempDir);
    return `${imports.join("\n")}\ntype __EvalResult__ = ${expression};`;
  }

  private groupEvalImportsByFile(exportSources: Map<string, SnippetExportSource[]>): Map<string, string[]> {
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

  private createEvalTypeImports(fileExports: Map<string, string[]>, tempDir: string): string[] {
    const imports: string[] = [];
    for (const [absolutePath, exportList] of fileExports) {
      if (exportList.length === 0) continue;
      const modulePath = toSnippetModulePath(tempDir, absolutePath);
      imports.push(`import type { ${exportList.join(", ")} } from "${modulePath}";`);
    }
    return imports;
  }

  private evaluateTypeAlias(
    project: Project,
    tempFile: SourceFile,
  ): { result: string; expanded: string } | { error: string } {
    const typeAlias = tempFile.getTypeAlias("__EvalResult__");
    if (typeAlias === undefined) return { error: "Failed to parse type expression" };

    const type = typeAlias.getType();
    return {
      result: type.getText(typeAlias),
      expanded: formatExpandedType(project, typeAlias, type),
    };
  }

  private createSnippetImportPlan(
    project: Project,
    sourceFiles: readonly SourceFile[],
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

  private collectSnippetExportSources(sourceFiles: readonly SourceFile[]): Map<string, SnippetExportSource[]> {
    const exportSources = new Map<string, SnippetExportSource[]>();

    for (const sourceFile of sourceFiles) {
      const filePath = sourceFile.getFilePath();
      const absolutePath = sourceFile.getFilePath();

      for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
        if (name === "default") {
          for (const declaration of declarations) {
            const actualName = getDeclarationName(declaration);
            if (actualName !== null) {
              addSnippetExportSource(exportSources, actualName, { filePath, absolutePath, isDefault: true });
            }
          }
        } else {
          addSnippetExportSource(exportSources, name, { filePath, absolutePath, isDefault: false });
        }
      }
    }

    return exportSources;
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
        const target = isTypeOnlyExport(name, project, source.absolutePath) ? existing.type : existing.value;
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
        const modulePath = toSnippetModulePath(tempDir, absolutePath);
        imports.push(`${prefix} { ${exportList.join(", ")} } from "${modulePath}";`);
      }
    }
    return imports;
  }

  private toSnippetDiagnostic(
    diagnostic: import("ts-morph").Diagnostic,
    importLineCount: number,
  ): SnippetDiagnostic {
    const start = diagnostic.getStart();
    const sourceFile = diagnostic.getSourceFile();
    let line = 1;
    let column = 1;

    if (start !== undefined && sourceFile !== undefined) {
      const pos = sourceFile.getLineAndColumnAtPos(start);
      line = Math.max(1, pos.line - importLineCount);
      column = pos.column;
    }

    const messageText = diagnostic.getMessageText();
    const message = typeof messageText === "string" ? messageText : messageText.getMessageText();
    const severity: "error" | "warning" = diagnostic.getCategory() === 1 ? "error" : "warning";

    return { message, line, column, severity };
  }

  private getSnippetTempDirectory(project: Project, pkg: PackageInfo): string {
    const rootDir = project.getCompilerOptions().rootDir;
    return typeof rootDir === "string" && rootDir.length > 0 ? rootDir : pkg.path;
  }

  private removeTempSourceFile(project: Project, tempFileName: string): void {
    try {
      const tempFile = project.getSourceFile(tempFileName);
      if (tempFile !== undefined) project.removeSourceFile(tempFile);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

const formatExpandedType = (
  project: Project,
  typeAlias: import("ts-morph").TypeAliasDeclaration,
  type: import("ts-morph").Type,
): string => {
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
};

const addSnippetExportSource = (
  exportSources: Map<string, SnippetExportSource[]>,
  name: string,
  source: SnippetExportSource,
): void => {
  const sources = exportSources.get(name) ?? [];
  sources.push(source);
  exportSources.set(name, sources);
};

const toSnippetModulePath = (tempDir: string, absolutePath: string): string => {
  let modulePath = relative(tempDir, absolutePath);
  if (!modulePath.startsWith(".") && !modulePath.startsWith("/")) {
    modulePath = "./" + modulePath;
  }
  return modulePath.replace(/\\/g, "/").replace(/\.(ts|tsx)$/, "");
};

const isTypeOnlyExport = (name: string, project: Project, absolutePath: string): boolean => {
  const sourceFile = project.getSourceFile(absolutePath);
  const declarations = sourceFile?.getExportedDeclarations().get(name) ?? [];
  return declarations.length > 0 && declarations.every((declaration) =>
    Node.isInterfaceDeclaration(declaration) || Node.isTypeAliasDeclaration(declaration)
  );
};
