import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { NativeCommandContext } from "../context"
import { QuartzError } from "../../errors"
import { findNativeOutgoingReferences, findNativeTargetInProject, loadNativeTarget, type NativeTarget } from "../references"
import type { GraphEdge, GraphResult } from "../../project-types"

/**
 * Native `generateGraph` — not yet implemented. Its owning builder replaces this
 * body; the delegator in `native/index.ts` stays frozen. Until then it returns
 * the engine-not-supported error so callers get a clean, actionable failure.
 */
export const generateGraph =
  (ctx: NativeCommandContext): TypeAnalyzer["generateGraph"] =>
  (symbolName, options = {}) =>
    Effect.try({
      try: () => {
        const { depth = 2, format = "mermaid", packageName } = options
        const maxDepth = Math.min(depth, 4)
        const edges: GraphEdge[] = []
        const visited = new Set<string>()
        const nodes = new Set<string>()
        const rootTarget = loadNativeTarget(ctx, packageName, symbolName)
        if (rootTarget === null) return null

        const traverse = (target: NativeTarget, currentDepth: number): void => {
          const symbol = target.symbol.name
          if (currentDepth > maxDepth || visited.has(symbol)) return
          visited.add(symbol)
          nodes.add(symbol)
          for (const reference of findNativeOutgoingReferences(target)) {
            if (isPrimitiveOrBuiltin(reference.symbol)) continue
            const referencedTarget = findNativeTargetInProject(target.packageInfo, target.project, reference.symbol)
            if (referencedTarget === null) continue
            nodes.add(reference.symbol)
            edges.push({ from: symbol, to: reference.symbol, label: reference.context })
            if (currentDepth < maxDepth) traverse(referencedTarget, currentDepth + 1)
          }
        }
        traverse(rootTarget, 0)
        return {
          root: symbolName,
          format,
          depth: maxDepth,
          nodes: Array.from(nodes),
          edges,
          graph: format === "mermaid" ? toMermaid(edges) : toDot(edges),
        } satisfies GraphResult
      },
      catch: (cause) => cause instanceof QuartzError ? cause : new QuartzError({ message: "Could not generate type graph", cause }),
    })

const isPrimitiveOrBuiltin = (typeName: string): boolean => new Set([
  "string", "number", "boolean", "undefined", "null", "void", "any", "unknown", "never", "object", "symbol", "bigint",
  "Date", "Array", "Object", "String", "Number", "Boolean", "Promise", "Map", "Set", "WeakMap", "WeakSet", "RegExp", "Error", "Function",
]).has(typeName)

const toMermaid = (edges: readonly GraphEdge[]): string => {
  const lines = ["graph TD"]
  const seen = new Set<string>()
  for (const edge of edges) {
    const from = sanitizeMermaidId(edge.from)
    const to = sanitizeMermaidId(edge.to)
    const key = `${from}-->${to}`
    if (seen.has(key)) continue
    seen.add(key)
    const label = edge.label?.replace(/"/g, "'").replace(/[|[\]]/g, "")
    lines.push(label === undefined ? `  ${from} --> ${to}` : `  ${from} -->|${label}| ${to}`)
  }
  return lines.join("\n")
}

const toDot = (edges: readonly GraphEdge[]): string => {
  const lines = ["digraph G {", "  rankdir=TB;", "  node [shape=box];"]
  const seen = new Set<string>()
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`
    if (seen.has(key)) continue
    seen.add(key)
    const from = `"${edge.from.replace(/"/g, '\\"')}"`
    const to = `"${edge.to.replace(/"/g, '\\"')}"`
    const label = edge.label?.replace(/"/g, '\\"')
    lines.push(label === undefined ? `  ${from} -> ${to};` : `  ${from} -> ${to} [label="${label}"];`)
  }
  lines.push("}")
  return lines.join("\n")
}

const sanitizeMermaidId = (name: string): string => name.replace(/[^a-zA-Z0-9_]/g, "_")
