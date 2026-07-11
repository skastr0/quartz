import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { NativeCommandContext } from "../context"
import { NodeBuilderFlags } from "typescript/unstable/sync"
import { SyntaxKind } from "typescript/unstable/ast"
import {
  findNativeNodeAtPosition,
  findNativeSourceFile,
  nativeRelativePath,
  resolveNativePackage,
  toNativeCommandError,
} from "../diagnostics-position-helpers"

/**
 * Native position analysis resolves the exact UTF-16 offset through the native
 * program/checker, then uses the native AST for the node envelope fields.
 */
export const getTypeAtPosition =
  (ctx: NativeCommandContext): TypeAnalyzer["getTypeAtPosition"] =>
  (filePath, line, column, packageName) =>
    Effect.gen(function* () {
      const packageInfo = yield* resolveNativePackage(ctx.rootDirectory, packageName)

      return yield* Effect.try({
        try: () => {
          const project = ctx.engine.getProject(packageInfo.tsconfigPath)
          const program = project.program
          const sourceFile = findNativeSourceFile(program, ctx.rootDirectory, filePath)
          if (sourceFile === undefined) return null

          const position = sourceFile.getPositionOfLineAndCharacter(line - 1, column - 1)
          const node = findNativeNodeAtPosition(sourceFile, position)
          const type = project.checker.getTypeAtPosition(sourceFile.fileName, position)
          if (node === null || type === undefined) return null

          const checker = project.checker
          const expanded = checker.typeToString(type, node, positionFormatFlags)
          const lineAndCharacter = sourceFile.getLineAndCharacterOfPosition(node.getStart())

          return {
            type: checker.typeToString(type, node),
            expanded,
            nodeKind: SyntaxKind[node.kind] ?? "unknown",
            nodeText: truncate(node.getText(sourceFile)),
            location: {
              file: nativeRelativePath(ctx.rootDirectory, sourceFile.fileName),
              line: lineAndCharacter.line + 1,
              column: lineAndCharacter.line + 1 === line ? column : 1,
            },
          }
        },
        catch: (cause) => toNativeCommandError("Could not get native type at position", cause),
      })
    })

const positionFormatFlags =
  NodeBuilderFlags.NoTruncation |
  NodeBuilderFlags.WriteArrayAsGenericType |
  NodeBuilderFlags.UseStructuralFallback |
  NodeBuilderFlags.WriteTypeArgumentsOfSignature |
  NodeBuilderFlags.InTypeAlias

const truncate = (text: string): string => (text.length > 100 ? `${text.slice(0, 100)}...` : text)
