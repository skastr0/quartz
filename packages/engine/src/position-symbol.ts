import { SymbolFlags, type Project, type Type } from "tsrs/unstable/async"
import type { Node } from "tsrs/unstable/ast"

export interface SymbolDeclaration {
  /** Resolved symbol name at the node; aliases resolve to their target. */
  readonly symbol: string | null
  /** Declaration of that target, pointing at its name when it has one. */
  readonly declaration: {
    readonly file: string
    readonly line: number
    readonly column: number
  } | null
}

/**
 * Name and declaration for the symbol a node denotes. Type-reference nodes often
 * carry no symbol of their own, so the node's type is the fallback, and import
 * aliases are resolved so the answer names the declaration the reader cares about.
 */
export const symbolDeclarationFor = async (
  project: Project,
  node: Node,
  type: Type,
  relativeFile: (fileName: string) => string,
): Promise<SymbolDeclaration> => {
  const atNode = await project.checker.getSymbolAtLocation(node)
  const located = atNode ?? (await type.getSymbol()) ?? (await type.getAliasSymbol())
  const symbol = located !== undefined && (located.flags & SymbolFlags.Alias) !== SymbolFlags.None
    ? await project.checker.getAliasedSymbol(located)
    : located
  const resolved = symbol?.declarations[0] === undefined ? undefined : await symbol.declarations[0]!.resolve(project)
  // Point at the declaration's name when it has one (`toDTO`, not the `function` keyword).
  const declaration = resolved === undefined
    ? undefined
    : (resolved as typeof resolved & { readonly name?: Node }).name ?? resolved
  return {
    symbol: symbol?.name ?? null,
    declaration: declaration === undefined
      ? null
      : {
          file: relativeFile(declaration.getSourceFile().fileName),
          line: declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart()).line + 1,
          column: declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart()).character + 1,
        },
  }
}
