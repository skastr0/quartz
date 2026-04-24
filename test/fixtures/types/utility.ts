/**
 * Utility type compositions for testing type_eval and type_expand.
 */

import type { User, UserInput, ExtendedUser, Address, Role } from "./basic.ts";

// === Pick compositions ===

export type UserSummary = Pick<User, "id" | "name">;

export type UserCredentials = Pick<User, "email"> & { password: string };

export type ExtendedUserBasics = Pick<ExtendedUser, "id" | "name" | "role">;

// === Omit compositions ===

export type CreateUserDTO = Omit<User, "id">;

export type UpdateUserDTO = Omit<User, "id" | "email">;

export type UserWithoutEmail = Omit<ExtendedUser, "email">;

// === Partial compositions ===

export type PartialUserUpdate = Partial<Omit<User, "id">>;

export type DeepPartialUser = {
  [K in keyof User]?: User[K] extends object ? Partial<User[K]> : User[K];
};

// === Required compositions ===

export type RequiredUserInput = Required<UserInput>;

export type StrictAddress = Required<Address>;

// === Readonly compositions ===

export type ImmutableUser = Readonly<User>;

export type DeepReadonlyUser = {
  readonly [K in keyof User]: User[K] extends object ? Readonly<User[K]> : User[K];
};

// === Record types ===

export type RolePermissions = Record<Role, string[]>;

export type UserById = Record<string, User>;

export type StatusMap = Record<"pending" | "active" | "inactive", number>;

// === Extract / Exclude ===

export type AdminOrUser = Extract<Role, "admin" | "user">;

export type NonAdminRole = Exclude<Role, "admin">;

export type NonNullableUser = NonNullable<User | null | undefined>;

// === ReturnType / Parameters ===

type CreateUserFn = (input: UserInput) => User;

export type CreateUserReturn = ReturnType<CreateUserFn>;

export type CreateUserParams = Parameters<CreateUserFn>;

export type FirstParam<T extends (...args: unknown[]) => unknown> = Parameters<T>[0];

// === Complex compositions ===

export type UserPatch = Partial<Pick<User, "name" | "email">>;

export type CreateExtendedUserDTO = Omit<ExtendedUser, "id" | "createdAt">;

export type ReadonlyUserSummary = Readonly<Pick<User, "id" | "name">>;

export type UserOrInputUnion = User | UserInput;

export type UserAndInputIntersection = User & { inputSource: string };

// === Nested utility types ===

export type OptionalExceptId = Partial<Omit<User, "id">> & Pick<User, "id">;

export type RequiredName = Required<Pick<User, "name">> & Omit<User, "name">;

// === Mapped type with conditions ===

export type NullableStrings<T> = {
  [K in keyof T]: T[K] extends string ? T[K] | null : T[K];
};

export type NullableUserStrings = NullableStrings<User>;

// === Infer in conditional ===

export type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;

export type UnwrapArray<T> = T extends (infer U)[] ? U : T;

export type FunctionReturn<T> = T extends (...args: unknown[]) => infer R ? R : never;
