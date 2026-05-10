import type { Project, Symbol, Node } from "ts-morph";
import { Effect } from "effect";
import type { PackageInfo } from "./discovery";
import type { GraphEdge, GraphResult, RelatedInfo } from "./project-types";

export interface TypeGraphContext {
  readonly findSymbol: (
    symbolName: string,
    project: Project,
    pkg: PackageInfo,
  ) => Effect.Effect<{ node: Node; symbol: Symbol } | null, unknown>;
  readonly findRelated: (symbolName: string, packageName?: string) => Effect.Effect<RelatedInfo | null, unknown>;
}

export const generateTypeGraph = (
  symbolName: string,
  options: { readonly depth?: number; readonly format?: "mermaid" | "dot"; readonly packageName?: string },
  project: Project,
  pkg: PackageInfo,
  context: TypeGraphContext,
): Effect.Effect<GraphResult | null, unknown> => Effect.gen(function* () {
  const { depth = 2, format = "mermaid", packageName } = options;
  const maxDepth = Math.min(depth, 4);

  const found = yield* context.findSymbol(symbolName, project, pkg);
  if (found === null) return null;

  const edges: GraphEdge[] = [];
  const visited = new Set<string>();
  const nodes = new Set<string>();

  const traverse = (symbol: string, currentDepth: number): Effect.Effect<void, unknown> => Effect.gen(function* () {
    if (currentDepth > maxDepth || visited.has(symbol)) return;
    visited.add(symbol);
    nodes.add(symbol);

    const related = yield* context.findRelated(symbol, packageName);
    if (related === null) return;

    for (const ref of related.references) {
      const targetSymbol = ref.symbol;
      if (isPrimitiveOrBuiltin(targetSymbol)) continue;
      const foundTarget = yield* context.findSymbol(targetSymbol, project, pkg);
      if (foundTarget === null) continue;

      nodes.add(targetSymbol);
      edges.push({ from: symbol, to: targetSymbol, label: ref.context });

      if (currentDepth < maxDepth) {
        yield* traverse(targetSymbol, currentDepth + 1);
      }
    }
  });

  yield* traverse(symbolName, 0);

  return {
    root: symbolName,
    format,
    depth: maxDepth,
    nodes: Array.from(nodes),
    edges,
    graph: format === "mermaid" ? toMermaid(edges) : toDot(edges),
  };
});

export const isPrimitiveOrBuiltin = (typeName: string): boolean => {
  const primitives = new Set([
    "string",
    "number",
    "boolean",
    "undefined",
    "null",
    "void",
    "any",
    "unknown",
    "never",
    "object",
    "symbol",
    "bigint",
    "Date",
    "Array",
    "Object",
    "String",
    "Number",
    "Boolean",
    "Promise",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "RegExp",
    "Error",
    "Function",
  ]);
  return primitives.has(typeName);
};

export const toMermaid = (edges: readonly GraphEdge[]): string => {
  const lines = ["graph TD"];
  const seen = new Set<string>();

  for (const edge of edges) {
    const fromNode = sanitizeMermaidId(edge.from);
    const toNode = sanitizeMermaidId(edge.to);
    const key = `${fromNode}-->${toNode}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (edge.label !== undefined) {
      const safeLabel = edge.label.replace(/"/g, "'").replace(/[|[\]]/g, "");
      lines.push(`  ${fromNode} -->|${safeLabel}| ${toNode}`);
    } else {
      lines.push(`  ${fromNode} --> ${toNode}`);
    }
  }

  return lines.join("\n");
};

export const toDot = (edges: readonly GraphEdge[]): string => {
  const lines = ["digraph G {", "  rankdir=TB;", "  node [shape=box];"];
  const seen = new Set<string>();

  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const fromNode = `"${edge.from.replace(/"/g, '\\"')}"`;
    const toNode = `"${edge.to.replace(/"/g, '\\"')}"`;

    if (edge.label !== undefined) {
      const safeLabel = edge.label.replace(/"/g, '\\"');
      lines.push(`  ${fromNode} -> ${toNode} [label="${safeLabel}"];`);
    } else {
      lines.push(`  ${fromNode} -> ${toNode};`);
    }
  }

  lines.push("}");
  return lines.join("\n");
};

const sanitizeMermaidId = (name: string): string => name.replace(/[^a-zA-Z0-9_]/g, "_");
