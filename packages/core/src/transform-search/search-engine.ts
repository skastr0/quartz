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
import { AssignabilityFilter, type AssignabilityCheckResult } from "./assignability-filter";
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

type SearchTiming = TransformSearchResponse["stats"]["timing"];

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
    timing: SearchTiming,
    startTime: number,
  ): Promise<TransformSearchResponse> {
    const candidateIds = this.selectIndexedCandidates(query, index, timing);
    const assignableResults = this.resolveAssignableCandidates(
      query,
      options,
      index,
      candidateIds,
      timing,
    );
    const syntheticResults = this.verifyTopCandidates(query, index, assignableResults, timing);
    const results = this.buildSearchResults(query, index, assignableResults, syntheticResults);

    timing.totalMs = performance.now() - startTime;

    return this.createSearchResponse(options, query, candidateIds, assignableResults, results, timing);
  }

  private selectIndexedCandidates(
    query: ParsedQuery,
    index: CallableIndex,
    timing: SearchTiming,
  ): CallableId[] {
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
    return candidateIds;
  }

  private resolveAssignableCandidates(
    query: ParsedQuery,
    options: TransformSearchOptions,
    index: CallableIndex,
    candidateIds: CallableId[],
    timing: SearchTiming,
  ): AssignabilityCheckResult[] {
    const resolutionStart = performance.now();
    const resolver = this.createSignatureResolver(index);
    const resolvedSignatures = resolver.resolveSignatures(candidateIds);
    timing.resolutionMs = performance.now() - resolutionStart;

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
    return assignableResults;
  }

  private verifyTopCandidates(
    query: ParsedQuery,
    index: CallableIndex,
    assignableResults: AssignabilityCheckResult[],
    timing: SearchTiming,
  ): Map<CallableId, VerificationMeta> {
    const syntheticStart = performance.now();
    const topCandidates = assignableResults.slice(0, Math.min(50, assignableResults.length));
    const syntheticResults = query.from?.raw && query.to?.raw
      ? this.verifyCompleteQueryCandidates(query, index, topCandidates)
      : this.markPartialQueryCandidates(index, topCandidates);
    timing.syntheticMs = performance.now() - syntheticStart;
    return syntheticResults;
  }

  private verifyCompleteQueryCandidates(
    query: ParsedQuery,
    index: CallableIndex,
    topCandidates: AssignabilityCheckResult[],
  ): Map<CallableId, VerificationMeta> {
    const syntheticResults = new Map<CallableId, VerificationMeta>();
    const verifier = new SyntheticVerifier(this.project, this.packagePath);

    for (const candidate of topCandidates) {
      const entry = index.entries[candidate.candidateId];
      if (!entry) continue;

      const skipResult = shouldSkipSyntheticCheck(entry, candidate);
      if (skipResult.skip) {
        syntheticResults.set(candidate.candidateId, {
          status: skipResult.status,
          method: skipResult.method,
          reason: skipResult.reason,
        });
        continue;
      }

      const verified = verifier.verifyCandidates(
        [candidate],
        {
          fromExpr: query.from!.raw,
          toExpr: query.to!.raw,
          unwrapReturn: query.unwrapReturn,
        },
        index,
      );

      if (verified.length > 0) {
        syntheticResults.set(candidate.candidateId, verified[0]!.verification);
      }
    }

    return syntheticResults;
  }

  private markPartialQueryCandidates(
    index: CallableIndex,
    topCandidates: AssignabilityCheckResult[],
  ): Map<CallableId, VerificationMeta> {
    const syntheticResults = new Map<CallableId, VerificationMeta>();
    for (const candidate of topCandidates) {
      const entry = index.entries[candidate.candidateId];
      if (!entry) continue;

      const skipResult = shouldSkipSyntheticCheck(entry, candidate);
      if (skipResult.skip && skipResult.status !== "verified") {
        syntheticResults.set(candidate.candidateId, {
          status: skipResult.status,
          method: skipResult.method,
          reason: skipResult.reason,
        });
      } else {
        syntheticResults.set(candidate.candidateId, {
          status: "unverified",
          method: "assignability_only",
          reason: "partial_query",
        });
      }
    }
    return syntheticResults;
  }

  private buildSearchResults(
    query: ParsedQuery,
    index: CallableIndex,
    assignableResults: AssignabilityCheckResult[],
    syntheticResults: Map<CallableId, VerificationMeta>,
  ): TransformSearchResult[] {
    const results: TransformSearchResult[] = [];

    for (const assignResult of assignableResults) {
      const result = this.createSearchResult(query, index, assignResult, syntheticResults);
      if (result) results.push(result);
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  private createSearchResult(
    query: ParsedQuery,
    index: CallableIndex,
    assignResult: AssignabilityCheckResult,
    syntheticResults: Map<CallableId, VerificationMeta>,
  ): TransformSearchResult | null {
    const entry = index.entries[assignResult.candidateId];
    if (!entry) return null;

    const verificationMeta = syntheticResults.get(assignResult.candidateId);
    if (verificationMeta?.reason === "synthetic_check_failed") return null;

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
    const finalVerification: VerificationMeta = verificationMeta ?? {
      status: "unverified",
      method: "assignability_only",
      reason: "partial_query",
    };

    return {
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
    };
  }

  private createSearchResponse(
    options: TransformSearchOptions,
    query: ParsedQuery,
    candidateIds: CallableId[],
    assignableResults: AssignabilityCheckResult[],
    results: TransformSearchResult[],
    timing: SearchTiming,
  ): TransformSearchResponse {
    const limitedResults = results.slice(0, query.limit);
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
