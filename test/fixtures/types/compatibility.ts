/**
 * Types specifically designed for testing type_compatible.
 * Each pair documents the expected compatibility result.
 */

// ============================================
// STRUCTURAL COMPATIBILITY
// ============================================

// --- Missing required property ---
// Source1 -> Target1: INCOMPATIBLE (missing 'id')
export interface Source1 {
  name: string;
}

export interface Target1 {
  name: string;
  id: string;
}

// --- Extra properties allowed ---
// Source2 -> Target2: COMPATIBLE (extra props ok in structural typing)
export interface Source2 {
  name: string;
  id: string;
  extraField: number;
}

export interface Target2 {
  name: string;
  id: string;
}

// --- Optional vs required ---
// Source3 -> Target3: INCOMPATIBLE (optional 'id' can't satisfy required)
export interface Source3 {
  name: string;
  id?: string;
}

export interface Target3 {
  name: string;
  id: string;
}

// --- Required to optional ---
// Source4 -> Target4: COMPATIBLE (required satisfies optional)
export interface Source4 {
  name: string;
  id: string;
}

export interface Target4 {
  name: string;
  id?: string;
}

// ============================================
// TYPE WIDENING / NARROWING
// ============================================

// --- Literal to general ---
// Source5 -> Target5: COMPATIBLE (literal assignable to string)
export interface Source5 {
  status: "active";
}

export interface Target5 {
  status: string;
}

// --- General to literal ---
// Source6 -> Target6: INCOMPATIBLE (string not assignable to literal)
export interface Source6 {
  status: string;
}

export interface Target6 {
  status: "active" | "inactive";
}

// --- Union compatibility ---
// Source7 -> Target7: INCOMPATIBLE (wider union)
export interface Source7 {
  value: string | number | boolean;
}

export interface Target7 {
  value: string | number;
}

// --- Narrower union ---
// Source8 -> Target8: COMPATIBLE (narrower union fits wider)
export interface Source8 {
  value: string;
}

export interface Target8 {
  value: string | number;
}

// ============================================
// NESTED OBJECTS
// ============================================

// --- Nested missing property ---
// Source9 -> Target9: INCOMPATIBLE (nested 'zipCode' missing and required)
export interface Source9 {
  user: {
    name: string;
    address: {
      city: string;
    };
  };
}

export interface Target9 {
  user: {
    name: string;
    address: {
      city: string;
      zipCode: string;
    };
  };
}

// --- Nested compatible ---
// Source10 -> Target10: COMPATIBLE
export interface Source10 {
  user: {
    name: string;
    address: {
      city: string;
      zipCode: string;
      extra: boolean;
    };
  };
}

export interface Target10 {
  user: {
    name: string;
    address: {
      city: string;
      zipCode: string;
    };
  };
}

// ============================================
// FUNCTION TYPES
// ============================================

// --- Parameter contravariance ---
// FnSource1 -> FnTarget1: Check function compatibility
export type FnSource1 = (x: string) => void;
export type FnTarget1 = (x: string | number) => void;

// --- Return type covariance ---
// FnSource2 -> FnTarget2: INCOMPATIBLE (return type too narrow for target)
export type FnSource2 = (x: string) => string | number;
export type FnTarget2 = (x: string) => string;

// --- Compatible function ---
// FnSource3 -> FnTarget3: COMPATIBLE
export type FnSource3 = (x: string) => string;
export type FnTarget3 = (x: string) => string | number;

// ============================================
// ARRAYS AND TUPLES
// ============================================

// --- Array element type ---
// ArraySource1 -> ArrayTarget1: INCOMPATIBLE
export interface ArraySource1 {
  items: (string | number)[];
}

export interface ArrayTarget1 {
  items: string[];
}

// --- Compatible arrays ---
// ArraySource2 -> ArrayTarget2: COMPATIBLE
export interface ArraySource2 {
  items: string[];
}

export interface ArrayTarget2 {
  items: (string | number)[];
}

// --- Tuple to array ---
// TupleSource -> ArrayTarget: COMPATIBLE
export type TupleSource = [string, number];
export type ArrayTarget = (string | number)[];

// ============================================
// READONLY MODIFIERS
// ============================================

// --- Mutable to readonly ---
// MutableSource -> ReadonlyTarget: COMPATIBLE
export interface MutableSource {
  name: string;
}

export interface ReadonlyTarget {
  readonly name: string;
}

// --- Readonly to mutable ---
// ReadonlySource -> MutableTarget: COMPATIBLE (readonly is assignable to mutable)
export interface ReadonlySource {
  readonly name: string;
}

export interface MutableTarget {
  name: string;
}

// ============================================
// GENERIC INSTANTIATIONS
// ============================================

export interface GenericBox<T> {
  value: T;
}

// --- Same generic instantiation ---
// BoxSource1 -> BoxTarget1: COMPATIBLE
export type BoxSource1 = GenericBox<string>;
export type BoxTarget1 = GenericBox<string>;

// --- Different generic instantiation ---
// BoxSource2 -> BoxTarget2: INCOMPATIBLE
export type BoxSource2 = GenericBox<string>;
export type BoxTarget2 = GenericBox<number>;

// ============================================
// CALLABLE TYPES
// ============================================

// --- Object with call signature ---
// CallableSource -> CallableTarget: test callable compatibility
export interface CallableSource {
  (): string;
  name: string;
}

export interface CallableTarget {
  (): string | number;
  name: string;
}

// --- Non-callable to callable ---
// NonCallable -> Callable: INCOMPATIBLE
export interface NonCallable {
  name: string;
}

export interface Callable {
  (): void;
  name: string;
}
