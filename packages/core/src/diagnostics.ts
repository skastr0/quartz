/**
 * Diagnostic Parser Module
 *
 * Extracts type names from TypeScript error messages and generates
 * targeted type-level tool call suggestions.
 *
 * TypeScript error messages are highly structured - we can programmatically
 * extract type names without guessing.
 */

// Common TypeScript error codes we can extract types from
export const ASSIGNABILITY_ERROR_CODES = new Set([
  2322, // Type 'X' is not assignable to type 'Y'
  2345, // Argument of type 'X' is not assignable to parameter of type 'Y'
  2741, // Property 'X' is missing in type 'Y' but required in type 'Z'
  2352, // Conversion of type 'X' to type 'Y' may be a mistake
  2416, // Property 'X' in type 'Y' is not assignable to the same property in base type 'Z'
  2559, // Type 'X' has no properties in common with type 'Y'
]);

export const PROPERTY_ERROR_CODES = new Set([
  2339, // Property 'X' does not exist on type 'Y'
  2551, // Property 'X' does not exist on type 'Y'. Did you mean 'Z'?
  2741, // Property 'X' is missing in type 'Y' but required in type 'Z'
]);

export const TYPE_NOT_FOUND_CODES = new Set([
  2304, // Cannot find name 'X'
  2552, // Cannot find name 'X'. Did you mean 'Y'?
]);

// Primitives and built-ins we should skip
const PRIMITIVES_AND_BUILTINS = new Set([
  "string",
  "number",
  "boolean",
  "null",
  "undefined",
  "void",
  "never",
  "unknown",
  "any",
  "object",
  "symbol",
  "bigint",
  // Common built-ins
  "Array",
  "Promise",
  "Map",
  "Set",
  "Date",
  "Error",
  "RegExp",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Function",
  "Record",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "NonNullable",
  "Parameters",
  "ReturnType",
  "InstanceType",
  "ThisType",
]);

export interface ExtractedTypeInfo {
  /** Type names extracted from the error message */
  types: string[];
  /** Property names mentioned in the error (for property-related errors) */
  properties: string[];
  /** The original error code */
  code: number | undefined;
  /** Classification of the error */
  category: "assignability" | "property" | "not_found" | "other";
}

export interface SuggestedToolCall {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface DiagnosticAnalysis {
  file: string;
  line: number;
  message: string;
  types: string[];
  suggestedTools: SuggestedToolCall[];
}

// Regex patterns to extract types from TypeScript error messages
// These patterns are based on TypeScript's actual error message formats
// Note: More specific patterns (with "Did you mean") must come BEFORE generic ones
const TYPE_EXTRACTION_PATTERNS: Array<{
  pattern: RegExp;
  extract: (match: RegExpMatchArray) => { types: string[]; properties: string[] };
}> = [
  // "Type 'X' is not assignable to type 'Y'"
  {
    pattern: /Type '([^']+)' is not assignable to type '([^']+)'/,
    extract: (m) => ({ types: [m[1]!, m[2]!], properties: [] }),
  },
  // "Argument of type 'X' is not assignable to parameter of type 'Y'"
  {
    pattern: /Argument of type '([^']+)' is not assignable to parameter of type '([^']+)'/,
    extract: (m) => ({ types: [m[1]!, m[2]!], properties: [] }),
  },
  // "Property 'X' does not exist on type 'Y'. Did you mean 'Z'?" - MUST come before the simpler pattern
  {
    pattern: /Property '([^']+)' does not exist on type '([^']+)'\. Did you mean '([^']+)'\?/,
    extract: (m) => ({ types: [m[2]!], properties: [m[1]!, m[3]!] }),
  },
  // "Property 'X' does not exist on type 'Y'"
  {
    pattern: /Property '([^']+)' does not exist on type '([^']+)'/,
    extract: (m) => ({ types: [m[2]!], properties: [m[1]!] }),
  },
  // "Property 'X' is missing in type 'Y' but required in type 'Z'"
  {
    pattern: /Property '([^']+)' is missing in type '([^']+)' but required in type '([^']+)'/,
    extract: (m) => ({ types: [m[2]!, m[3]!], properties: [m[1]!] }),
  },
  // "Conversion of type 'X' to type 'Y' may be a mistake"
  {
    pattern: /Conversion of type '([^']+)' to type '([^']+)' may be a mistake/,
    extract: (m) => ({ types: [m[1]!, m[2]!], properties: [] }),
  },
  // "Property 'X' in type 'Y' is not assignable to the same property in base type 'Z'"
  {
    pattern:
      /Property '([^']+)' in type '([^']+)' is not assignable to the same property in base type '([^']+)'/,
    extract: (m) => ({ types: [m[2]!, m[3]!], properties: [m[1]!] }),
  },
  // "Type 'X' has no properties in common with type 'Y'"
  {
    pattern: /Type '([^']+)' has no properties in common with type '([^']+)'/,
    extract: (m) => ({ types: [m[1]!, m[2]!], properties: [] }),
  },
  // "Cannot find name 'X'. Did you mean 'Y'?" - MUST come before the simpler pattern
  {
    pattern: /Cannot find name '([^']+)'\. Did you mean '([^']+)'\?/,
    extract: (m) => ({ types: [m[1]!, m[2]!], properties: [] }),
  },
  // "Cannot find name 'X'"
  {
    pattern: /Cannot find name '([^']+)'/,
    extract: (m) => ({ types: [m[1]!], properties: [] }),
  },
  // "Type 'X' is missing the following properties from type 'Y': a, b, c"
  {
    pattern: /Type '([^']+)' is missing the following properties from type '([^']+)': ([^.]+)/,
    extract: (m) => ({
      types: [m[1]!, m[2]!],
      properties: m[3]!.split(",").map((p) => p.trim()),
    }),
  },
  // "'X' is not assignable to type 'Y'" (shorter variant)
  {
    pattern: /'([^']+)' is not assignable to type '([^']+)'/,
    extract: (m) => ({ types: [m[1]!, m[2]!], properties: [] }),
  },
];

/**
 * Check if a type name is a primitive or built-in that should be skipped
 */
export function isPrimitiveOrBuiltin(typeName: string): boolean {
  // Handle generic types like Array<T>, Promise<T>
  const baseName = typeName.split("<")[0]!.trim();
  return PRIMITIVES_AND_BUILTINS.has(baseName);
}

/**
 * Clean up extracted type names
 * - Removes array brackets
 * - Extracts base type from generics when appropriate
 * - Handles union/intersection by splitting
 */
function cleanTypeName(typeName: string): string[] {
  // Remove leading/trailing whitespace
  let cleaned = typeName.trim();

  // Handle inline object types - skip them as they're not resolvable symbols
  if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
    return [];
  }

  // Handle array types like 'User[]' -> 'User'
  cleaned = cleaned.replace(/\[\]$/, "");

  // Handle 'typeof X' -> 'X'
  if (cleaned.startsWith("typeof ")) {
    cleaned = cleaned.slice(7);
  }

  // Handle simple unions/intersections at top level
  // We only split if there are no nested generics
  if (!cleaned.includes("<")) {
    if (cleaned.includes(" | ")) {
      return cleaned.split(" | ").flatMap((t) => cleanTypeName(t));
    }
    if (cleaned.includes(" & ")) {
      return cleaned.split(" & ").flatMap((t) => cleanTypeName(t));
    }
  }

  // Handle generic types - extract both the base and type arguments
  const genericMatch = cleaned.match(/^(\w+)<(.+)>$/);
  if (genericMatch) {
    const base = genericMatch[1]!;
    const args = genericMatch[2]!;

    // If base is a utility type we don't care about, extract the args
    if (isPrimitiveOrBuiltin(base)) {
      // Simple case: single type argument
      if (!args.includes(",") && !args.includes("<")) {
        return cleanTypeName(args);
      }
      // Otherwise return as-is and let filtering handle it
    }
  }

  return cleaned ? [cleaned] : [];
}

/**
 * Extract type information from a TypeScript error message
 */
export function extractTypesFromMessage(message: string, code?: number): ExtractedTypeInfo {
  let types: string[] = [];
  let properties: string[] = [];

  // Try each pattern
  for (const { pattern, extract } of TYPE_EXTRACTION_PATTERNS) {
    const match = message.match(pattern);
    if (match) {
      const extracted = extract(match);
      types = extracted.types.flatMap(cleanTypeName);
      properties = extracted.properties;
      break;
    }
  }

  // Filter out primitives and built-ins
  types = types.filter((t) => !isPrimitiveOrBuiltin(t));

  // Determine category
  let category: ExtractedTypeInfo["category"] = "other";
  if (code !== undefined) {
    if (ASSIGNABILITY_ERROR_CODES.has(code)) {
      category = "assignability";
    } else if (PROPERTY_ERROR_CODES.has(code)) {
      category = "property";
    } else if (TYPE_NOT_FOUND_CODES.has(code)) {
      category = "not_found";
    }
  }

  return { types, properties, code, category };
}

/**
 * Generate tool call suggestions based on extracted type info.
 * Uses error codes for smarter, more targeted suggestions.
 */
export function generateToolSuggestions(info: ExtractedTypeInfo): SuggestedToolCall[] {
  const suggestions: SuggestedToolCall[] = [];
  const seenCalls = new Set<string>();

  const addSuggestion = (tool: string, args: Record<string, unknown>, reason: string) => {
    const key = `${tool}:${JSON.stringify(args)}`;
    if (!seenCalls.has(key)) {
      seenCalls.add(key);
      suggestions.push({ tool, args, reason });
    }
  };

  // Error-code specific suggestions (most targeted)
  if (info.code !== undefined) {
    switch (info.code) {
      // TS2322: Type 'X' is not assignable to type 'Y'
      // TS2345: Argument of type 'X' is not assignable to parameter of type 'Y'
      case 2322:
      case 2345:
        if (info.types.length >= 2) {
          addSuggestion(
            "type_compatible",
            { from: info.types[0], to: info.types[1] },
            `Check why ${info.types[0]} cannot be assigned to ${info.types[1]}`,
          );
          // Expand both types to see their structures
          addSuggestion(
            "type_expand",
            { symbol: info.types[0] },
            `See structure of ${info.types[0]}`,
          );
          addSuggestion(
            "type_expand",
            { symbol: info.types[1] },
            `See structure of ${info.types[1]}`,
          );
        }
        break;

      // TS2339: Property 'X' does not exist on type 'Y'
      case 2339:
        if (info.types.length > 0) {
          addSuggestion(
            "type_expand",
            { symbol: info.types[0] },
            `See what properties ${info.types[0]} actually has`,
          );
        }
        if (info.properties.length > 0) {
          addSuggestion(
            "type_search",
            { hasProperty: info.properties[0] },
            `Find types that have '${info.properties[0]}'`,
          );
        }
        break;

      // TS2741: Property 'X' is missing in type 'Y' but required in type 'Z'
      case 2741:
        if (info.types.length >= 2) {
          addSuggestion(
            "type_expand",
            { symbol: info.types[1] },
            `See required properties of ${info.types[1]}`,
          );
          addSuggestion(
            "type_compatible",
            { from: info.types[0], to: info.types[1] },
            `Check all missing properties`,
          );
        }
        break;

      // TS2551: Property 'X' does not exist on type 'Y'. Did you mean 'Z'?
      case 2551:
        if (info.types.length > 0) {
          addSuggestion(
            "type_expand",
            { symbol: info.types[0] },
            `See available properties on ${info.types[0]}`,
          );
        }
        break;

      // TS2352: Conversion of type 'X' to type 'Y' may be a mistake
      case 2352:
        if (info.types.length >= 2) {
          addSuggestion(
            "type_compatible",
            { from: info.types[0], to: info.types[1] },
            `Check if types have any overlap`,
          );
        }
        break;

      // TS2559: Type 'X' has no properties in common with type 'Y'
      case 2559:
        if (info.types.length >= 2) {
          addSuggestion(
            "type_expand",
            { symbol: info.types[0] },
            `See structure of ${info.types[0]}`,
          );
          addSuggestion(
            "type_expand",
            { symbol: info.types[1] },
            `See structure of ${info.types[1]}`,
          );
        }
        break;

      // TS2304: Cannot find name 'X'
      case 2304:
        if (info.types.length > 0) {
          addSuggestion(
            "type_search",
            { pattern: info.types[0] },
            `Search for types matching '${info.types[0]}'`,
          );
        }
        break;

      default:
        // Fall through to generic handling
        break;
    }
  }

  // If no code-specific suggestions were added, use generic category-based suggestions
  if (suggestions.length === 0) {
    // For each extracted type, suggest type_expand to see its structure
    for (const typeName of info.types) {
      addSuggestion("type_expand", { symbol: typeName }, `See full structure of ${typeName}`);
    }

    // For assignability errors with two types, suggest type_compatible
    if (info.category === "assignability" && info.types.length >= 2) {
      addSuggestion(
        "type_compatible",
        { from: info.types[0], to: info.types[1] },
        `Check why ${info.types[0]} is not assignable to ${info.types[1]}`,
      );
    }

    // For property errors, suggest type_search
    if (info.category === "property" && info.properties.length > 0) {
      addSuggestion(
        "type_search",
        { hasProperty: info.properties[0] },
        `Find types that have property '${info.properties[0]}'`,
      );
    }
  }

  return suggestions;
}

/**
 * Analyze a single LSP diagnostic and generate tool suggestions
 */
export function analyzeDiagnostic(
  diagnostic: { message: string; code?: number | string; range: { start: { line: number } } },
  filePath: string,
): DiagnosticAnalysis | null {
  // Parse the code - it might be a number or a string like "ts(2322)"
  let code: number | undefined;
  if (typeof diagnostic.code === "number") {
    code = diagnostic.code;
  } else if (typeof diagnostic.code === "string") {
    const match = diagnostic.code.match(/\d+/);
    if (match) {
      code = parseInt(match[0], 10);
    }
  }

  const extracted = extractTypesFromMessage(diagnostic.message, code);

  // Skip if we couldn't extract any types
  if (extracted.types.length === 0) {
    return null;
  }

  const suggestedTools = generateToolSuggestions(extracted);

  // Skip if no useful suggestions
  if (suggestedTools.length === 0) {
    return null;
  }

  return {
    file: filePath,
    line: diagnostic.range.start.line + 1, // Convert 0-based to 1-based
    message: diagnostic.message,
    types: extracted.types,
    suggestedTools,
  };
}

/**
 * Analyze multiple diagnostics and return consolidated suggestions
 * Limits output to avoid context bloat
 */
export function analyzeDiagnostics(
  diagnostics: Array<{
    message: string;
    code?: number | string;
    range: { start: { line: number } };
  }>,
  filePath: string,
  maxSuggestions = 5,
): DiagnosticAnalysis[] {
  const analyses: DiagnosticAnalysis[] = [];
  const seenTypes = new Set<string>();

  for (const diag of diagnostics) {
    const analysis = analyzeDiagnostic(diag, filePath);
    if (!analysis) continue;

    // Skip if we've already analyzed the same types
    const typeKey = analysis.types.sort().join(",");
    if (seenTypes.has(typeKey)) continue;
    seenTypes.add(typeKey);

    analyses.push(analysis);

    // Stop if we have enough suggestions
    const totalSuggestions = analyses.reduce((sum, a) => sum + a.suggestedTools.length, 0);
    if (totalSuggestions >= maxSuggestions) break;
  }

  return analyses;
}

/**
 * Format diagnostic analyses as a string for injection into tool output
 */
export function formatDiagnosticSuggestions(analyses: DiagnosticAnalysis[]): string {
  if (analyses.length === 0) return "";

  const lines: string[] = [
    "",
    "**Type errors detected. Use these type tools to understand the errors:**",
    "",
  ];

  // Collect unique suggestions across all analyses
  const seenSuggestions = new Set<string>();
  const suggestions: SuggestedToolCall[] = [];

  for (const analysis of analyses) {
    for (const suggestion of analysis.suggestedTools) {
      const key = `${suggestion.tool}:${JSON.stringify(suggestion.args)}`;
      if (!seenSuggestions.has(key)) {
        seenSuggestions.add(key);
        suggestions.push(suggestion);
      }
    }
  }

  // Limit suggestions to avoid bloat
  const limitedSuggestions = suggestions.slice(0, 5);

  for (const s of limitedSuggestions) {
    const argsStr = Object.entries(s.args)
      .map(([k, v]) => `${k}: "${v}"`)
      .join(", ");
    lines.push(`- \`${s.tool}({ ${argsStr} })\` - ${s.reason}`);
  }

  lines.push("");
  lines.push("Use these tools to understand the type mismatch before attempting fixes.");

  return lines.join("\n");
}

/**
 * Parse diagnostics from opencode's tool output format.
 * The format is:
 * <file_diagnostics>
 * ERROR [line:col] message
 * WARN [line:col] message
 * ...
 * </file_diagnostics>
 */
export function parseDiagnosticsFromOutput(output: string): Array<{
  message: string;
  code?: number | string;
  range: { start: { line: number } };
  severity: "error" | "warn" | "info" | "hint";
}> {
  const diagnostics: Array<{
    message: string;
    code?: number | string;
    range: { start: { line: number } };
    severity: "error" | "warn" | "info" | "hint";
  }> = [];

  // Extract the file_diagnostics block
  const match = output.match(/<file_diagnostics>([\s\S]*?)<\/file_diagnostics>/);
  if (!match) return diagnostics;

  const block = match[1]!;
  const lines = block.split("\n").filter((l) => l.trim());

  // Parse each line: "ERROR [line:col] message" or "ts(2322): message"
  const linePattern = /^(ERROR|WARN|INFO|HINT)\s+\[(\d+):(\d+)\]\s+(.+)$/;
  const tsCodePattern = /ts\((\d+)\)/;

  for (const line of lines) {
    const lineMatch = line.match(linePattern);
    if (!lineMatch) continue;

    const [, severityStr, lineNum, , message] = lineMatch;
    const severity = severityStr!.toLowerCase() as "error" | "warn" | "info" | "hint";

    // Try to extract TS error code from message
    const codeMatch = message!.match(tsCodePattern);
    const code = codeMatch ? parseInt(codeMatch[1]!, 10) : undefined;

    diagnostics.push({
      message: message!,
      ...(code === undefined ? {} : { code }),
      range: { start: { line: parseInt(lineNum!, 10) - 1 } }, // Convert to 0-based
      severity,
    });
  }

  return diagnostics;
}

/**
 * Analyze tool output and generate type tool suggestions.
 * Returns an empty string if no useful suggestions can be made.
 */
export function analyzeToolOutput(output: string, filePath: string, maxSuggestions = 5): string {
  // Only process TypeScript files
  if (!filePath.endsWith("") && !filePath.endsWith(".tsx")) {
    return "";
  }

  const diagnostics = parseDiagnosticsFromOutput(output);
  if (diagnostics.length === 0) return "";

  // Only analyze errors, not warnings
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length === 0) return "";

  const analyses = analyzeDiagnostics(errors, filePath, maxSuggestions);
  return formatDiagnosticSuggestions(analyses);
}
