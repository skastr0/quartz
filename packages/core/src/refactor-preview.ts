import type { Node, Project, Symbol } from "ts-morph";
import { SyntaxKind } from "ts-morph";
import type { PackageInfo } from "./discovery";
import type { RefactorError, RefactorLocation, RefactorPreviewResult, StringLiteralRef } from "./project-types";

export interface RefactorPreviewContext {
  readonly relativePath: (absolutePath: string) => string;
}

export const previewRenameRefactor = (
  options: { readonly symbol: string; readonly to: string },
  project: Project,
  pkg: PackageInfo,
  found: { readonly node: Node; readonly symbol: Symbol },
  context: RefactorPreviewContext,
): RefactorPreviewResult => {
  const { node, symbol } = found;
  const languageService = project.getLanguageService();
  const symbolName = symbol.getName();
  const renameLocations = languageService.findRenameLocations(node);

  const locations: RefactorLocation[] = [];
  const predictedErrors: RefactorError[] = [];
  const safetyNotes: string[] = [];
  const affectedFiles = new Set<string>();
  const replaceRegex = new RegExp(`\\b${escapeRegex(symbolName)}\\b`, "g");

  for (const location of renameLocations) {
    const sourceFile = location.getSourceFile();
    const filePath = context.relativePath(sourceFile.getFilePath());
    const absolutePath = sourceFile.getFilePath();
    const textSpan = location.getTextSpan();
    const lineAndColumn = sourceFile.getLineAndColumnAtPos(textSpan.getStart());
    const line = lineAndColumn.line;
    const column = lineAndColumn.column;

    affectedFiles.add(absolutePath);
    addRenameLocationSafetyError(predictedErrors, sourceFile.isDeclarationFile(), absolutePath, pkg.path, filePath, line);

    const fullText = sourceFile.getFullText();
    const lineText = fullText.split("\n")[line - 1] ?? "";
    const before = lineText.trim();
    const after = before.replace(replaceRegex, options.to);

    locations.push({ file: filePath, line, column, before, after });
  }

  const stringLiteralLocations = findStringLiteralReferencesInFiles(symbolName, project, affectedFiles, context);
  const commentLocations = findCommentReferencesInFiles(symbolName, project, affectedFiles, context);

  if (stringLiteralLocations.length > 0) {
    safetyNotes.push(
      `${stringLiteralLocations.length} string literal(s) contain "${symbolName}" and won't be renamed automatically`,
    );
  }

  if (commentLocations.length > 0) {
    safetyNotes.push(`${commentLocations.length} comment(s) contain "${symbolName}" and may need manual review`);
  }

  const confidence = calculateConfidence(
    predictedErrors.length,
    stringLiteralLocations.length,
    commentLocations.length,
  );

  return {
    action: "rename",
    from: symbolName,
    to: options.to,
    locations: locations.slice(0, 100),
    totalLocations: locations.length,
    predictedErrors,
    confidence,
    safe: predictedErrors.length === 0 && safetyNotes.length === 0,
    safetyNotes,
    stringLiteralLocations: stringLiteralLocations.slice(0, 20),
    commentLocations: commentLocations.slice(0, 20),
  };
};

const addRenameLocationSafetyError = (
  predictedErrors: RefactorError[],
  isDeclarationFile: boolean,
  absolutePath: string,
  packagePath: string,
  filePath: string,
  line: number,
): void => {
  const errorKey = `${filePath}:${line}`;
  if (predictedErrors.some((error) => `${error.file}:${error.line}` === errorKey)) return;

  if (isDeclarationFile) {
    predictedErrors.push({ file: filePath, line, message: "Cannot rename: declaration file (.d.ts)" });
    return;
  }

  if (!absolutePath.startsWith(packagePath)) {
    predictedErrors.push({ file: filePath, line, message: "Cannot rename: file is outside package boundary" });
  }
};

const calculateConfidence = (
  errorCount: number,
  stringLiteralCount: number,
  commentCount: number,
): "high" | "medium" | "low" => {
  if (errorCount > 0) return "low";
  if (stringLiteralCount > 0) return "medium";
  return commentCount > 0 ? "high" : "high";
};

const findStringLiteralReferencesInFiles = (
  symbolName: string,
  project: Project,
  filePaths: ReadonlySet<string>,
  context: RefactorPreviewContext,
): StringLiteralRef[] => {
  const results: StringLiteralRef[] = [];
  const regex = new RegExp(`\\b${escapeRegex(symbolName)}\\b`);

  for (const absolutePath of filePaths) {
    const sourceFile = project.getSourceFile(absolutePath);
    if (sourceFile === undefined) continue;

    for (const literal of sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
      const text = literal.getLiteralText();
      if (!regex.test(text)) continue;

      results.push({
        file: context.relativePath(sourceFile.getFilePath()),
        line: literal.getStartLineNumber(),
        content: text.length > 50 ? text.slice(0, 50) + "..." : text,
      });
    }
  }

  return results;
};

const findCommentReferencesInFiles = (
  symbolName: string,
  project: Project,
  filePaths: ReadonlySet<string>,
  context: RefactorPreviewContext,
): StringLiteralRef[] => {
  const results: StringLiteralRef[] = [];
  const regex = new RegExp(`\\b${escapeRegex(symbolName)}\\b`);

  for (const absolutePath of filePaths) {
    const sourceFile = project.getSourceFile(absolutePath);
    if (sourceFile === undefined) continue;

    const lines = sourceFile.getFullText().split("\n");
    const filePath = context.relativePath(sourceFile.getFilePath());

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const singleLineMatch = line.match(/\/\/(.*)$/);
      if (singleLineMatch !== null && regex.test(singleLineMatch[1]!)) {
        addCommentReference(results, filePath, index + 1, singleLineMatch[1]!.trim());
        continue;
      }

      if ((line.includes("/*") || line.includes("*")) && regex.test(line)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) {
          addCommentReference(results, filePath, index + 1, trimmed);
        }
      }
    }
  }

  return results;
};

const addCommentReference = (results: StringLiteralRef[], file: string, line: number, content: string): void => {
  results.push({
    file,
    line,
    content: content.length > 50 ? content.slice(0, 50) + "..." : content,
  });
};

const escapeRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
