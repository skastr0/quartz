/**
 * Assignability Filter
 *
 * Filter candidates using TypeScript's structural assignability checks.
 * After resolving signatures (TTS-2.1), we filter candidates by checking
 * if the query types are actually compatible with the function signatures.
 *
 * Key insight on direction:
 * - For "from" match: Query type must be assignable TO parameter type
 *   (Can I pass an A where P is expected?)
 * - For "to" match: Return type must be assignable TO query type
 *   (Can I use R where B is expected?)
 */

import { type Project, type Type } from "ts-morph";

import type { CallableId } from "./types";
import type {
  ResolvedSignature,
  ResolvedCallSignature,
  WrapperKind,
} from "./signature-resolver";

/**
 * Details about how a "from" type matched a parameter.
 */
export interface FromMatchDetails {
  matched: boolean;
  /** Which parameter matched */
  paramIndex: number;
  /** Parameter name */
  paramName: string;
  /** Query type as text */
  queryType: string;
  /** Parameter type as text */
  paramType: string;
  /** Whether types are identical (not just assignable) */
  exact: boolean;
  /** Whether match involves type erasure (any/unknown) */
  typeErasure?: boolean;
}

/**
 * Details about how a return type matched the "to" query.
 */
export interface ToMatchDetails {
  matched: boolean;
  /** Return type as text */
  returnType: string;
  /** Query type as text */
  queryType: string;
  /** Whether types are identical */
  exact: boolean;
  /** Whether we matched via wrapper unwrapping */
  unwrapped: boolean;
  /** Which wrapper was unwrapped */
  wrapper: WrapperKind;
  /** Whether match involves type erasure (any/unknown) */
  typeErasure?: boolean;
}

/**
 * Result of checking assignability for a candidate.
 */
export interface AssignabilityCheckResult {
  candidateId: CallableId;
  matches: boolean;

  /** Which signature matched (for overloaded functions) */
  matchedSignatureIndex: number | null;

  /** From match details */
  fromMatch: FromMatchDetails | null;

  /** To match details */
  toMatch: ToMatchDetails | null;

  /** Score for ranking */
  score: number;

  /** Whether this match involves type erasure (any/unknown) */
  typeErasure?: boolean;
}

/**
 * Options for assignability checking.
 */
export interface AssignabilityOptions {
  /** Query "from" type (null if not specified) */
  fromType: Type | null;

  /** Query "to" type (null if not specified) */
  toType: Type | null;

  /** Which param position to check (default: 0, or "any" for all) */
  paramPosition: number | "any";

  /** Whether to consider unwrapped return types */
  unwrapReturn: boolean;

  /**
   * Whether to include matches involving type erasure (any/unknown).
   * Default: false - excludes matches where from/to relies on any/unknown
   * as these produce false positives (TypeScript correctly says any matches
   * everything, but this is semantically meaningless for transform search).
   */
  allowTypeErasure?: boolean;
}

/**
 * Filters candidates by type assignability.
 */
export class AssignabilityFilter {
  private project: Project;

  constructor(project: Project) {
    this.project = project;
  }

  /**
   * Check if a type involves type erasure (any or unknown).
   * These types match everything in TypeScript but produce false positives.
   *
   * Detects:
   * 1. Direct any/unknown types
   * 2. Index signatures with any values: `{ [key: string]: any }`
   * 3. Number index signatures with any: `{ [key: number]: any }`
   */
  private involvesTypeErasure(type: Type): boolean {
    try {
      // Check for any/unknown flags
      if (type.isAny() || type.isUnknown()) {
        return true;
      }

      // Also check text representation for edge cases
      const text = type.getText();
      if (text === "any" || text === "unknown") {
        return true;
      }

      // Check for index signatures with any/unknown values
      // This catches "bag of options" patterns like SVGProps: { [key: string]: any }
      const stringIndexType = type.getStringIndexType();
      if (stringIndexType) {
        if (stringIndexType.isAny() || stringIndexType.isUnknown()) {
          return true;
        }
        // Also check text for edge cases
        const indexText = stringIndexType.getText();
        if (indexText === "any" || indexText === "unknown") {
          return true;
        }
      }

      const numberIndexType = type.getNumberIndexType();
      if (numberIndexType) {
        if (numberIndexType.isAny() || numberIndexType.isUnknown()) {
          return true;
        }
        const indexText = numberIndexType.getText();
        if (indexText === "any" || indexText === "unknown") {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Filter candidates by assignability.
   *
   * @param candidates - Map of candidate IDs to resolved signatures
   * @param options - Query options
   * @returns Filtered and scored results
   */
  filterByAssignability(
    candidates: Map<CallableId, ResolvedSignature>,
    options: AssignabilityOptions,
  ): AssignabilityCheckResult[] {
    const results: AssignabilityCheckResult[] = [];
    const allowTypeErasure = options.allowTypeErasure ?? false;

    for (const [id, resolved] of candidates) {
      const result = this.checkCandidate(id, resolved, options);
      if (result.matches) {
        // Filter out type-erased matches unless explicitly allowed
        if (result.typeErasure && !allowTypeErasure) {
          continue;
        }
        results.push(result);
      }
    }

    // Sort by score (higher = better match)
    results.sort((a, b) => b.score - a.score);

    return results;
  }

  /**
   * Check a single candidate for assignability.
   */
  private checkCandidate(
    id: CallableId,
    resolved: ResolvedSignature,
    options: AssignabilityOptions,
  ): AssignabilityCheckResult {
    const { fromType, toType, paramPosition, unwrapReturn } = options;

    // If neither from nor to is specified, no match possible
    if (!fromType && !toType) {
      return this.noMatch(id);
    }

    // Try each signature (for overloads)
    for (let sigIndex = 0; sigIndex < resolved.signatures.length; sigIndex++) {
      const sig = resolved.signatures[sigIndex]!;

      let fromMatch: FromMatchDetails | null = null;
      let toMatch: ToMatchDetails | null = null;
      let score = 0;

      // Check "from" constraint if specified
      if (fromType) {
        fromMatch = this.checkFromMatch(fromType, sig, paramPosition);
        if (!fromMatch.matched) continue; // This signature doesn't match

        // Scoring for from match
        score += fromMatch.exact ? 100 : 50;
        if (fromMatch.paramIndex === 0) {
          score += 10; // Bonus for matching primary param
        } else {
          score -= 5 * fromMatch.paramIndex; // Penalty for later params
        }
      }

      // Check "to" constraint if specified
      if (toType) {
        toMatch = this.checkToMatch(toType, sig, unwrapReturn);
        if (!toMatch.matched) continue; // This signature doesn't match

        // Scoring for to match
        score += toMatch.exact ? 100 : 50;
        if (toMatch.unwrapped) {
          score -= 10; // Slight penalty for requiring unwrap
        }
      }

      // This signature matches!
      // Check if match involves type erasure
      const hasTypeErasure = Boolean(fromMatch?.typeErasure || toMatch?.typeErasure);

      return {
        candidateId: id,
        matches: true,
        matchedSignatureIndex: sigIndex,
        fromMatch,
        toMatch,
        score,
        typeErasure: hasTypeErasure,
      };
    }

    // No signature matched
    return this.noMatch(id);
  }

  /**
   * Check if the query "from" type matches any parameter.
   */
  private checkFromMatch(
    queryFromType: Type,
    sig: ResolvedCallSignature,
    paramPosition: number | "any",
  ): FromMatchDetails {
    // Determine which params to check
    const paramsToCheck: Array<{ param: ResolvedCallSignature["params"][0]; index: number }> = [];

    if (paramPosition === "any") {
      sig.params.forEach((param, index) => {
        paramsToCheck.push({ param, index });
      });
    } else {
      const param = sig.params[paramPosition];
      if (param) {
        paramsToCheck.push({ param, index: paramPosition });
      }
    }

    for (const { param, index } of paramsToCheck) {
      // Direction: queryFromType → paramType
      // "Can I pass queryFromType where paramType is expected?"
      const isAssignable = this.isAssignableTo(queryFromType, param.type);

      if (isAssignable) {
        const exact = this.areTypesIdentical(queryFromType, param.type);
        // Detect type erasure: parameter accepts any/unknown
        const typeErasure = this.involvesTypeErasure(param.type);

        return {
          matched: true,
          paramIndex: index,
          paramName: param.name,
          queryType: this.typeToString(queryFromType),
          paramType: param.typeText,
          exact,
          typeErasure,
        };
      }
    }

    return {
      matched: false,
      paramIndex: -1,
      paramName: "",
      queryType: this.typeToString(queryFromType),
      paramType: "",
      exact: false,
    };
  }

  /**
   * Check if the return type matches the query "to" type.
   */
  private checkToMatch(
    queryToType: Type,
    sig: ResolvedCallSignature,
    unwrapReturn: boolean,
  ): ToMatchDetails {
    // Try direct match first
    // Direction: returnType → queryToType
    // "Can I use returnType where queryToType is expected?"
    if (this.isAssignableTo(sig.returnType, queryToType)) {
      // Detect type erasure: function returns any/unknown
      const typeErasure = this.involvesTypeErasure(sig.returnType);

      return {
        matched: true,
        returnType: sig.returnTypeText,
        queryType: this.typeToString(queryToType),
        exact: this.areTypesIdentical(sig.returnType, queryToType),
        unwrapped: false,
        wrapper: null,
        typeErasure,
      };
    }

    // Try unwrapped match if allowed
    if (unwrapReturn && sig.unwrappedReturnType && sig.returnWrapper) {
      if (this.isAssignableTo(sig.unwrappedReturnType, queryToType)) {
        // Detect type erasure on the unwrapped type
        const typeErasure = this.involvesTypeErasure(sig.unwrappedReturnType);

        return {
          matched: true,
          returnType: sig.unwrappedReturnTypeText ?? sig.returnTypeText,
          queryType: this.typeToString(queryToType),
          exact: this.areTypesIdentical(sig.unwrappedReturnType, queryToType),
          unwrapped: true,
          wrapper: sig.returnWrapper,
          typeErasure,
        };
      }
    }

    return {
      matched: false,
      returnType: sig.returnTypeText,
      queryType: this.typeToString(queryToType),
      exact: false,
      unwrapped: false,
      wrapper: null,
    };
  }

  /**
   * Check if source type is assignable to target type.
   *
   * NOTE: Cross-file type comparisons in ts-morph can fail even for structurally
   * equivalent types due to internal type ID differences. We work around this by:
   * 1. Trying direct assignability first
   * 2. For arrays, checking element type assignability
   * 3. Falling back to normalized text comparison
   */
  private isAssignableTo(source: Type, target: Type): boolean {
    try {
      // Try direct assignability first (works for most cases)
      if (source.isAssignableTo(target)) {
        return true;
      }

      // Try with apparent types (strips aliases and import qualifiers)
      if (source.getApparentType().isAssignableTo(target.getApparentType())) {
        return true;
      }

      // Special handling for arrays: ts-morph sometimes fails to compare arrays
      // from different source files even when they're structurally equivalent
      if (source.isArray() && target.isArray()) {
        const sourceElement = source.getArrayElementType();
        const targetElement = target.getArrayElementType();
        if (sourceElement && targetElement) {
          // Check element assignability (recursive for nested arrays)
          if (this.isAssignableTo(sourceElement, targetElement)) {
            return true;
          }
        }
      }

      // Fallback to normalized text comparison (strips import paths)
      return this.normalizeTypeText(source) === this.normalizeTypeText(target);
    } catch {
      // Last resort: raw text comparison
      return this.typeToString(source) === this.typeToString(target);
    }
  }

  /**
   * Normalize type text for comparison by stripping import paths.
   * e.g., import("./path").User[] → User[]
   */
  private normalizeTypeText(type: Type): string {
    const text = this.typeToString(type);
    return text.replace(/import\([^)]+\)\./g, "");
  }

  /**
   * Check if two types are identical (not just assignable).
   */
  private areTypesIdentical(a: Type, b: Type): boolean {
    // Simple text comparison for now
    // A more robust check would use the type checker
    return this.typeToString(a) === this.typeToString(b);
  }

  /**
   * Convert type to string representation.
   */
  private typeToString(type: Type): string {
    try {
      return type.getText();
    } catch {
      return "unknown";
    }
  }

  /**
   * Create a non-matching result.
   */
  private noMatch(id: CallableId): AssignabilityCheckResult {
    return {
      candidateId: id,
      matches: false,
      matchedSignatureIndex: null,
      fromMatch: null,
      toMatch: null,
      score: 0,
    };
  }
}
