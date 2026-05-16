/**
 * Transform Search Module
 *
 * Type-driven function discovery for TypeScript codebases.
 * Find functions by their type signatures using structural compatibility matching.
 */

// Core types
export type {
  CallableId,
  CallableKind,
  ExportState,
  CallableEntry,
  EnumerationResult,
  EnumerationStats,
  TokenExtractionResult,
  CallableIndex,
  VerificationStatus,
  VerificationReason,
  VerificationMeta,
  CandidateSelectionOptions,
} from "./types";

// Enumeration
export { enumerateCallables } from "./enumerate";

// Token extraction
export {
  extractTokensFromTypeNode,
  extractCallableTokens,
  extractVariableCallableTokens,
  extractCallablePropertyTokens,
  populateEntryTokens,
} from "./tokens";

// Index building and querying
export {
  buildCallableIndex,
  selectCandidates,
  getEntry,
  getIndexStats,
  calculateIdf,
  calculatePropIdf,
} from "./index-builder";

// Signature resolution
export type {
  WrapperKind,
  ResolvedParam,
  ResolvedCallSignature,
  ResolvedSignature,
} from "./signature-resolver";
export { SignatureResolver } from "./signature-resolver";

// Assignability filtering
export type {
  FromMatchDetails,
  ToMatchDetails,
  AssignabilityCheckResult,
  AssignabilityOptions,
} from "./assignability-filter";
export { AssignabilityFilter } from "./assignability-filter";

// Synthetic verification
export type { SyntheticCheckResult, SyntheticVerifyOptions } from "./synthetic-verifier";
export { SyntheticVerifier, shouldSkipSyntheticCheck } from "./synthetic-verifier";

// Query parsing
export type { QueryTypeKind, QueryType, ParsedQuery, QueryParseOptions } from "./query-parser";
export { QueryParser } from "./query-parser";

// Ranking and explanation
export type {
  MatchScore,
  MatchConfidence,
  MatchExplanation,
  TransformSearchResult,
  TransformSearchResponse,
} from "./ranking";
export { calculateScore, generateExplanation, formatResults } from "./ranking";

// Search engine
export type { TransformSearchOptions } from "./search-engine";
export { TransformSearchEngine } from "./search-engine";
