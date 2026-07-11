import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { CompatibilityResult, ErrorExplanationIssue } from "../../project-types"
import { discoverPackages } from "../../discovery"
import { QuartzError } from "../../errors"
import { SignatureKind, SymbolFlags, type Type } from "typescript/unstable/sync"
import type { Node } from "typescript/unstable/ast"
import type { NativeCommandContext } from "../context"
import { findNativeSymbol, getWorkspaceSourceFiles, resolvePackage } from "../symbol-resolution"
import { typeForNode } from "./get-type-info"

/**
 * Native `checkCompatibility` — not yet implemented. Its owning builder replaces this
 * body; the delegator in `native/index.ts` stays frozen. Until then it returns
 * the engine-not-supported error so callers get a clean, actionable failure.
 */
export const checkCompatibility =
  (ctx: NativeCommandContext): TypeAnalyzer["checkCompatibility"] =>
  (from, to, packageName) =>
    Effect.gen(function* () {
      const packages = yield* discoverPackages(ctx.rootDirectory)
      return yield* Effect.try({
        try: () => {
          const packageInfo = resolvePackage(packages, packageName)
          const project = ctx.engine.getProject(packageInfo.tsconfigPath)
          const sourceFiles = getWorkspaceSourceFiles(project.program, packageInfo)
          const fromFound = findNativeSymbol(from, project, packageInfo, ctx.rootDirectory, sourceFiles)
          const toFound = findNativeSymbol(to, project, packageInfo, ctx.rootDirectory, sourceFiles)
          if (fromFound === null) return missingSymbol(from, from, to)
          if (toFound === null) return missingSymbol(to, from, to)

          const checker = project.checker
          const fromType = typeForNode(fromFound.node, fromFound.symbol, checker)
          const toType = typeForNode(toFound.node, toFound.symbol, checker)
          const fromText = checker.typeToString(fromType, fromFound.node)
          const toText = checker.typeToString(toType, toFound.node)
          if (checker.isTypeAssignableTo(fromType, toType)) return { compatible: true, from: fromText, to: toText }

          const issues: ErrorExplanationIssue[] = []
          const reasons: string[] = []
          const fromProperties = checker.getPropertiesOfType(fromType)
          const fromNames = new Set(fromProperties.map((property) => property.name))
          for (const property of checker.getPropertiesOfType(toType)) {
            if ((property.flags & SymbolFlags.Optional) === SymbolFlags.None && !fromNames.has(property.name)) {
              const expectedType = propertyTypeText(property.name, toType, toFound.node, checker)
              const message = `Property '${property.name}' is missing in type '${fromText}' but required in type '${toText}' (expected: ${expectedType})`
              reasons.push(message)
              issues.push({ kind: "missing_property", property: property.name, expectedType, message })
            }
          }
          for (const property of fromProperties) {
            const targetProperty = checker.getPropertyOfType(toType, property.name)
            if (targetProperty === undefined) continue
            const sourceType = checker.getTypeOfSymbolAtLocation(property, fromFound.node)
            const targetType = checker.getTypeOfSymbolAtLocation(targetProperty, toFound.node)
            if (checker.isTypeAssignableTo(sourceType, targetType)) continue
            const actualType = checker.typeToString(sourceType, fromFound.node)
            const expectedType = checker.typeToString(targetType, toFound.node)
            const message = `Property '${property.name}' has incompatible types: '${actualType}' is not assignable to '${expectedType}'`
            reasons.push(message)
            issues.push({ kind: "type_mismatch", property: property.name, actualType, expectedType, message })
          }
          if (
            checker.getSignaturesOfType(toType, SignatureKind.Call).length > 0 &&
            checker.getSignaturesOfType(fromType, SignatureKind.Call).length === 0
          ) {
            const message = `Type '${fromText}' is not callable but '${toText}' requires call signatures`
            reasons.push(message)
            issues.push({ kind: "not_callable", message })
          }
          if (reasons.length === 0) {
            const message = `Type '${fromText}' is not assignable to type '${toText}'`
            reasons.push(message)
            issues.push({ kind: "other", message })
          }
          return { compatible: false, from: fromText, to: toText, reason: reasons.join("; "), issues }
        },
        catch: (cause) => new QuartzError({ message: "Could not check type compatibility", cause }),
      })
    })

const missingSymbol = (missing: string, from: string, to: string): CompatibilityResult => {
  const message = `Symbol "${missing}" not found`
  return { compatible: false, from, to, reason: message, issues: [{ kind: "other", message }] }
}

const propertyTypeText = (
  name: string,
  type: Type,
  location: Node,
  checker: ReturnType<NativeCommandContext["engine"]["getProject"]>["checker"],
): string => {
  const property = checker.getPropertyOfType(type, name)
  return property === undefined ? "unknown" : checker.typeToString(checker.getTypeOfSymbolAtLocation(property, location), location)
}
