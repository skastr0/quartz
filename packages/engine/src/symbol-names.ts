/**
 * The checker stores symbol-keyed members under an escaped internal name:
 * `__@iterator@100` for `[Symbol.iterator]`, `__@key@7` for a unique symbol `key`.
 * The numeric suffix is a per-program id that differs between programs and
 * compiler backends, so it never belongs in output.
 */
const wellKnownSymbols: ReadonlySet<string> = new Set([
  "asyncDispose",
  "asyncIterator",
  "dispose",
  "hasInstance",
  "isConcatSpreadable",
  "iterator",
  "match",
  "matchAll",
  "replace",
  "search",
  "species",
  "split",
  "toPrimitive",
  "toStringTag",
  "unscopables",
])

const escapedSymbolName = /^__@(.+)@\d+$/

export const displaySymbolName = (name: string): string => {
  const match = escapedSymbolName.exec(name)
  if (match === null) return name
  const inner = match[1]!
  return wellKnownSymbols.has(inner) ? `[Symbol.${inner}]` : `[${inner}]`
}
