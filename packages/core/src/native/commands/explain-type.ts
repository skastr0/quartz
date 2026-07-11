import { Effect } from "effect"
import type { TypeAnalyzer } from "../../analyzer"
import type { TypeExplanationResult, TypeExpressionComponent } from "../../project-types"
import type { NativeCommandContext } from "../context"
import { evalType } from "./eval-type"

export const explainType =
  (ctx: NativeCommandContext): TypeAnalyzer["explainType"] =>
  (expression, packageName) =>
    Effect.gen(function* () {
      const evaluate = evalType(ctx)
      const finalResult = yield* evaluate(expression, packageName).pipe(
        Effect.map((result) => ("error" in result ? `Error: ${result.error}` : result.expanded)),
      )
      const components = parseTypeExpression(expression)
      const steps: TypeExplanationResult["steps"] = []

      for (const component of components) {
        const componentExpression = componentExpressionFor(component)
        const result = yield* evaluate(componentExpression, packageName).pipe(
          Effect.map((value) => ("error" in value ? `Error: ${value.error}` : value.expanded)),
        )
        steps.push({
          step: steps.length + 1,
          description: describeComponent(component),
          expression: componentExpression,
          result,
        })
      }

      if (steps.length === 0) {
        steps.push({ step: 1, description: `Expand ${expression}`, expression, result: finalResult })
      } else if (steps[steps.length - 1]?.result !== finalResult) {
        steps.push({ step: steps.length + 1, description: "Final result", expression, result: finalResult })
      }

      return { expression, steps, final: finalResult }
    })

const componentExpressionFor = (component: TypeExpressionComponent): string => {
  switch (component.type) {
    case "keyof":
      return `keyof ${component.target}`
    case "utility":
      return `${component.utility}<${component.args.join(", ")}>`
    case "base":
      return component.name
  }
}

const describeComponent = (component: TypeExpressionComponent): string => {
  if (component.type === "keyof") return `Resolve ${componentExpressionFor(component)}`
  if (component.type === "base") return `Resolve ${component.name}`

  const [target, keys] = component.args
  switch (component.utility) {
    case "Pick":
      return `Pick properties ${keys} from ${target}`
    case "Omit":
      return `Omit properties ${keys} from ${target}`
    case "Partial":
      return `Make all properties of ${target} optional`
    case "Required":
      return `Make all properties of ${target} required`
    case "Readonly":
      return `Make all properties of ${target} readonly`
    case "ReturnType":
      return `Get return type of ${target}`
    case "Parameters":
      return `Get parameter types of ${target}`
    default:
      return `Apply ${component.utility}`
  }
}

const parseTypeExpression = (expression: string): TypeExpressionComponent[] => {
  const trimmed = expression.trim()
  if (trimmed.startsWith("keyof ")) return [{ type: "keyof", target: trimmed.slice(6).trim() }]

  const utilityMatch = trimmed.match(/^(\w+)<(.+)>$/)
  if (utilityMatch !== null) {
    const args = parseTypeArguments(utilityMatch[2]!)
    return [
      ...args.flatMap((argument) => parseTypeExpression(argument)),
      { type: "utility", utility: utilityMatch[1]!, args },
    ]
  }

  return /^[\w.]+$/.test(trimmed) ? [{ type: "base", name: trimmed }] : []
}

const parseTypeArguments = (value: string): string[] => {
  const args: string[] = []
  let current = ""
  let depth = 0
  for (const character of value) {
    if (character === "<") depth++
    else if (character === ">") depth--
    if (character === "," && depth === 0) {
      args.push(current.trim())
      current = ""
    } else {
      current += character
    }
  }
  if (current.trim()) args.push(current.trim())
  return args
}
