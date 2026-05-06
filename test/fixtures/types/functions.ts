/**
 * Function types for testing function signature handling.
 */

import type { User, UserInput } from "./basic.ts";

// === Function type aliases ===

export type Callback<T> = (value: T) => void;

export type AsyncCallback<T> = (value: T) => Promise<void>;

export type Predicate<T> = (value: T) => boolean;

export type Transformer<T, U> = (input: T) => U;

export type AsyncFn<T, R> = (input: T) => Promise<R>;

// === Exported functions ===

export function identity<T>(value: T): T {
  return value;
}

export function createUser(input: UserInput): User {
  return {
    id: crypto.randomUUID(),
    ...input,
  };
}

// oxlint-disable-next-line eslint(no-unused-vars)
export async function fetchUser(_id: string): Promise<User | null> {
  // Mock implementation
  return null;
}

export function isValidEmail(email: string): boolean {
  return email.includes("@");
}

// === Function overloads ===

export function parse(input: string): number;
export function parse(input: number): string;
export function parse(input: string | number): string | number {
  if (typeof input === "string") {
    return parseInt(input, 10);
  }
  return input.toString();
}

export function format(value: Date): string;
export function format(value: number): string;
export function format(value: string): string;
export function format(value: Date | number | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

// === Arrow functions ===

export const add = (a: number, b: number): number => a + b;

export const compose =
  <A, B, C>(f: (b: B) => C, g: (a: A) => B) =>
  (a: A): C =>
    f(g(a));

export const pipe =
  <T>(...fns: Array<(arg: T) => T>) =>
  (value: T): T =>
    fns.reduce((acc, fn) => fn(acc), value);

// === Higher-order functions ===

export function withLogging<T extends (...args: unknown[]) => unknown>(
  fn: T,
): (...args: Parameters<T>) => ReturnType<T> {
  return (...args: Parameters<T>): ReturnType<T> => {
    console.log("Calling with:", args);
    const result = fn(...args) as ReturnType<T>;
    console.log("Result:", result);
    return result;
  };
}

export function localUserFactory(): User {
  const localUser: User = {
    id: "local",
    name: "Local",
    email: "local@example.com",
  };
  return localUser;
}

export function memoize<T extends (...args: unknown[]) => unknown>(fn: T): T {
  const cache = new Map<string, ReturnType<T>>();
  return ((...args: Parameters<T>): ReturnType<T> => {
    const key = JSON.stringify(args);
    if (cache.has(key)) {
      return cache.get(key)!;
    }
    const result = fn(...args) as ReturnType<T>;
    cache.set(key, result);
    return result;
  }) as T;
}

// === Rest parameters ===

export function sum(...numbers: number[]): number {
  return numbers.reduce((acc, n) => acc + n, 0);
}

export function merge<T extends object>(...objects: T[]): T {
  return Object.assign({}, ...objects);
}

// === Optional and default parameters ===

export function greet(name: string, greeting = "Hello"): string {
  return `${greeting}, ${name}!`;
}

export function createConfig(options?: { debug?: boolean; timeout?: number }): {
  debug: boolean;
  timeout: number;
} {
  return {
    debug: options?.debug ?? false,
    timeout: options?.timeout ?? 5000,
  };
}
