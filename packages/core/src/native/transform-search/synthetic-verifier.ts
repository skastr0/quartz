import type { PackageInfo } from "../../discovery"
import type { AssignabilityCheckResult } from "../../transform-search/assignability-filter"
import type { NativeCommandContext } from "../context"
import {
  buildSnippetImportPlan,
  collectSnippetExportSources,
  loadSnippetProject,
  resolveSnippetDirectory,
} from "../snippet-helpers"
import type { NativeCallableEntry, NativeSyntheticCheckResult, WrapperKind } from "./types"

const argsFor = (matchedParam: number, minArity: number): string => {
  const count = Math.max(minArity, matchedParam + 1)
  return Array.from({ length: count }, (_, index) => index === matchedParam ? "__input" : "null as any").join(", ")
}

const callFor = (entry: NativeCallableEntry, result: AssignabilityCheckResult): string => {
  const matchedParam = result.fromMatch?.paramIndex ?? 0
  const args = argsFor(matchedParam, entry.minArity)
  const [container, member] = entry.qualifiedName.split(".")
  if (entry.kind === "Constructor") return `new ${container}(${args})`
  if (entry.kind === "StaticMethod") return `${container}.${member}(${args})`
  if (entry.kind === "ClassMethod") return `(null as unknown as InstanceType<typeof ${container}>).${member}(${args})`
  if (entry.kind === "ObjectMethod") return `${container}.${member}(${args})`
  return `${entry.qualifiedName}(${args})`
}

const assignmentFor = (call: string, wrapper: WrapperKind): string => {
  if (wrapper === "Promise" || wrapper === "PromiseLike") {
    return `async function __quartzVerify__() { const __output: __QuartzTo__ = await ${call}; }`
  }
  if (wrapper === "Effect") {
    return [
      `declare function __unwrapEffect<A>(effect: { readonly [Symbol.iterator]: () => Generator<any, A, any> }): A;`,
      `const __output: __QuartzTo__ = __unwrapEffect(${call});`,
    ].join("\n")
  }
  return `const __output: __QuartzTo__ = ${call};`
}

export const verifyNativeCandidate = (
  ctx: NativeCommandContext,
  pkg: PackageInfo,
  entry: NativeCallableEntry,
  result: AssignabilityCheckResult,
  from: string,
  to: string,
  unwrapReturn: boolean,
): NativeSyntheticCheckResult => {
  const layoutProgram = ctx.engine.getProgram(pkg.tsconfigPath)
  const layoutProject = ctx.engine.getProject(pkg.tsconfigPath)
  const imports = buildSnippetImportPlan(
    collectSnippetExportSources(layoutProgram, layoutProject, pkg),
    resolveSnippetDirectory(layoutProgram, pkg),
    false,
  )
  const call = callFor(entry, result)
  const wrapper = unwrapReturn && result.toMatch?.unwrapped === true ? result.toMatch.wrapper : null
  const code = [
    imports.fileContent.trimEnd(),
    `type __QuartzFrom__ = ${from};`,
    `type __QuartzTo__ = ${to};`,
    `declare const __input: __QuartzFrom__;`,
    assignmentFor(call, wrapper),
  ].filter((line) => line.length > 0).join("\n")
  const snippet = loadSnippetProject(ctx, pkg, code)
  try {
    const diagnostics = [
      ...snippet.program.getSyntacticDiagnostics(snippet.snippetPath),
      ...snippet.program.getSemanticDiagnostics(snippet.snippetPath),
    ].map((diagnostic) => ({ message: diagnostic.text ?? `TS${diagnostic.code}`, code: diagnostic.code }))
    const verified = diagnostics.length === 0
    return {
      candidateId: entry.id,
      verified,
      verification: {
        status: verified ? "verified" : "unverified",
        method: "synthetic",
        reason: verified ? "synthetic_check_passed" : "synthetic_check_failed",
        ...(verified ? {} : { diagnostics }),
      },
      diagnostics,
      syntheticCode: code,
    }
  } finally {
    snippet.dispose()
  }
}
