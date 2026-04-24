/**
 * Transform-specific fixtures for testing type_transform_search.
 * Covers various callable patterns and edge cases.
 */

import type { User, UserInput, ExtendedUser, Address } from "./basic.ts";

// === Domain types for transform testing ===

export interface UserDTO {
  id: string;
  displayName: string;
  emailAddress: string;
}

export interface CreateUserRequest {
  name: string;
  email: string;
  role?: string;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  timestamp: Date;
}

// === Simple transforms ===

export function toDTO(from: User): UserDTO {
  return {
    id: from.id,
    displayName: from.name,
    emailAddress: from.email,
  };
}

export function fromDTO(dto: UserDTO): User {
  return {
    id: dto.id,
    name: dto.displayName,
    email: dto.emailAddress,
  };
}

export function toUserInput(input: CreateUserRequest): UserInput {
  return {
    name: input.name,
    email: input.email,
  };
}

// === Async transforms ===

export async function fetchUserById(id: string): Promise<User> {
  // Mock implementation
  return { id, name: "Test", email: "test@example.com" };
}

export async function saveUser(data: User): Promise<UserDTO> {
  // Mock implementation
  return toDTO(data);
}

export async function getUserWithAddress(
  userId: string,
): Promise<ExtendedUser & { address: Address }> {
  return {
    id: userId,
    name: "Test",
    email: "test@example.com",
    createdAt: new Date(),
    role: "user",
    address: {
      street: "123 Main St",
      city: "Anytown",
      country: "USA",
    },
  };
}

// === Generic transforms ===

export function mapToDTO<T, U>(item: T, mapper: (t: T) => U): U {
  return mapper(item);
}

export function wrapInResponse<T>(data: T): ApiResponse<T> {
  return {
    data,
    status: 200,
    timestamp: new Date(),
  };
}

export function unwrapResponse<T>(response: ApiResponse<T>): T {
  return response.data;
}

// === Multi-param transforms ===

export function mergeUsers(base: User, updates: Partial<User>): User {
  return { ...base, ...updates };
}

export function createUserWithRole(input: UserInput, role: string): ExtendedUser {
  return {
    id: crypto.randomUUID(),
    ...input,
    createdAt: new Date(),
    role: role as "admin" | "user" | "guest",
  };
}

export function formatUserName(user: User, format: "full" | "short"): string {
  return format === "full" ? `${user.name} <${user.email}>` : user.name;
}

// === Array transforms ===

export function extractIds(items: User[]): string[] {
  return items.map((u) => u.id);
}

export function filterByEmail(users: User[], domain: string): User[] {
  return users.filter((u) => u.email.endsWith(domain));
}

// === Class with transform methods ===

export class UserMapper {
  constructor(private readonly prefix: string = "") {}

  toDTO(user: User): UserDTO {
    return {
      id: this.prefix + user.id,
      displayName: user.name,
      emailAddress: user.email,
    };
  }

  fromDTO(dto: UserDTO): User {
    const id = dto.id.startsWith(this.prefix) ? dto.id.slice(this.prefix.length) : dto.id;
    return {
      id,
      name: dto.displayName,
      email: dto.emailAddress,
    };
  }

  static createDefault(): UserMapper {
    return new UserMapper("default_");
  }
}

// === Object with methods ===

export const dataTransforms = {
  toUpperCase(item: User): User {
    return {
      ...item,
      name: item.name.toUpperCase(),
      email: item.email.toUpperCase(),
    };
  },

  addTimestamp(item: User): ExtendedUser {
    return {
      ...item,
      createdAt: new Date(),
      role: "user",
    };
  },
};

// === Higher-order transforms ===

export function createTransformer<T, U>(fn: (t: T) => U): (items: T[]) => U[] {
  return (items) => items.map(fn);
}

export function pipeTransform<A, B, C>(f: (a: A) => B, g: (b: B) => C): (a: A) => C {
  return (a) => g(f(a));
}

// === Deprecated function ===

/**
 * @deprecated Use toDTO instead
 */
export function deprecatedToDTO(item: User): UserDTO {
  return toDTO(item);
}

// === Internal (non-exported) functions ===

// oxlint-disable-next-line eslint(no-unused-vars)
function internalTransform(user: User): string {
  return JSON.stringify(user);
}

// === Unannotated function (for testing trust issues) ===
// This function has explicit any to represent legacy/untyped code patterns
// oxlint-disable-next-line eslint(no-unused-vars)
export function processDataUntyped(input: any) {
  return input.map((x: any) => x.name);
}

// === Overloaded function ===

export function transform(input: User): UserDTO;
export function transform(input: UserDTO): User;
export function transform(input: User | UserDTO): User | UserDTO {
  if ("displayName" in input) {
    return fromDTO(input);
  }
  return toDTO(input);
}

// === Union return types ===

export function parseUserOrError(json: string): User | Error {
  try {
    return JSON.parse(json) as User;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

// === Callable interface ===

export interface UserFactory {
  (input: UserInput): User;
  fromDTO(dto: UserDTO): User;
}

// === Primitive type transforms (for testing built-in type support) ===

export function parseDate(dateString: string): Date {
  return new Date(dateString);
}

export function formatTimestamp(date: Date): string {
  return date.toISOString();
}

export function parseNumber(value: string): number {
  return parseInt(value, 10);
}

export function numberToString(value: number): string {
  return value.toString();
}

export function isPositive(n: number): boolean {
  return n > 0;
}

// === Type erasure fixtures (for testing any/unknown filtering) ===

// These functions use any/unknown and should be excluded by default

export function processAny(input: any): User {
  return input as User;
}

export function processUnknown(input: unknown): UserDTO {
  return input as UserDTO;
}

export function returnsAny(user: User): any {
  return { ...user, extra: "data" };
}

export function returnsUnknown(user: User): unknown {
  return user;
}

// Mixed: takes specific type but returns any
export function UserToAny(user: User): any {
  return JSON.parse(JSON.stringify(user));
}

// Mixed: takes any but returns specific type
export function anyToDTO(input: any): UserDTO {
  return {
    id: String(input.id),
    displayName: String(input.name),
    emailAddress: String(input.email),
  };
}

// === Index signature type erasure fixtures (for testing opencode-f3p) ===
// These types have index signatures with `any` that match almost anything
// They should be excluded from results when searching for specific types

/** SVGProps-like loose options type - matches almost any object */
export interface LooseProps {
  [key: string]: any;
  className?: string;
}

/** Array-like loose options with number index */
export interface LooseArrayLike {
  [key: number]: any;
  length: number;
}

/** Mixed loose type: has some specific props but also accepts anything */
export interface PartiallyLooseProps {
  id: string;
  [key: string]: any;
}

// Functions with loose parameter types that should be excluded
export function processLooseProps(props: LooseProps): string {
  return props.className ?? "default";
}

export function renderWithLooseProps(props: { [key: string]: any }): void {
  console.log(props);
}

export function handleArrayLike(items: LooseArrayLike): number {
  return items.length;
}

export function processPartiallyLoose(data: PartiallyLooseProps): string {
  return data.id;
}

// Functions that return loose types (should be excluded when searching by "to")
export function toLooseProps(user: User): LooseProps {
  return { className: user.name, id: user.id };
}

export function toAnyRecord(user: User): { [key: string]: any } {
  return { ...user };
}
