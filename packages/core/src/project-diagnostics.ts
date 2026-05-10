import type { Project } from "ts-morph";
import type { PackageInfo } from "./discovery";
import type { CachedProject } from "./project-workspace";

export interface ProjectDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly code: number;
}

export interface DiagnosticsContext {
  readonly relativePath: (absolutePath: string) => string;
}

export const collectPackageDiagnostics = (
  project: Project,
  pkg: PackageInfo,
  context: DiagnosticsContext,
): ProjectDiagnostic[] => {
  const result: ProjectDiagnostic[] = [];

  for (const diagnostic of project.getPreEmitDiagnostics()) {
    const sourceFile = diagnostic.getSourceFile();
    if (sourceFile === undefined) continue;

    const filePath = sourceFile.getFilePath();
    if (!filePath.startsWith(pkg.path)) continue;

    const lineAndColumn = sourceFile.getLineAndColumnAtPos(diagnostic.getStart() ?? 0);
    result.push({
      file: context.relativePath(filePath),
      line: lineAndColumn.line,
      column: lineAndColumn.column,
      message: diagnostic.getMessageText().toString(),
      code: diagnostic.getCode(),
    });
  }

  return result;
};

export const collectLoadedPackageDiagnostics = (
  projects: Iterable<CachedProject>,
  context: DiagnosticsContext,
): Map<string, ProjectDiagnostic[]> => {
  const result = new Map<string, ProjectDiagnostic[]>();

  for (const cached of projects) {
    const diagnostics = collectPackageDiagnostics(cached.project, cached.packageInfo, context);
    if (diagnostics.length > 0) {
      result.set(cached.packageInfo.name, diagnostics);
    }
  }

  return result;
};
