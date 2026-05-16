/**
 * Transform Search Types
 *
 * Core data structures for the type-driven function discovery system.
 * These types form the foundation for indexing all callable entities
 * in a TypeScript codebase for structural type matching.
 */

/**
 * Unique identifier for a callable entry.
 * Uses numeric IDs for memory efficiency when indexing thousands of callables.
 */
export type CallableId = number;

/**
 * Classification of callable entities in TypeScript.
 *
 * Each kind has distinct semantics for how it can be invoked:
 * - Function/VariableCallable: Direct invocation
 * - ClassMethod/StaticMethod: Invoked on instance/class
 * - Constructor: Invoked with `new`
 * - Interface/TypeLiteral methods: Contract definitions
 */
export type CallableKind =
  | "Function" // function foo() {}
  | "VariableCallable" // const foo = () => {} or const foo = function() {}
  | "ClassMethod" // class X { method() {} }
  | "StaticMethod" // class X { static method() {} }
  | "Constructor" // class X { constructor() {} } - IMPORTANT for DB→Domain transforms
  | "ObjectMethod" // { handler() {} } or { handler: () => {} }
  | "InterfaceMethod" // interface X { method(): void }
  | "TypeLiteralMethod" // type X = { method(): void }
  | "CallableProperty"; // interface X { fn: (a: A) => B }

/**
 * Export visibility state of a callable.
 *
 * - exported: Visible to external modules (public API)
 * - internal: Not exported, only visible within file
 * - ambient: Declaration in .d.ts file
 */
export type ExportState = "exported" | "internal" | "ambient";

/**
 * Core entry representing a single callable in the index.
 *
 * Design principles:
 * 1. Numeric IDs for memory efficiency
 * 2. Position-based identity (filePath + pos) for stable lookups
 * 3. Separate param/return tokens for directional queries
 * 4. Empty arrays mean "unknown", not "no types"
 */
export interface CallableEntry {
  /** Unique numeric identifier (array index) */
  id: CallableId;

  // === Identity & Location ===

  /** Classification of this callable */
  kind: CallableKind;

  /**
   * Fully qualified name for display and lookup.
   * Examples: "UserMapper.toDTO", "services/user.ts:updateUser"
   */
  qualifiedName: string;

  /** Export visibility state */
  exportState: ExportState;

  /** File path relative to package root */
  filePath: string;

  /**
   * Start position in source file (node.getStart()).
   * Stable across minor edits for quick re-lookup.
   */
  pos: number;

  /** End position in source file (node.getEnd()) */
  end: number;

  // === Shape Filters (no typechecker required) ===

  /** Minimum required parameters (non-optional, non-rest) */
  minArity: number;

  /** Maximum parameters (Infinity if rest parameter present) */
  maxArity: number;

  /** Whether function has a rest parameter (...args) */
  hasRest: boolean;

  /** Whether "async" keyword is present (syntactic, not semantic) */
  isAsyncSyntax: boolean;

  /** Whether type annotations are present (affects token trust) */
  hasTypeAnnotations: boolean;

  // === Overload Info ===

  /**
   * Number of syntactic overload signatures.
   * For overloaded functions/methods, this counts declaration signatures.
   */
  syntacticOverloadCount: number;

  // === Cheap Tokens (AST extraction, no checker) ===

  /**
   * Type identifiers extracted from parameter type annotations.
   * IMPORTANT: Empty array means "unknown/no annotations", not "no types".
   * Examples: ["User", "string", "Promise"]
   */
  paramTokens: string[];

  /**
   * Type identifiers extracted from return type annotation.
   * IMPORTANT: Empty array means "unknown/no annotations", not "no types".
   */
  returnTokens: string[];

  // === Structural Hints (from explicit type literals only) ===

  /**
   * Property keys from inline object type literals in parameters.
   * Example: function f(x: { id: string; name: string }) -> ["id", "name"]
   */
  paramPropKeys: string[];

  /**
   * Property keys from inline object type literals in return type.
   * Example: function f(): { email: string } -> ["email"]
   */
  returnPropKeys: string[];

  // === Metadata for Ranking ===

  /** JSDoc tag names present (e.g., "deprecated", "internal", "beta") */
  jsDocTags: string[];

  /** Derived from @deprecated JSDoc tag for quick filtering */
  isDeprecated: boolean;
}

/**
 * Result from enumerating all callables in a package.
 */
export interface EnumerationResult {
  /** All callable entries found */
  entries: CallableEntry[];

  /** Statistics by callable kind */
  stats: EnumerationStats;
}

/**
 * Statistics from callable enumeration.
 */
export interface EnumerationStats {
  functions: number;
  variableCallables: number;
  classMethods: number;
  staticMethods: number;
  constructors: number;
  objectMethods: number;
  interfaceMethods: number;
  typeLiteralMethods: number;
  callableProperties: number;
  total: number;
}

/**
 * Result from extracting tokens from a type node.
 */
export interface TokenExtractionResult {
  /** Type identifiers found (e.g., "User", "Promise", "Array") */
  tokens: string[];

  /** Property keys from type literals (e.g., "id", "name") */
  propKeys: string[];
}

/**
 * Inverted index for fast candidate lookup.
 */
export interface CallableIndex {
  /** All entries in order (id = array index) */
  entries: CallableEntry[];

  // === Inverted Indices ===

  /** Token -> CallableIds mentioning this token anywhere */
  byToken: Map<string, Set<CallableId>>;

  /** Token -> CallableIds with this token in PARAM types */
  byParamToken: Map<string, Set<CallableId>>;

  /** Token -> CallableIds with this token in RETURN type */
  byReturnToken: Map<string, Set<CallableId>>;

  /** Property key -> CallableIds with this key in param type literals */
  byParamProp: Map<string, Set<CallableId>>;

  /** Property key -> CallableIds with this key in return type literals */
  byReturnProp: Map<string, Set<CallableId>>;

  /** Min arity -> CallableIds (for "accepts at least N args" queries) */
  byMinArity: Map<number, Set<CallableId>>;

  // === Scoping Buckets ===

  /** IDs of exported callables */
  exported: Set<CallableId>;

  /** IDs of internal (non-exported) callables */
  internal: Set<CallableId>;

  /** IDs of ambient (.d.ts) callables */
  ambient: Set<CallableId>;

  /** File path -> CallableIds in that file */
  byFile: Map<string, Set<CallableId>>;

  /** Kind -> CallableIds of that kind */
  byKind: Map<CallableKind, Set<CallableId>>;

  // === Statistics for Ranking ===

  /**
   * Document frequency: how many callables mention each token.
   * Used for IDF-style scoring (rare tokens = more significant matches).
   */
  tokenDf: Map<string, number>;

  /** Document frequency for property keys */
  propDf: Map<string, number>;

  /** Total number of callables indexed */
  totalCallables: number;

  /** Total number of exported callables */
  totalExported: number;
}

/**
 * Verification status of a match result.
 *
 * This is the KEY trust indicator - agents should only act with high confidence
 * on 'verified' results.
 */
export type VerificationStatus = "verified" | "unverified" | "unverifiable";

/**
 * Reason why verification was skipped or failed.
 */
export type VerificationReason =
  | "exact_type_match" // Both from/to types exactly match - no verification needed
  | "no_type_annotations" // Function has no TS annotations - can't verify
  | "not_importable" // Internal function - can't create synthetic call
  | "type_erasure" // Match relies on any/unknown
  | "synthetic_check_passed" // Full verification succeeded
  | "synthetic_check_failed" // Verification attempted but failed
  | "partial_query"; // Only from or to specified - can't fully verify

/**
 * Verification metadata for a search result.
 *
 * This provides transparency about HOW the match was determined,
 * allowing agents to make informed decisions about trust.
 */
export interface VerificationMeta {
  /** The verification status */
  status: VerificationStatus;

  /** Method used for verification (or null if unverifiable) */
  method: "synthetic" | "exact_match" | "assignability_only" | null;

  /** Why this status was assigned */
  reason: VerificationReason;

  /** Any compiler diagnostics from failed verification */
  diagnostics?: Array<{ code: number; message: string }>;

  /** Generated synthetic TypeScript used for compiler-backed verification */
  syntheticCode?: string;
}

/**
 * Options for candidate selection from the index.
 */
export interface CandidateSelectionOptions {
  /** Tokens from the query "from" type */
  fromTokens?: string[];

  /** Tokens from the query "to" type */
  toTokens?: string[];

  /** Property keys from the query "from" type */
  fromPropKeys?: string[];

  /** Property keys from the query "to" type */
  toPropKeys?: string[];

  /** Only return exported callables (default: true) */
  exportedOnly?: boolean;

  /** Filter by specific callable kinds */
  kinds?: CallableKind[];

  /** Filter by specific files */
  files?: string[];

  /** Maximum candidates to return */
  budget: number;
}
