import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { DiagnosticInfo, TypeAnalyzer } from "../../analyzer"
import type { NativeCommandContext } from "../context"
import { DiagnosticCategory, type Diagnostic, type Program } from "typescript/unstable/sync"
import {
  findNativeSourceFile,
  isWithinPackage,
  nativeRelativePath,
  resolveNativePackage,
  toNativeCommandError,
} from "../diagnostics-position-helpers"
import { engineNotSupported } from "../errors"

/**
 * Native diagnostics use the same plain-data envelope as the morph engine. Native
 * diagnostic positions are UTF-16 offsets, so source-file line mapping is kept in
 * this command rather than leaking native AST objects across the analyzer seam.
 */
export const getDiagnostics =
  (ctx: NativeCommandContext): TypeAnalyzer["getDiagnostics"] =>
  (packageNameOrOptions) =>
    Effect.gen(function* () {
      const packageName = typeof packageNameOrOptions === "string" ? packageNameOrOptions : packageNameOrOptions?.packageName
      const packageInfo = yield* resolveNativePackage(ctx.rootDirectory, packageName)

      const rawDiagnostics: readonly DiagnosticInfo[] = yield* Effect.try({
        try: () => {
          const program = ctx.engine.getProgram(packageInfo.tsconfigPath)
          const diagnostics = [
            ...program.getSyntacticDiagnostics(),
            ...program.getSemanticDiagnostics(),
            ...program.getConfigFileParsingDiagnostics(),
          ]

          return diagnostics
            .filter((diagnostic) => diagnostic.fileName === undefined || isWithinPackage(diagnostic.fileName, packageInfo))
            .map((diagnostic) => mapDiagnostic(ctx.rootDirectory, program, diagnostic))
        },
        catch: (cause) => toNativeCommandError("Could not get native diagnostics", cause),
      })

      if (typeof packageNameOrOptions !== "object" || packageNameOrOptions?.explain !== true) {
        return rawDiagnostics
      }

      return yield* Effect.fail(engineNotSupported("getDiagnostics(explain)"))
    })

const mapDiagnostic = (
  rootDirectory: string,
  program: Program,
  diagnostic: Diagnostic,
): DiagnosticInfo => {
  const fileName = diagnostic.fileName
  const sourceFile = fileName === undefined ? undefined : findNativeSourceFile(program, rootDirectory, fileName)
  const sourceText = sourceFile?.text ?? readDiagnosticFile(fileName, rootDirectory)
  const position = diagnostic.pos >= 0 ? diagnostic.pos : undefined
  const location = position === undefined || sourceText === undefined ? undefined : getLocation(sourceFile, sourceText, position)
  const category = DiagnosticCategory[diagnostic.category]

  return {
    message: diagnostic.text,
    code: diagnostic.code,
    ...(typeof category === "string" ? { category } : {}),
    ...(fileName === undefined ? {} : { file: nativeRelativePath(rootDirectory, resolveDiagnosticPath(fileName, rootDirectory)) }),
    ...(location === undefined
      ? {}
      : {
          line: location.line,
          column: location.column,
        }),
  }
}

const resolveDiagnosticPath = (fileName: string, rootDirectory: string): string =>
  isAbsolute(fileName) ? fileName : resolve(rootDirectory, fileName)

const readDiagnosticFile = (fileName: string | undefined, rootDirectory: string): string | undefined => {
  if (fileName === undefined) return undefined
  try {
    return readFileSync(resolveDiagnosticPath(fileName, rootDirectory), "utf8")
  } catch {
    return undefined
  }
}

const getLocation = (
  sourceFile: ReturnType<Program["getSourceFile"]>,
  sourceText: string,
  position: number,
): { readonly line: number; readonly column: number } => {
  if (sourceFile !== undefined) {
    const lineAndCharacter = sourceFile.getLineAndCharacterOfPosition(position)
    return { line: lineAndCharacter.line + 1, column: lineAndCharacter.character + 1 }
  }

  const boundedPosition = Math.min(position, sourceText.length)
  const prefix = sourceText.slice(0, boundedPosition)
  const line = prefix.split("\n").length
  const lastNewline = prefix.lastIndexOf("\n")
  return { line, column: boundedPosition - lastNewline }
}
