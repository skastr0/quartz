import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { ErrorExplanationResult } from "../../project-types"
import type { NativeCommandContext } from "../context"
import { checkCompatibility } from "./check-compatibility"
import { expandType } from "./expand-type"
import { getDiagnostics } from "./get-diagnostics"

export const explainError =
  (ctx: NativeCommandContext): TypeAnalyzer["explainError"] =>
  (options) =>
    Effect.gen(function* () {
      let errorCode = options.code
      let errorMessage = options.message ?? ""

      if (options.file !== undefined && options.line !== undefined && errorMessage.length === 0) {
        const diagnostics = yield* getDiagnostics(ctx)(options.packageName)
        if (Array.isArray(diagnostics)) {
          const matching = diagnostics.find(
            (diagnostic) => diagnostic.file?.endsWith(options.file!) && diagnostic.line === options.line,
          )
          if (matching !== undefined) {
            errorCode = matching.code
            errorMessage = matching.message
          }
        }
      }

      if (errorMessage.length === 0) return null

      const extracted = extractTypesFromError(errorMessage)
      const result: ErrorExplanationResult = {
        error: { code: errorCode ?? 0, message: errorMessage },
        explanation: "",
        issues: [],
        suggestions: [],
      }

      switch (errorCode) {
        case 2322:
        case 2345:
          yield* explainAssignability(result, extracted, ctx, options.packageName)
          break
        case 2339:
          yield* explainMissingMember(result, extracted, ctx, options.packageName)
          break
        case 2741:
          yield* explainMissingRequiredProperty(result, extracted, ctx, options.packageName)
          break
        case 2551:
          yield* explainSuggestedProperty(result, extracted, ctx, options.packageName)
          break
        default:
          yield* explainGeneric(result, extracted, errorMessage, ctx, options.packageName)
          break
      }

      return result
    })

type ExtractedError = { readonly types: string[]; readonly properties: string[] }

const explainAssignability = (
  result: ErrorExplanationResult,
  extracted: ExtractedError,
  ctx: NativeCommandContext,
  packageName?: string,
) =>
  Effect.gen(function* () {
    if (extracted.types.length < 2) return
    const [from, to] = extracted.types as [string, string]
    yield* expandResultTypes(result, [from, to], ctx, packageName)

    const compatibility = yield* checkCompatibility(ctx)(from, to, packageName)
    if (!compatibility.compatible) {
      result.issues.push(...(compatibility.issues ?? [{ kind: "other", message: compatibility.reason ?? "Types are not compatible" }]))
    }
    result.explanation = `You're trying to use a value of type '${from}' where a value of type '${to}' is expected. These types are not compatible.`
    addAssignabilitySuggestions(result, to)
  })

const explainMissingMember = (
  result: ErrorExplanationResult,
  extracted: ExtractedError,
  ctx: NativeCommandContext,
  packageName?: string,
) =>
  Effect.gen(function* () {
    const target = extracted.types[0]
    const property = extracted.properties[0]
    if (target === undefined || property === undefined) return
    yield* expandTargetType(result, target, ctx, packageName)
    result.issues.push({ kind: "missing_property", property, message: `Property '${property}' does not exist on type '${target}'` })
    result.explanation = `You're trying to access property '${property}' on type '${target}', but this property doesn't exist.`
    result.suggestions.push(`Add property '${property}' to the ${target} type`)
    result.suggestions.push("Check for typos in the property name")
    result.suggestions.push("Use optional chaining (?.) if the property might not exist")
  })

const explainMissingRequiredProperty = (
  result: ErrorExplanationResult,
  extracted: ExtractedError,
  ctx: NativeCommandContext,
  packageName?: string,
) =>
  Effect.gen(function* () {
    const property = extracted.properties[0]
    if (property === undefined || extracted.types.length < 2) return
    const [from, to] = extracted.types as [string, string]
    yield* expandResultTypes(result, [from, to], ctx, packageName)
    result.issues.push({ kind: "missing_property", property, message: `Property '${property}' is required but missing` })
    result.explanation = `Type '${from}' is missing required property '${property}' that '${to}' expects.`
    result.suggestions.push(`Add '${property}' to your object`)
    result.suggestions.push(`Make '${property}' optional in ${to} using '${property}?:'`)
  })

const explainSuggestedProperty = (
  result: ErrorExplanationResult,
  extracted: ExtractedError,
  ctx: NativeCommandContext,
  packageName?: string,
) =>
  Effect.gen(function* () {
    const [wrong, suggested] = extracted.properties as [string | undefined, string | undefined]
    const target = extracted.types[0]
    if (wrong === undefined || suggested === undefined || target === undefined) return
    yield* expandTargetType(result, target, ctx, packageName)
    result.issues.push({ kind: "missing_property", property: wrong, message: `Property '${wrong}' doesn't exist, did you mean '${suggested}'?` })
    result.explanation = `You typed '${wrong}' but this property doesn't exist on '${target}'. TypeScript suggests '${suggested}' instead.`
    result.suggestions.push(`Replace '${wrong}' with '${suggested}'`)
  })

const explainGeneric = (
  result: ErrorExplanationResult,
  extracted: ExtractedError,
  errorMessage: string,
  ctx: NativeCommandContext,
  packageName?: string,
) =>
  Effect.gen(function* () {
    if (extracted.types.length > 0) yield* expandResultTypes(result, extracted.types.slice(0, 2), ctx, packageName)
    result.explanation = errorMessage
    result.issues.push({ kind: "other", message: errorMessage })
    result.suggestions.push("Review the types involved using type_expand")
    result.suggestions.push("Check type compatibility using type_compatible")
  })

const expandResultTypes = (
  result: ErrorExplanationResult,
  typeNames: readonly string[],
  ctx: NativeCommandContext,
  packageName?: string,
) =>
  Effect.gen(function* () {
    for (let index = 0; index < Math.min(typeNames.length, 2); index++) {
      const name = typeNames[index]
      if (name === undefined || isInlineObjectType(name)) continue
      const expanded = yield* expandType(ctx)(name, packageName).pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (expanded === null) continue
      result.types ??= {}
      if (index === 0) result.types.from = { name, expanded: expanded.expanded }
      else result.types.to = { name, expanded: expanded.expanded }
    }
  })

const expandTargetType = (
  result: ErrorExplanationResult,
  typeName: string,
  ctx: NativeCommandContext,
  packageName?: string,
) =>
  Effect.gen(function* () {
    const expanded = yield* expandType(ctx)(typeName, packageName).pipe(Effect.catchAll(() => Effect.succeed(null)))
    if (expanded !== null) {
      result.types ??= {}
      result.types.target = { name: typeName, expanded: expanded.expanded }
    }
  })

const addAssignabilitySuggestions = (result: ErrorExplanationResult, toType: string): void => {
  const missingProperties = result.issues.filter((issue) => issue.kind === "missing_property")
  if (missingProperties.length > 0) {
    const propertyNames = missingProperties.map((issue) => issue.property).filter(Boolean).join(", ")
    result.suggestions.push(`Add missing properties: ${propertyNames}`)
    result.suggestions.push(`Use Partial<${toType}> if properties should be optional`)
    result.suggestions.push(`Use Omit<${toType}, '${propertyNames}'> to create a type without these properties`)
  }
  for (const mismatch of result.issues.filter((issue) => issue.kind === "type_mismatch")) {
    result.suggestions.push(`Fix property '${mismatch.property}': change from '${mismatch.actualType}' to '${mismatch.expectedType}'`)
  }
}

const extractTypesFromError = (message: string): ExtractedError => {
  const types: string[] = []
  const properties: string[] = []
  const typePatterns = [
    /Type '([^']+)' is not assignable to type '([^']+)'/,
    /Argument of type '([^']+)' is not assignable to parameter of type '([^']+)'/,
    /Type ([\w$]+(?:\.[\w$]+)*) is not assignable to type ([\w$]+(?:\.[\w$]+)*)/,
    /Argument of type ([\w$]+(?:\.[\w$]+)*) is not assignable to parameter of type ([\w$]+(?:\.[\w$]+)*)/,
    /Property '[^']+' does not exist on type '([^']+)'/,
    /Property '[^']+' is missing in type '([^']+)' but required in type '([^']+)'/,
    /Property ([\w$]+) is missing in type ([\w$]+(?:\.[\w$]+)*) but required in type ([\w$]+(?:\.[\w$]+)*)/,
    /Cannot find name '([^']+)'/,
    /Type '([^']+)' has no properties in common with type '([^']+)'/,
    /Type ([\w$]+(?:\.[\w$]+)*) has no properties in common with type ([\w$]+(?:\.[\w$]+)*)/,
  ]
  const propertyPatterns = [
    /Property '([^']+)' does not exist/,
    /Property '([^']+)' is missing/,
    /Property ([\w$]+) does not exist/,
    /Property ([\w$]+) is missing/,
    /Did you mean '([^']+)'\?/,
  ]

  for (const pattern of typePatterns) {
    const match = message.match(pattern)
    if (match === null) continue
    for (const value of match.slice(1)) if (value !== undefined && !isInlineObjectType(value)) types.push(value)
    break
  }
  for (const pattern of propertyPatterns) {
    const match = message.match(pattern)
    if (match?.[1] !== undefined) properties.push(match[1])
  }
  return { types, properties }
}

const isInlineObjectType = (value: string): boolean => value.startsWith("{") && value.endsWith("}")
