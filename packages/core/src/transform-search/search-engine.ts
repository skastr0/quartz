/**
 * Transform Search Engine
 *
 * Orchestrates all components to execute transform searches.
 * This is the main entry point that wires together:
 * - Callable enumeration and indexing
 * - Query parsing
 * - Signature resolution
 * - Assignability filtering
 * - Synthetic verification
 * - Result ranking and explanation
 */

import { type Project, type SourceFile } from "ts-morph";
import { relative } from "path";

import type { CallableEntry, CallableId, CallableIndex, VerificationMeta } from "./types";
import { enumerateCallables } from "./enumerate";
import { populateEntryTokens } from "./tokens";
import { buildCallableIndex, selectCandidates } from "./index-builder";
import { SignatureResolver } from "./signature-resolver";
import { AssignabilityFilter } from "./assignability-filter";
import { SyntheticVerifier, shouldSkipSyntheticCheck } from "./synthetic-verifier";
import { QueryParser, type ParsedQuery } from "./query-parser";
import {
  calculateScore,
  generateExplanation,
  type TransformSearchResult,
  type TransformSearchResponse,
} from "./ranking";

/**
 * Options for a transform search.
 */
export interface TransformSearchOptions {
  /** Input type to search for */
  from?: string;

  /** Output type to search for */
  to?: string;

  /** Which parameter position to match "from" against */
  paramPosition?: number | "any";

  /** Whether to match unwrapped return types */
  unwrapReturn?: boolean;

  /** Only search exported functions */
  exportedOnly?: boolean;

  /** Maximum number of results */
  limit?: number;

  /**
   * Include matches involving type erasure (any/unknown).
   * Default: false - excludes matches where the function uses any/unknown
   * as these produce false positives.
   */
  allowTypeErasure?: boolean;
}

/**
 * Main search engine for transform search.
 */
export class TransformSearchEngine {
  private project: Project;
  private packagePath: string;
  private sourceFiles: SourceFile[];

  // Cached callable index (safe to cache - doesn't hold type references)
  private callableIndex: CallableIndex | null = null;

  // Cached path->sourceFile map for O(1) lookups (avoids O(n*m) loops)
  private sourceFileByRelPath: Map<string, SourceFile> | null = null;

  // NOTE: SignatureResolver is NOT cached because it holds ts-morph Type
  // references that become stale when query temp files are created/destroyed.
  // Each search creates a fresh resolver to ensure type comparisons work correctly.

  constructor(project: Project, packagePath: string, sourceFiles: SourceFile[]) {
    this.project = project;
    this.packagePath = packagePath;
    this.sourceFiles = sourceFiles;
  }

  /**
   * Execute a transform search.
   */
  async search(options: TransformSearchOptions): Promise<TransformSearchResponse> {
    const startTime = performance.now();
    const timing: TransformSearchResponse["stats"]["timing"] = {
      indexLookupMs: 0,
      resolutionMs: 0,
      assignabilityMs: 0,
      syntheticMs: 0,
      totalMs: 0,
    };

    // Ensure index exists
    const index = this.ensureIndex();

    // Parse query
    const queryParser = new QueryParser(this.project, this.packagePath);

    try {
      const query = queryParser.parseQuery({
        ...(options.from === undefined ? {} : { from: options.from }),
        ...(options.to === undefined ? {} : { to: options.to }),
        ...(options.paramPosition === undefined ? {} : { paramPosition: options.paramPosition }),
        ...(options.unwrapReturn === undefined ? {} : { unwrapReturn: options.unwrapReturn }),
        ...(options.exportedOnly === undefined ? {} : { exportedOnly: options.exportedOnly }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });

      if (!query.isValid) {
        throw new Error(`Invalid query: ${query.validationErrors.join(", ")}`);
      }

      return await this.executeSearch(query, options, index, timing, startTime);
    } finally {
      // IMPORTANT: Clean up temp files created during query parsing
      queryParser.cleanup();
    }
  }

  /**
   * Execute the search after query parsing (internal helper).
   */
  private async executeSearch(
    query: ParsedQuery,
    options: TransformSearchOptions,
    index: CallableIndex,
    timing: TransformSearchResponse["stats"]["timing"],
    startTime: number,
  ): Promise<TransformSearchResponse> {
    // Layer B: Candidate selection via inverted index
    const indexStart = performance.now();
    const candidateIds = selectCandidates(index, {
      ...(query.from?.tokens === undefined ? {} : { fromTokens: query.from.tokens }),
      ...(query.to?.tokens === undefined ? {} : { toTokens: query.to.tokens }),
      ...(query.from?.propKeys === undefined ? {} : { fromPropKeys: query.from.propKeys }),
      ...(query.to?.propKeys === undefined ? {} : { toPropKeys: query.to.propKeys }),
      exportedOnly: query.exportedOnly,
      budget: 1500,
    });
    timing.indexLookupMs = performance.now() - indexStart;

    // Layer C: Resolve signatures (fresh resolver each search for type stability)
    const resolutionStart = performance.now();
    const resolver = this.createSignatureResolver(index);
    const resolvedSignatures = resolver.resolveSignatures(candidateIds);
    timing.resolutionMs = performance.now() - resolutionStart;

    // Assignability filtering
    const assignabilityStart = performance.now();
    const filter = new AssignabilityFilter(this.project);
    const assignableResults = filter.filterByAssignability(resolvedSignatures, {
      fromType: query.from?.resolvedType ?? null,
      toType: query.to?.resolvedType ?? null,
      paramPosition: query.paramPosition,
      unwrapReturn: query.unwrapReturn,
      allowTypeErasure: options.allowTypeErasure ?? false,
    });
    timing.assignabilityMs = performance.now() - assignabilityStart;

    // Synthetic verification (top candidates only)
    const syntheticStart = performance.now();
    const syntheticBudget = Math.min(50, assignableResults.length);
    const topCandidates = assignableResults.slice(0, syntheticBudget);

    // Store full verification metadata, not just boolean
    const syntheticResults = new Map<CallableId, VerificationMeta>();

    // Only run synthetic checks if we have both from and to expressions
    if (query.from?.raw && query.to?.raw) {
      const verifier = new SyntheticVerifier(this.project, this.packagePath);

      for (const candidate of topCandidates) {
        const entry = index.entries[candidate.candidateId];
        if (!entry) continue;

        // Check if we should skip synthetic verification
        const skipResult = shouldSkipSyntheticCheck(entry, candidate);

        if (skipResult.skip) {
          // CRITICAL FIX: Properly propagate the verification status
          // Don't mark unannotated/internal functions as "verified"!
          syntheticResults.set(candidate.candidateId, {
            status: skipResult.status,
            method: skipResult.method,
            reason: skipResult.reason,
          });
          continue;
        }

        // Perform full synthetic verification
        const verified = verifier.verifyCandidates(
          [candidate],
          {
            fromExpr: query.from.raw,
            toExpr: query.to.raw,
            unwrapReturn: query.unwrapReturn,
          },
          index,
        );

        if (verified.length > 0) {
          syntheticResults.set(candidate.candidateId, verified[0]!.verification);
        }
      }
    } else {
      // If only from or only to is specified, mark as partial query (unverified)
      for (const candidate of topCandidates) {
        const entry = index.entries[candidate.candidateId];
        if (!entry) continue;

        // Still check for skippable conditions
        const skipResult = shouldSkipSyntheticCheck(entry, candidate);
        if (skipResult.skip && skipResult.status !== "verified") {
          // Preserve unverified/unverifiable status
          syntheticResults.set(candidate.candidateId, {
            status: skipResult.status,
            method: skipResult.method,
            reason: skipResult.reason,
          });
        } else {
          // Partial query - can't fully verify
          syntheticResults.set(candidate.candidateId, {
            status: "unverified",
            method: "assignability_only",
            reason: "partial_query",
          });
        }
      }
    }
    timing.syntheticMs = performance.now() - syntheticStart;

    // Build final results
    const results: TransformSearchResult[] = [];

    for (const assignResult of assignableResults) {
      const entry = index.entries[assignResult.candidateId];
      if (!entry) continue;

      const verificationMeta = syntheticResults.get(assignResult.candidateId);

      // Skip if synthetic verification was performed and explicitly failed
      // (status === 'unverified' with reason 'synthetic_check_failed')
      if (verificationMeta?.reason === "synthetic_check_failed") continue;

      // Create compatible SyntheticCheckResult for scoring/explanation functions
      const syntheticResultCompat = verificationMeta
        ? {
            candidateId: entry.id,
            verified: verificationMeta.status === "verified",
            verification: verificationMeta,
            diagnostics: verificationMeta.diagnostics ?? [],
            syntheticCode: "",
          }
        : null;

      const score = calculateScore(entry, assignResult, syntheticResultCompat);
      const explanation = generateExplanation(entry, assignResult, syntheticResultCompat, query);

      // Determine the final verification for the result
      const finalVerification: VerificationMeta = verificationMeta ?? {
        status: "unverified",
        method: "assignability_only",
        reason: "partial_query",
      };

      results.push({
        name: entry.qualifiedName,
        signature: this.getSignatureText(entry),
        kind: entry.kind,
        file: entry.filePath,
        line: this.getLineNumber(entry),
        exported: entry.exportState === "exported",
        deprecated: entry.isDeprecated,
        score: score.total,
        confidence: explanation.confidence,
        explanation,
        verification: finalVerification,
        matchDetails: {
          fromMatch: assignResult.fromMatch,
          toMatch: assignResult.toMatch,
          syntheticVerified: finalVerification.status === "verified",
        },
      });
    }

    // Sort by score and limit
    results.sort((a, b) => b.score - a.score);
    const limitedResults = results.slice(0, query.limit);

    timing.totalMs = performance.now() - startTime;

    return {
      results: limitedResults,
      query: {
        from: options.from ?? null,
        to: options.to ?? null,
        options: {
          paramPosition: query.paramPosition,
          unwrapReturn: query.unwrapReturn,
          exportedOnly: query.exportedOnly,
        },
      },
      stats: {
        totalCandidates: candidateIds.length,
        assignableMatches: assignableResults.length,
        verifiedMatches: results.length,
        returned: limitedResults.length,
        timing,
      },
    };
  }

  /**
   * Ensure the callable index exists.
   */
  private ensureIndex(): CallableIndex {
    if (!this.callableIndex) {
      const enumResult = enumerateCallables(this.sourceFiles, this.packagePath);

      // Use map for O(1) sourceFile lookups instead of O(n) find
      const sfMap = this.ensureSourceFileMap();

      // Populate tokens for each entry
      for (const entry of enumResult.entries) {
        const sf = sfMap.get(entry.filePath);
        if (sf) {
          const node = sf.getDescendantAtPos(entry.pos);
          if (node) {
            populateEntryTokens(entry, node);
          }
        }
      }

      this.callableIndex = buildCallableIndex(enumResult.entries);
    }

    return this.callableIndex;
  }

  /**
   * Ensure the sourceFile-by-relative-path map exists.
   * Maps relative paths (matching entry.filePath format) to sourceFiles.
   */
  private ensureSourceFileMap(): Map<string, SourceFile> {
    if (!this.sourceFileByRelPath) {
      this.sourceFileByRelPath = new Map();
      for (const sf of this.sourceFiles) {
        const relPath = relative(this.packagePath, sf.getFilePath()).replace(/\\/g, "/");
        this.sourceFileByRelPath.set(relPath, sf);
      }
    }
    return this.sourceFileByRelPath;
  }

  /**
   * Create a fresh signature resolver for this search.
   *
   * NOTE: We create a new resolver for each search rather than caching,
   * because cached Type references become stale when temp query files
   * are created and destroyed between searches.
   */
  private createSignatureResolver(index: CallableIndex): SignatureResolver {
    return new SignatureResolver(this.project, index, this.packagePath);
  }

  /**
   * Get the signature text for an entry.
   */
  private getSignatureText(entry: CallableEntry): string {
    // Build a simple signature from the entry data
    const params =
      entry.paramTokens.length > 0
        ? `(${entry.paramTokens.slice(0, 3).join(", ")}${entry.paramTokens.length > 3 ? ", ..." : ""})`
        : "()";
    const returns = entry.returnTokens.length > 0 ? entry.returnTokens[0] : "unknown";

    if (entry.kind === "Constructor") {
      return `new ${entry.qualifiedName}${params}`;
    }

    const asyncPrefix = entry.isAsyncSyntax ? "async " : "";
    return `${asyncPrefix}${params} => ${returns}`;
  }

  /**
   * Get the line number for an entry.
   */
  private getLineNumber(entry: CallableEntry): number {
    const sfMap = this.ensureSourceFileMap();
    const sf = sfMap.get(entry.filePath);
    if (sf) {
      try {
        const pos = sf.getLineAndColumnAtPos(entry.pos);
        return pos.line;
      } catch {
        return 1;
      }
    }
    return 1;
  }

  /**
   * Invalidate cached data.
   */
  invalidate(): void {
    this.callableIndex = null;
    this.sourceFileByRelPath = null;
  }
}
