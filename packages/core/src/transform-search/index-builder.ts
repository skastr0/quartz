/**
 * Inverted Index Builder
 *
 * Build inverted indices for fast candidate selection.
 * This is Layer B of the indexing architecture.
 *
 * Key insight: Start with the RAREST token in the query and intersect from there.
 * This gets us from 10,000 callables to ~100 candidates before any expensive type checking.
 */

import type {
  CallableEntry,
  CallableId,
  CallableKind,
  CallableIndex,
  CandidateSelectionOptions,
} from "./types";

interface CandidateConstraint {
  set: Set<CallableId>;
  rarity: number;
}

/**
 * Build an inverted index from callable entries.
 *
 * @param entries - All callable entries to index
 * @returns The built index
 */
export function buildCallableIndex(entries: CallableEntry[]): CallableIndex {
  const index: CallableIndex = {
    entries,
    byToken: new Map(),
    byParamToken: new Map(),
    byReturnToken: new Map(),
    byParamProp: new Map(),
    byReturnProp: new Map(),
    byMinArity: new Map(),
    exported: new Set(),
    internal: new Set(),
    ambient: new Set(),
    byFile: new Map(),
    byKind: new Map(),
    tokenDf: new Map(),
    propDf: new Map(),
    totalCallables: entries.length,
    totalExported: 0,
  };

  for (const entry of entries) {
    const id = entry.id;

    // Index by param tokens
    for (const token of entry.paramTokens) {
      addToIndex(index.byParamToken, token, id);
      addToIndex(index.byToken, token, id);
      incrementDf(index.tokenDf, token);
    }

    // Index by return tokens
    for (const token of entry.returnTokens) {
      addToIndex(index.byReturnToken, token, id);
      addToIndex(index.byToken, token, id);
      incrementDf(index.tokenDf, token);
    }

    // Index by param property keys
    for (const prop of entry.paramPropKeys) {
      addToIndex(index.byParamProp, prop, id);
      incrementDf(index.propDf, prop);
    }

    // Index by return property keys
    for (const prop of entry.returnPropKeys) {
      addToIndex(index.byReturnProp, prop, id);
      incrementDf(index.propDf, prop);
    }

    // Index by min arity
    addToIndex(index.byMinArity, entry.minArity, id);

    // Index by export state
    switch (entry.exportState) {
      case "exported":
        index.exported.add(id);
        index.totalExported++;
        break;
      case "internal":
        index.internal.add(id);
        break;
      case "ambient":
        index.ambient.add(id);
        break;
    }

    // Index by file
    addToIndex(index.byFile, entry.filePath, id);

    // Index by kind
    addToIndex(index.byKind, entry.kind, id);
  }

  return index;
}

/**
 * Helper to add an ID to a Map<K, Set<CallableId>>.
 */
function addToIndex<K>(map: Map<K, Set<CallableId>>, key: K, id: CallableId): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(id);
}

/**
 * Increment document frequency counter.
 */
function incrementDf(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Select candidate callables based on query constraints.
 * Uses rarest-first strategy for efficient filtering.
 *
 * @param index - The callable index to query
 * @param options - Selection options
 * @returns Array of matching callable IDs
 */
export function selectCandidates(
  index: CallableIndex,
  options: CandidateSelectionOptions,
): CallableId[] {
  const constraints = collectCandidateConstraints(index, options);
  const candidates = constraints.length === 0
    ? selectUnconstrainedCandidates(index, options)
    : selectConstrainedCandidates(index, options, constraints);

  return [...candidates].slice(0, options.budget);
}

function collectCandidateConstraints(
  index: CallableIndex,
  options: CandidateSelectionOptions,
): CandidateConstraint[] {
  return [
    ...constraintsForKeys(index.byParamToken, options.fromTokens ?? []),
    ...constraintsForKeys(index.byReturnToken, options.toTokens ?? []),
    ...constraintsForKeys(index.byParamProp, options.fromPropKeys ?? []),
    ...constraintsForKeys(index.byReturnProp, options.toPropKeys ?? []),
  ];
}

function constraintsForKeys<K>(
  map: Map<K, Set<CallableId>>,
  keys: K[],
): CandidateConstraint[] {
  return keys.flatMap((key) => {
    const set = map.get(key);
    return set ? [{ set, rarity: set.size }] : [];
  });
}

function selectUnconstrainedCandidates(
  index: CallableIndex,
  options: CandidateSelectionOptions,
): Set<CallableId> {
  const candidates = options.exportedOnly ?? true
    ? new Set(index.exported)
    : new Set(index.entries.map((entry) => entry.id));
  return applyOptionalCandidateFilters(candidates, index, options);
}

function selectConstrainedCandidates(
  index: CallableIndex,
  options: CandidateSelectionOptions,
  constraints: CandidateConstraint[],
): Set<CallableId> {
  const candidates = intersectConstraintsByRarity(constraints, options.budget);
  const exportedCandidates = options.exportedOnly ?? true
    ? setIntersection(candidates, index.exported)
    : candidates;
  return applyOptionalCandidateFilters(exportedCandidates, index, options);
}

function intersectConstraintsByRarity(
  constraints: CandidateConstraint[],
  budget: number,
): Set<CallableId> {
  const [first, ...remaining] = [...constraints].sort((a, b) => a.rarity - b.rarity);
  let candidates = new Set(first!.set);

  for (const constraint of remaining) {
    if (candidates.size === 0) break;
    candidates = setIntersection(candidates, constraint.set);
    if (candidates.size <= budget) break;
  }

  return candidates;
}

function applyOptionalCandidateFilters(
  candidates: Set<CallableId>,
  index: CallableIndex,
  options: CandidateSelectionOptions,
): Set<CallableId> {
  let filtered = candidates;
  if (options.kinds && options.kinds.length > 0) {
    filtered = applyKindFilter(filtered, index, options.kinds);
  }
  if (options.files && options.files.length > 0) {
    filtered = applyFileFilter(filtered, index, options.files);
  }
  return filtered;
}

/**
 * Efficient set intersection (iterates over smaller set).
 */
function setIntersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  const result = new Set<T>();
  // Iterate over the smaller set for efficiency
  const [smaller, larger] = a.size < b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) {
      result.add(item);
    }
  }
  return result;
}

/**
 * Apply kind filter to candidates.
 */
function applyKindFilter(
  candidates: Set<CallableId>,
  index: CallableIndex,
  kinds: CallableKind[],
): Set<CallableId> {
  const kindSet = new Set<CallableId>();
  for (const kind of kinds) {
    const kindIds = index.byKind.get(kind);
    if (kindIds) {
      for (const id of kindIds) {
        kindSet.add(id);
      }
    }
  }
  return setIntersection(candidates, kindSet);
}

/**
 * Apply file filter to candidates.
 */
function applyFileFilter(
  candidates: Set<CallableId>,
  index: CallableIndex,
  files: string[],
): Set<CallableId> {
  const fileSet = new Set<CallableId>();
  for (const file of files) {
    const fileIds = index.byFile.get(file);
    if (fileIds) {
      for (const id of fileIds) {
        fileSet.add(id);
      }
    }
  }
  return setIntersection(candidates, fileSet);
}

/**
 * Get an entry by ID.
 */
export function getEntry(index: CallableIndex, id: CallableId): CallableEntry | undefined {
  return index.entries[id];
}

/**
 * Get statistics about the index.
 */
export function getIndexStats(index: CallableIndex): {
  totalCallables: number;
  totalExported: number;
  uniqueTokens: number;
  uniquePropKeys: number;
  byKind: Record<string, number>;
} {
  const byKind: Record<string, number> = {};
  for (const [kind, ids] of index.byKind) {
    byKind[kind] = ids.size;
  }

  return {
    totalCallables: index.totalCallables,
    totalExported: index.totalExported,
    uniqueTokens: index.tokenDf.size,
    uniquePropKeys: index.propDf.size,
    byKind,
  };
}

/**
 * Calculate IDF (Inverse Document Frequency) score for a token.
 * Higher score = rarer token = more significant match.
 */
export function calculateIdf(index: CallableIndex, token: string): number {
  const df = index.tokenDf.get(token) ?? 0;
  if (df === 0) return 0;
  // Standard IDF formula: log(N / df)
  return Math.log(index.totalCallables / df);
}

/**
 * Calculate IDF for a property key.
 */
export function calculatePropIdf(index: CallableIndex, prop: string): number {
  const df = index.propDf.get(prop) ?? 0;
  if (df === 0) return 0;
  return Math.log(index.totalCallables / df);
}
