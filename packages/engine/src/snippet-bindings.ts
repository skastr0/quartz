import { SyntaxKind } from "typescript/unstable/ast"
import { createScanner } from "typescript/unstable/ast/scanner"

interface Token {
  readonly kind: SyntaxKind
  readonly text: string
  readonly depth: number
}

const opens = new Set([SyntaxKind.OpenBraceToken, SyntaxKind.OpenParenToken, SyntaxKind.OpenBracketToken])
const closes = new Set([SyntaxKind.CloseBraceToken, SyntaxKind.CloseParenToken, SyntaxKind.CloseBracketToken])

/**
 * Tokenize with the compiler's scanner, tagging each token with its bracket
 * depth. Template substitutions are rescanned so their braces stay balanced.
 */
const tokenize = (code: string): readonly Token[] => {
  const scanner = createScanner(true)
  scanner.setText(code)
  const tokens: Token[] = []
  const stack: ("bracket" | "template")[] = []
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.CloseBraceToken && stack.at(-1) === "template") {
      if (scanner.reScanTemplateToken(false) === SyntaxKind.TemplateTail) stack.pop()
      continue
    }
    if (closes.has(kind)) stack.pop()
    tokens.push({ kind, text: scanner.getTokenValue() || scanner.getTokenText(), depth: stack.length })
    if (opens.has(kind)) stack.push("bracket")
    if (kind === SyntaxKind.TemplateHead) stack.push("template")
  }
  return tokens
}

const isName = (token: Token | undefined): token is Token =>
  token !== undefined && (token.kind === SyntaxKind.Identifier || (token.kind > SyntaxKind.LastReservedWord && token.kind <= SyntaxKind.LastKeyword))

const declarationKeywords = new Map<string, SyntaxKind>([
  ["function", SyntaxKind.FunctionKeyword],
  ["class", SyntaxKind.ClassKeyword],
  ["interface", SyntaxKind.InterfaceKeyword],
  ["enum", SyntaxKind.EnumKeyword],
  ["namespace", SyntaxKind.NamespaceKeyword],
])

/** Names bound by an import clause starting after `import` at `start`. */
const importBindings = (tokens: readonly Token[], start: number, names: Set<string>): number => {
  let index = start
  const next = tokens[index]
  if (next === undefined || next.kind === SyntaxKind.OpenParenToken || next.kind === SyntaxKind.DotToken) return index
  if (next.kind === SyntaxKind.TypeKeyword && tokens[index + 1]?.kind !== SyntaxKind.CommaToken && tokens[index + 1]?.kind !== SyntaxKind.FromKeyword) index += 1
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.kind === SyntaxKind.FromKeyword || token.kind === SyntaxKind.StringLiteral || token.kind === SyntaxKind.SemicolonToken) return index
    if (token.kind === SyntaxKind.EqualsToken) return index
    if (!isName(token) || token.kind === SyntaxKind.AsKeyword) continue
    const following = tokens[index + 1]
    if (following?.kind === SyntaxKind.AsKeyword) continue
    if (token.kind === SyntaxKind.TypeKeyword && isName(following)) continue
    names.add(token.text)
    if (following?.kind === SyntaxKind.EqualsToken) return index + 1
  }
  return index
}

/** Names bound by `const` / `let` / `var` declarators starting at `start`. */
const variableBindings = (tokens: readonly Token[], start: number, depth: number, names: Set<string>): number => {
  let index = start
  let expectingBinding = true
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.depth === depth && token.kind === SyntaxKind.SemicolonToken) return index
    if (token.depth === depth && isDeclarationStart(tokens, index)) return index - 1
    if (token.depth === depth && token.kind === SyntaxKind.CommaToken) {
      expectingBinding = true
      continue
    }
    if (token.depth === depth && token.kind === SyntaxKind.EqualsToken) {
      expectingBinding = false
      continue
    }
    if (!expectingBinding) continue
    if (token.depth === depth && isName(token)) {
      names.add(token.text)
      expectingBinding = false
      continue
    }
    if (token.depth === depth + 1 && isName(token)) {
      const previous = tokens[index - 1]
      const following = tokens[index + 1]
      const bindsName =
        following?.kind !== SyntaxKind.ColonToken
        && previous?.kind !== SyntaxKind.EqualsToken
        && (following === undefined
          || following.kind === SyntaxKind.CommaToken
          || following.kind === SyntaxKind.EqualsToken
          || following.kind === SyntaxKind.CloseBraceToken
          || following.kind === SyntaxKind.CloseBracketToken)
      if (bindsName) names.add(token.text)
    }
  }
  return index
}

const variableKeywords = new Set([SyntaxKind.ConstKeyword, SyntaxKind.LetKeyword, SyntaxKind.VarKeyword])

const isDeclarationStart = (tokens: readonly Token[], index: number): boolean => {
  const token = tokens[index]!
  if (token.kind === SyntaxKind.ImportKeyword || token.kind === SyntaxKind.ExportKeyword) return true
  if (token.kind === SyntaxKind.DeclareKeyword || token.kind === SyntaxKind.AbstractKeyword) return isName(tokens[index + 1])
  if (variableKeywords.has(token.kind)) return isName(tokens[index + 1]) || tokens[index + 1]?.kind === SyntaxKind.OpenBraceToken || tokens[index + 1]?.kind === SyntaxKind.OpenBracketToken
  return [...declarationKeywords.values()].includes(token.kind) && isName(tokens[index + 1])
}

/**
 * Top-level names a snippet binds itself: import bindings and declarations.
 * The snippet's own bindings win over the package imports Quartz adds for
 * convenience, so they must not be imported a second time.
 */
export const snippetTopLevelBindings = (code: string): ReadonlySet<string> => {
  const tokens = tokenize(code)
  const names = new Set<string>()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.depth !== 0) continue
    const following = tokens[index + 1]
    if (token.kind === SyntaxKind.ImportKeyword) {
      index = importBindings(tokens, index + 1, names)
    } else if (variableKeywords.has(token.kind) && following?.kind !== SyntaxKind.EnumKeyword) {
      index = variableBindings(tokens, index + 1, 0, names)
    } else if (token.kind === SyntaxKind.TypeKeyword && isName(following)) {
      const after = tokens[index + 2]
      if (after?.kind === SyntaxKind.EqualsToken || after?.kind === SyntaxKind.LessThanToken) {
        names.add(following.text)
        index += 1
      }
    } else if ([...declarationKeywords.values()].includes(token.kind)) {
      const name = following?.kind === SyntaxKind.AsteriskToken ? tokens[index + 2] : following
      if (isName(name) && !(token.kind === SyntaxKind.NamespaceKeyword && name.text === "global")) names.add(name.text)
    }
  }
  return names
}
