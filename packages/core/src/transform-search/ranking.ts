/**
 * Result Ranking and Explanation
 *
 * Rank results by match quality and generate human-readable explanations
 * of why each function matched the query.
 */

import type { CallableEntry, CallableKind, VerificationMeta, VerificationStatus } from "./types";
import type { AssignabilityCheckResult } from "./assignability-filter";
import type { SyntheticCheckResult } from "./synthetic-verifier";
import type { ParsedQuery } from "./query-parser";

/**
 * Score breakdown for a match.
 */
export interface MatchScore {
  /** Base score for "from" match (0-100) */
  fromScore: number;

  /** Base score for "to" match (0-100) */
  toScore: number;

  /** Bonus for exact type match */
  exactTypeBonus: number;

  /** Bonus for matching primary parameter (index 0) */
  primaryParamBonus: number;

  /** Bonus for exported function */
  exportedBonus: number;

  /** Penalty for requiring wrapper unwrap */
  unwrapPenalty: number;

  /** Penalty for extra required parameters */
  arityMismatchPenalty: number;

  /** Penalty for @deprecated functions */
  deprecatedPenalty: number;

  /** Penalty for non-exported functions */
  internalPenalty: number;

  /** Final total score */
  total: number;
}

/**
 * Confidence level of a match.
 */
export type MatchConfidence = "high" | "medium" | "low";

/**
 * Explanation of how a match was made.
 */
export interface MatchExplanation {
  /** One-line summary */
  summary: string;

  /** Detailed breakdown */
  details: {
    fromMatch?: {
      description: string;
      paramName: string;
      paramIndex: number;
      compatibility: "exact" | "assignable" | "structural";
    };

    toMatch?: {
      description: string;
      compatibility: "exact" | "assignable" | "structural";
      unwrapped?: {
        wrapper: string;
        originalType: string;
      };
    };

    verification?: {
      method: "synthetic" | "assignability-only";
      passed: boolean;
    };
  };

  /** Overall confidence level */
  confidence: MatchConfidence;
}

/**
 * A fully ranked and explained result.
 */
export interface TransformSearchResult {
  /** Function name (qualified) */
  name: string;

  /** Function signature as text */
  signature: string;

  /** Kind of callable */
  kind: CallableKind;

  /** Source file path */
  file: string;

  /** Line number */
  line: number;

  /** Whether the function is exported */
  exported: boolean;

  /** Whether the function is deprecated */
  deprecated: boolean;

  /** Computed score */
  score: number;

  /** Match confidence */
  confidence: MatchConfidence;

  /** Why it matched */
  explanation: MatchExplanation;

  /**
   * Verification metadata - the KEY trust indicator.
   *
   * Agents should only act with high confidence on results where
   * verification.status === 'verified'.
   */
  verification: VerificationMeta;

  /** Detailed match info for debugging */
  matchDetails: {
    fromMatch: AssignabilityCheckResult["fromMatch"];
    toMatch: AssignabilityCheckResult["toMatch"];
    /** @deprecated Use verification.status === 'verified' instead */
    syntheticVerified: boolean | null;
  };
}

/**
 * Full response from a transform search.
 */
export interface TransformSearchResponse {
  /** Matched results */
  results: TransformSearchResult[];

  /** Query that was executed */
  query: {
    from: string | null;
    to: string | null;
    options: {
      paramPosition: number | "any";
      unwrapReturn: boolean;
      exportedOnly: boolean;
      verifiedOnly?: boolean;
      minVerificationStatus?: VerificationStatus;
      includeDiagnostics?: boolean;
      includeSyntheticCode?: boolean;
      includeFailedVerification?: boolean;
    };
  };

  /** Performance and filtering stats */
  stats: {
    totalCandidates: number;
    assignableMatches: number;
    verifiedMatches: number;
    verification: Record<VerificationStatus, number>;
    returned: number;
    timing: {
      indexLookupMs: number;
      resolutionMs: number;
      assignabilityMs: number;
      syntheticMs: number;
      totalMs: number;
    };
  };
}

/**
 * Calculate the score for a match.
 */
export function calculateScore(
  entry: CallableEntry,
  assignabilityResult: AssignabilityCheckResult,
  syntheticResult: SyntheticCheckResult | null,
): MatchScore {
  const score: MatchScore = {
    fromScore: 0,
    toScore: 0,
    exactTypeBonus: 0,
    primaryParamBonus: 0,
    exportedBonus: 0,
    unwrapPenalty: 0,
    arityMismatchPenalty: 0,
    deprecatedPenalty: 0,
    internalPenalty: 0,
    total: 0,
  };

  // Base scores from assignability
  if (assignabilityResult.fromMatch?.matched) {
    score.fromScore = 50;
    if (assignabilityResult.fromMatch.exact) {
      score.exactTypeBonus += 25;
    }
    if (assignabilityResult.fromMatch.paramIndex === 0) {
      score.primaryParamBonus = 20;
    } else {
      // Slight penalty for matching later parameters
      score.primaryParamBonus = -5 * assignabilityResult.fromMatch.paramIndex;
    }
  }

  if (assignabilityResult.toMatch?.matched) {
    score.toScore = 50;
    if (assignabilityResult.toMatch.exact) {
      score.exactTypeBonus += 25;
    }
    if (assignabilityResult.toMatch.unwrapped) {
      score.unwrapPenalty = -10;
    }
  }

  // Synthetic verification bonus (higher confidence)
  if (syntheticResult?.verified) {
    score.fromScore += 25;
    score.toScore += 25;
  }

  // Export state
  if (entry.exportState === "exported") {
    score.exportedBonus = 10;
  } else {
    score.internalPenalty = -20;
  }

  // Deprecation
  if (entry.isDeprecated) {
    score.deprecatedPenalty = -30;
  }

  // Arity penalty (prefer simpler signatures)
  if (entry.minArity > 1) {
    score.arityMismatchPenalty = -5 * (entry.minArity - 1);
  }

  // Calculate total
  score.total =
    score.fromScore +
    score.toScore +
    score.exactTypeBonus +
    score.primaryParamBonus +
    score.exportedBonus +
    score.unwrapPenalty +
    score.arityMismatchPenalty +
    score.deprecatedPenalty +
    score.internalPenalty;

  return score;
}

/**
 * Generate an explanation for a match.
 */
export function generateExplanation(
  entry: CallableEntry,
  assignabilityResult: AssignabilityCheckResult,
  syntheticResult: SyntheticCheckResult | null,
  query: ParsedQuery,
): MatchExplanation {
  const details: MatchExplanation["details"] = {};
  const summaryParts: string[] = [];

  addFromMatchExplanation(details, summaryParts, assignabilityResult, query);
  addToMatchExplanation(details, summaryParts, assignabilityResult, query);
  details.verification = createVerificationExplanation(syntheticResult);

  return {
    summary: summaryParts.join(", ") || "matches query",
    details,
    confidence: calculateConfidence(assignabilityResult, syntheticResult),
  };
}

function addFromMatchExplanation(
  details: MatchExplanation["details"],
  summaryParts: string[],
  assignabilityResult: AssignabilityCheckResult,
  query: ParsedQuery,
): void {
  const fm = assignabilityResult.fromMatch;
  if (!fm?.matched) return;

  if (fm.exact) {
    details.fromMatch = {
      description: `Parameter '${fm.paramName}' accepts exactly ${fm.queryType}`,
      paramName: fm.paramName,
      paramIndex: fm.paramIndex,
      compatibility: "exact",
    };
    summaryParts.push(`accepts ${query.from?.raw ?? fm.queryType}`);
  } else {
    details.fromMatch = {
      description: `Parameter '${fm.paramName}' (${fm.paramType}) is compatible with ${fm.queryType}`,
      paramName: fm.paramName,
      paramIndex: fm.paramIndex,
      compatibility: "assignable",
    };
    summaryParts.push(`accepts ${query.from?.raw ?? fm.queryType} (via ${fm.paramType})`);
  }
}

function addToMatchExplanation(
  details: MatchExplanation["details"],
  summaryParts: string[],
  assignabilityResult: AssignabilityCheckResult,
  query: ParsedQuery,
): void {
  const tm = assignabilityResult.toMatch;
  if (!tm?.matched) return;

  if (tm.unwrapped && tm.wrapper) {
    details.toMatch = {
      description: `Returns ${tm.wrapper}<${tm.returnType}> which unwraps to ${tm.queryType}`,
      compatibility: "assignable",
      unwrapped: {
        wrapper: tm.wrapper,
        originalType: `${tm.wrapper}<${tm.returnType}>`,
      },
    };
    summaryParts.push(`returns ${query.to?.raw ?? tm.queryType} (unwrapped from ${tm.wrapper})`);
  } else if (tm.exact) {
    details.toMatch = {
      description: `Returns exactly ${tm.queryType}`,
      compatibility: "exact",
    };
    summaryParts.push(`returns ${query.to?.raw ?? tm.queryType}`);
  } else {
    details.toMatch = {
      description: `Returns ${tm.returnType} which is assignable to ${tm.queryType}`,
      compatibility: "assignable",
    };
    summaryParts.push(`returns ${query.to?.raw ?? tm.queryType} (via ${tm.returnType})`);
  }
}

function createVerificationExplanation(
  syntheticResult: SyntheticCheckResult | null,
): NonNullable<MatchExplanation["details"]["verification"]> {
  return syntheticResult
    ? { method: "synthetic", passed: syntheticResult.verified }
    : { method: "assignability-only", passed: true };
}

function calculateConfidence(
  assignabilityResult: AssignabilityCheckResult,
  syntheticResult: SyntheticCheckResult | null,
): MatchConfidence {
  const verificationStatus = syntheticResult?.verification?.status ?? null;

  if (verificationStatus === "verified") return "high";
  if (verificationStatus === "unverifiable") return "low";
  if (verificationStatus === "unverified") {
    return syntheticResult?.verification?.reason === "no_type_annotations" ? "low" : "medium";
  }
  if (!syntheticResult && assignabilityResult.fromMatch?.exact && assignabilityResult.toMatch?.exact) {
    return "high";
  }
  return "medium";
}

/**
 * Format results for output.
 */
export function formatResults(response: TransformSearchResponse): string {
  if (response.results.length === 0) {
    return JSON.stringify(
      {
        message: "No matching transforms found",
        query: response.query,
        stats: response.stats,
      },
      null,
      2,
    );
  }

  // Compact format for results
  const formatted = {
    results: response.results.map((r) => ({
      name: r.name,
      signature: r.signature,
      location: `${r.file}:${r.line}`,
      confidence: r.confidence,
      // NEW: Include verification status for trust assessment
      verification: {
        status: r.verification.status,
        method: r.verification.method,
        reason: r.verification.reason,
        ...(r.verification.diagnostics ? { diagnostics: r.verification.diagnostics } : {}),
        ...(r.verification.syntheticCode ? { syntheticCode: r.verification.syntheticCode } : {}),
      },
      explanation: r.explanation.summary,
      score: r.score,
      ...(r.deprecated ? { deprecated: true } : {}),
      ...(r.explanation.details.toMatch?.unwrapped
        ? { unwrapped: r.explanation.details.toMatch.unwrapped }
        : {}),
    })),
    stats: {
      found: response.stats.verifiedMatches,
      returned: response.stats.returned,
      verification: response.stats.verification,
      timeMs: Math.round(response.stats.timing.totalMs),
    },
  };

  return JSON.stringify(formatted, null, 2);
}
