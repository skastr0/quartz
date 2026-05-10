import { Node, type Project, type Symbol, TypeFormatFlags } from "ts-morph";
import { Effect } from "effect";
import type { PackageInfo } from "./discovery";
import type {
  CompatibilityResult,
  ErrorExplanationResult,
  TypeExplanationResult,
  TypeExplanationStep,
  TypeExpressionComponent,
} from "./project-types";

export interface ErrorExplanationOptions {
  readonly code?: number;
  readonly message?: string;
  readonly file?: string;
  readonly line?: number;
  readonly packageName?: string;
}

export interface DiagnosticRecord {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly code: number;
}

export interface TypeExplanationContext {
  readonly getPackageDiagnostics: (packageName?: string) => Effect.Effect<readonly DiagnosticRecord[], unknown>;
  readonly checkCompatibility: (
    from: string,
    to: string,
    packageName?: string,
  ) => Effect.Effect<CompatibilityResult, unknown>;
  readonly findSymbol: (
    symbolName: string,
    project: Project,
    pkg: PackageInfo,
  ) => Effect.Effect<{ node: Node; symbol: Symbol } | null, unknown>;
  readonly evalType: (
    expression: string,
    packageName?: string,
  ) => Effect.Effect<{ result: string; expanded: string } | { error: string }, unknown>;
}

export class TypeExplainer {
  constructor(private readonly context: TypeExplanationContext) {}

  explainError(
    options: ErrorExplanationOptions,
    project: Project,
    pkg: PackageInfo,
  ): Effect.Effect<ErrorExplanationResult | null, unknown> {
    return Effect.gen(this, function* () {
      let errorCode = options.code;
      let errorMessage = options.message ?? "";

      if (options.file !== undefined && options.line !== undefined && !errorMessage) {
        const diagnostics = yield* this.context.getPackageDiagnostics(options.packageName);
        const matchingDiagnostic = diagnostics.find(
          (diagnostic) => diagnostic.file.endsWith(options.file!) && diagnostic.line === options.line,
        );
        if (matchingDiagnostic !== undefined) {
          errorCode = matchingDiagnostic.code;
          errorMessage = matchingDiagnostic.message;
        }
      }

      if (!errorMessage) return null;

      const extracted = extractTypesFromError(errorMessage);
      const result: ErrorExplanationResult = {
        error: { code: errorCode ?? 0, message: errorMessage },
        explanation: "",
        issues: [],
        suggestions: [],
      };

      switch (errorCode) {
        case 2322:
        case 2345:
          yield* this.explainAssignabilityError(result, extracted, project, pkg, options.packageName);
          break;
        case 2339:
          yield* this.explainMissingMemberError(result, extracted, project, pkg);
          break;
        case 2741:
          yield* this.explainMissingRequiredPropertyError(result, extracted, project, pkg);
          break;
        case 2551:
          yield* this.explainSuggestedPropertyError(result, extracted, project, pkg);
          break;
        default:
          yield* this.explainGenericError(result, extracted, errorMessage, project, pkg);
          break;
      }

      return result;
    });
  }

  explainType(expression: string, packageName?: string): Effect.Effect<TypeExplanationResult, unknown> {
    return Effect.gen(this, function* () {
      const finalResult = yield* this.evaluateTypeExplanationFinal(expression, packageName);
      const components = parseTypeExpression(expression);
      const steps = yield* this.buildTypeExplanationSteps(expression, components, finalResult, packageName);

      return { expression, steps, final: finalResult };
    });
  }

  private explainAssignabilityError(
    result: ErrorExplanationResult,
    extracted: { types: string[]; properties: string[] },
    project: Project,
    pkg: PackageInfo,
    packageName?: string,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      if (extracted.types.length < 2) return;

      const [fromType, toType] = extracted.types;
      yield* this.expandResultTypes(result, [fromType!, toType!], project, pkg);

      const compatibility = yield* this.context.checkCompatibility(fromType!, toType!, packageName);
      if (!compatibility.compatible) {
        result.issues.push(
          ...(compatibility.issues ?? [
            { kind: "other", message: compatibility.reason ?? "Types are not compatible" },
          ]),
        );
      }

      result.explanation = `You're trying to use a value of type '${fromType}' where a value of type '${toType}' is expected. These types are not compatible.`;
      addAssignabilitySuggestions(result, toType!);
    });
  }

  private explainMissingMemberError(
    result: ErrorExplanationResult,
    extracted: { types: string[]; properties: string[] },
    project: Project,
    pkg: PackageInfo,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      if (extracted.properties.length === 0 || extracted.types.length === 0) return;

      const [targetType] = extracted.types;
      const [missingProperty] = extracted.properties;
      yield* this.expandTargetType(result, targetType!, project, pkg);

      result.issues.push({
        kind: "missing_property",
        ...(missingProperty === undefined ? {} : { property: missingProperty }),
        message: `Property '${missingProperty}' does not exist on type '${targetType}'`,
      });
      result.explanation = `You're trying to access property '${missingProperty}' on type '${targetType}', but this property doesn't exist.`;
      result.suggestions.push(`Add property '${missingProperty}' to the ${targetType} type`);
      result.suggestions.push("Check for typos in the property name");
      result.suggestions.push("Use optional chaining (?.) if the property might not exist");
    });
  }

  private explainMissingRequiredPropertyError(
    result: ErrorExplanationResult,
    extracted: { types: string[]; properties: string[] },
    project: Project,
    pkg: PackageInfo,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      if (extracted.properties.length === 0 || extracted.types.length < 2) return;

      const [fromType, toType] = extracted.types;
      const [missingProperty] = extracted.properties;
      yield* this.expandResultTypes(result, [fromType!, toType!], project, pkg);

      result.issues.push({
        kind: "missing_property",
        ...(missingProperty === undefined ? {} : { property: missingProperty }),
        message: `Property '${missingProperty}' is required but missing`,
      });
      result.explanation = `Type '${fromType}' is missing required property '${missingProperty}' that '${toType}' expects.`;
      result.suggestions.push(`Add property '${missingProperty}' to your object`);
      result.suggestions.push(`Make '${missingProperty}' optional in ${toType} using '${missingProperty}?:'`);
    });
  }

  private explainSuggestedPropertyError(
    result: ErrorExplanationResult,
    extracted: { types: string[]; properties: string[] },
    project: Project,
    pkg: PackageInfo,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      if (extracted.properties.length < 2 || extracted.types.length === 0) return;

      const [targetType] = extracted.types;
      const [wrongProperty, suggestedProperty] = extracted.properties;
      yield* this.expandTargetType(result, targetType!, project, pkg);

      result.issues.push({
        kind: "missing_property",
        ...(wrongProperty === undefined ? {} : { property: wrongProperty }),
        message: `Property '${wrongProperty}' doesn't exist, did you mean '${suggestedProperty}'?`,
      });
      result.explanation = `You typed '${wrongProperty}' but this property doesn't exist on '${targetType}'. TypeScript suggests '${suggestedProperty}' instead.`;
      result.suggestions.push(`Replace '${wrongProperty}' with '${suggestedProperty}'`);
    });
  }

  private explainGenericError(
    result: ErrorExplanationResult,
    extracted: { types: string[]; properties: string[] },
    errorMessage: string,
    project: Project,
    pkg: PackageInfo,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      if (extracted.types.length > 0) {
        yield* this.expandResultTypes(result, extracted.types.slice(0, 2), project, pkg);
      }
      result.explanation = errorMessage;
      result.issues.push({ kind: "other", message: errorMessage });
      result.suggestions.push("Review the types involved using type_expand");
      result.suggestions.push("Check type compatibility using type_compatible");
    });
  }

  private expandResultTypes(
    result: ErrorExplanationResult,
    typeNames: readonly string[],
    project: Project,
    pkg: PackageInfo,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      for (let index = 0; index < Math.min(typeNames.length, 2); index++) {
        const typeName = typeNames[index]!;
        const expanded = yield* this.safeExpandType(typeName, project, pkg);
        if (expanded === null) continue;
        result.types ??= {};
        if (index === 0) {
          result.types.from = { name: typeName, expanded };
        } else {
          result.types.to = { name: typeName, expanded };
        }
      }
    });
  }

  private expandTargetType(
    result: ErrorExplanationResult,
    typeName: string,
    project: Project,
    pkg: PackageInfo,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      const expanded = yield* this.safeExpandType(typeName, project, pkg);
      if (expanded !== null) {
        result.types ??= {};
        result.types.target = { name: typeName, expanded };
      }
    });
  }

  private safeExpandType(typeName: string, project: Project, pkg: PackageInfo): Effect.Effect<string | null, unknown> {
    return Effect.gen(this, function* () {
      const found = yield* this.context.findSymbol(typeName, project, pkg);
      if (found === null) return null;

      const { node } = found;
      const type = node.getType();
      const checker = project.getTypeChecker();

      const expandFlags =
        TypeFormatFlags.NoTruncation |
        TypeFormatFlags.WriteArrayAsGenericType |
        TypeFormatFlags.UseStructuralFallback |
        TypeFormatFlags.WriteTypeArgumentsOfSignature |
        TypeFormatFlags.InTypeAlias;

      const expanded = checker.compilerObject.typeToString(
        type.compilerType,
        node.compilerNode,
        expandFlags as unknown as number,
      );

      if (expanded === typeName || !expanded.startsWith("{")) {
        const properties = type.getProperties();
        if (properties.length > 0 && properties.length <= 20) {
          const propStrings = properties.map((property) => {
            const declaration = property.getDeclarations()[0];
            const propertyType = declaration ? declaration.getType() : property.getTypeAtLocation(node);
            const optional = property.isOptional() ? "?" : "";
            return `${property.getName()}${optional}: ${propertyType.getText(declaration ?? node)}`;
          });
          return `{ ${propStrings.join("; ")} }`;
        }
      }

      return expanded;
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
  }

  private evaluateTypeExplanationFinal(expression: string, packageName?: string): Effect.Effect<string, unknown> {
    return this.context.evalType(expression, packageName).pipe(
      Effect.map((evalResult) => ("error" in evalResult ? `Error: ${evalResult.error}` : evalResult.expanded)),
    );
  }

  private buildTypeExplanationSteps(
    expression: string,
    components: readonly TypeExpressionComponent[],
    finalResult: string,
    packageName?: string,
  ): Effect.Effect<TypeExplanationStep[], unknown> {
    return Effect.gen(this, function* () {
      if (components.length === 0) {
        return [{ step: 1, description: `Expand ${expression}`, expression, result: finalResult }];
      }

      const steps: TypeExplanationStep[] = [];
      for (const component of components) {
        steps.push(yield* this.explainTypeComponent(component, steps.length + 1, packageName));
      }

      if (steps.length > 0 && steps[steps.length - 1]!.result !== finalResult) {
        steps.push({ step: steps.length + 1, description: "Final result", expression, result: finalResult });
      }

      return steps.length === 0
        ? [{ step: 1, description: "Evaluate expression", expression, result: finalResult }]
        : steps;
    });
  }

  private explainTypeComponent(
    component: TypeExpressionComponent,
    step: number,
    packageName?: string,
  ): Effect.Effect<TypeExplanationStep, unknown> {
    return Effect.gen(this, function* () {
    if (component.type === "keyof") {
      const expression = `keyof ${component.target}`;
      return {
        step,
        description: `Resolve ${expression}`,
        expression,
        result: yield* this.evaluateTypeExplanationFinal(expression, packageName),
      };
    }

    if (component.type === "utility") {
      const expression = `${component.utility}<${component.args.join(", ")}>`;
      return {
        step,
        description: describeUtilityType(component.utility, component.args),
        expression,
        result: yield* this.evaluateTypeExplanationFinal(expression, packageName),
      };
    }

    return {
      step,
      description: `Resolve ${component.name}`,
      expression: component.name,
      result: yield* this.evaluateTypeExplanationFinal(component.name, packageName),
    };
    });
  }
}

const addAssignabilitySuggestions = (result: ErrorExplanationResult, toType: string): void => {
  const missingProperties = result.issues.filter((issue) => issue.kind === "missing_property");
  if (missingProperties.length > 0) {
    const propertyNames = missingProperties.map((issue) => issue.property).filter(Boolean).join(", ");
    result.suggestions.push(`Add missing properties: ${propertyNames}`);
    result.suggestions.push(`Use Partial<${toType}> if properties should be optional`);
    result.suggestions.push(`Use Omit<${toType}, '${propertyNames}'> to create a type without these properties`);
  }

  for (const mismatch of result.issues.filter((issue) => issue.kind === "type_mismatch")) {
    result.suggestions.push(
      `Fix property '${mismatch.property}': change from '${mismatch.actualType}' to '${mismatch.expectedType}'`,
    );
  }
};

const extractTypesFromError = (message: string): { types: string[]; properties: string[] } => {
  const types: string[] = [];
  const properties: string[] = [];
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
  ];
  const propertyPatterns = [
    /Property '([^']+)' does not exist/,
    /Property '([^']+)' is missing/,
    /Property ([\w$]+) does not exist/,
    /Property ([\w$]+) is missing/,
    /Did you mean '([^']+)'\?/,
  ];

  for (const pattern of typePatterns) {
    const match = message.match(pattern);
    if (match === null) continue;
    for (let index = 1; index < match.length; index++) {
      const typeName = match[index];
      if (typeName !== undefined && !isInlineObjectType(typeName)) types.push(typeName);
    }
    break;
  }

  for (const pattern of propertyPatterns) {
    const match = message.match(pattern);
    if (match?.[1] !== undefined) properties.push(match[1]);
  }

  return { types, properties };
};

const isInlineObjectType = (typeName: string): boolean => typeName.startsWith("{") && typeName.endsWith("}");

const describeUtilityType = (utility: string, args: readonly string[]): string => {
  const [target, keys] = args;
  switch (utility) {
    case "Pick":
      return `Pick properties ${keys} from ${target}`;
    case "Omit":
      return `Omit properties ${keys} from ${target}`;
    case "Partial":
      return `Make all properties of ${target} optional`;
    case "Required":
      return `Make all properties of ${target} required`;
    case "Readonly":
      return `Make all properties of ${target} readonly`;
    case "ReturnType":
      return `Get return type of ${target}`;
    case "Parameters":
      return `Get parameter types of ${target}`;
    default:
      return `Apply ${utility}`;
  }
};

const parseTypeExpression = (expression: string): TypeExpressionComponent[] => {
  const components: TypeExpressionComponent[] = [];
  const trimmed = expression.trim();

  if (trimmed.startsWith("keyof ")) {
    components.push({ type: "keyof", target: trimmed.slice(6).trim() });
    return components;
  }

  const utilityMatch = trimmed.match(/^(\w+)<(.+)>$/);
  if (utilityMatch !== null) {
    const utilityName = utilityMatch[1]!;
    const args = parseTypeArgs(utilityMatch[2]!);

    for (const arg of args) {
      components.push(...parseTypeExpression(arg));
    }

    components.push({ type: "utility", utility: utilityName, args });
    return components;
  }

  if (/^[\w.]+$/.test(trimmed)) {
    components.push({ type: "base", name: trimmed });
  }

  return components;
};

const parseTypeArgs = (argsString: string): string[] => {
  const args: string[] = [];
  let current = "";
  let depth = 0;

  for (const char of argsString) {
    if (char === "<") {
      depth++;
      current += char;
    } else if (char === ">") {
      depth--;
      current += char;
    } else if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) args.push(current.trim());
  return args;
};
