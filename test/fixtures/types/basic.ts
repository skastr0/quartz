/**
 * Basic types for testing core functionality.
 * These types are used across multiple test files.
 */

// === Simple interfaces ===

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface UserInput {
  name: string;
  email: string;
}

export interface PartialUser {
  id?: string;
  name?: string;
  email?: string;
}

export interface ExtendedUser extends User {
  createdAt: Date;
  role: Role;
}

// === Type aliases ===

export type Role = "admin" | "user" | "guest";

export type UserId = string;

export type UserOrNull = User | null;

export type UserArray = User[];

// === Nested types ===

export interface Address {
  street: string;
  city: string;
  country: string;
  zipCode?: string;
}

export interface UserWithAddress extends User {
  address: Address;
}

// === Index signatures ===

export interface StringMap {
  [key: string]: string;
}

export interface UserRecord {
  [userId: string]: User;
}

export interface DuplicateSnippetType {
  source: "basic";
}

// === Readonly ===

export interface ReadonlyUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

// === Private/internal (not exported) ===
// These are intentionally unused - they test detection of non-exported declarations
// oxlint-disable-next-line eslint(no-unused-vars)
interface InternalConfig {
  secret: string;
  apiKey: string;
}

// oxlint-disable-next-line eslint(no-unused-vars)
const internalHelper = (_x: number): number => _x * 2;

// === Default export ===

export default class DefaultExportedClass {
  value: string;

  constructor(value: string) {
    this.value = value;
  }

  getValue(): string {
    return this.value;
  }
}
