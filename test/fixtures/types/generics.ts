/**
 * Generic types for testing generic type handling.
 */

// === Basic generics ===

export interface Box<T> {
  value: T;
}

export interface Pair<A, B> {
  first: A;
  second: B;
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type Nullable<T> = T | null;

export type Optional<T> = T | undefined;

// === Constrained generics ===

export interface Repository<T extends { id: string }> {
  findById(id: string): T | null;
  save(entity: T): T;
  delete(id: string): boolean;
}

export type KeyOf<T> = keyof T;

export type ValueOf<T> = T[keyof T];

// === Mapped types ===

export type ReadonlyDeep<T> = {
  readonly [K in keyof T]: T[K] extends object ? ReadonlyDeep<T[K]> : T[K];
};

export type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

export type NullableProps<T> = {
  [K in keyof T]: T[K] | null;
};

// === Conditional types ===

export type IsString<T> = T extends string ? true : false;

export type IsArray<T> = T extends unknown[] ? true : false;

export type ExtractArrayType<T> = T extends (infer U)[] ? U : never;

export type Awaited<T> = T extends Promise<infer U> ? U : T;

// === Template literal types ===

export type EventName<T extends string> = `on${Capitalize<T>}`;

export type Getter<T extends string> = `get${Capitalize<T>}`;

export type Setter<T extends string> = `set${Capitalize<T>}`;

// === Recursive types ===

export interface TreeNode<T> {
  value: T;
  children: TreeNode<T>[];
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// === Instantiated generics (for testing) ===

export type StringBox = Box<string>;
export type NumberBox = Box<number>;
export type UserBox = Box<{ id: string; name: string }>;

export type StringNumberPair = Pair<string, number>;
export type StringResult = Result<string, Error>;
