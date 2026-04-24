/**
 * Class types for testing class handling.
 */

import type { User, UserInput } from "./basic.ts";

// === Basic class ===

export class UserService {
  private users: Map<string, User> = new Map();

  constructor(private readonly prefix: string = "user") {}

  getUser(id: string): User | null {
    return this.users.get(id) ?? null;
  }

  createUser(input: UserInput): User {
    const user: User = {
      id: `${this.prefix}_${Date.now()}`,
      ...input,
    };
    this.users.set(user.id, user);
    return user;
  }

  deleteUser(id: string): boolean {
    return this.users.delete(id);
  }

  listUsers(): User[] {
    return Array.from(this.users.values());
  }
}

// === Abstract class ===

export abstract class BaseEntity {
  abstract readonly id: string;
  readonly createdAt: Date = new Date();
  updatedAt: Date = new Date();

  abstract validate(): boolean;

  touch(): void {
    this.updatedAt = new Date();
  }
}

// === Class with inheritance ===

export class UserEntity extends BaseEntity {
  readonly id: string;
  name: string;
  email: string;

  constructor(id: string, name: string, email: string) {
    super();
    this.id = id;
    this.name = name;
    this.email = email;
  }

  validate(): boolean {
    return this.email.includes("@") && this.name.length > 0;
  }
}

// === Class implementing interface ===

export interface Serializable {
  serialize(): string;
  deserialize(data: string): void;
}

export interface Comparable<T> {
  compareTo(other: T): number;
}

export class SortableUser implements Serializable, Comparable<SortableUser> {
  constructor(
    public id: string,
    public name: string,
    public priority: number,
  ) {}

  serialize(): string {
    return JSON.stringify({ id: this.id, name: this.name, priority: this.priority });
  }

  deserialize(data: string): void {
    const parsed = JSON.parse(data);
    this.id = parsed.id;
    this.name = parsed.name;
    this.priority = parsed.priority;
  }

  compareTo(other: SortableUser): number {
    return this.priority - other.priority;
  }
}

// === Generic class ===

export class Container<T> {
  private items: T[] = [];

  add(item: T): void {
    this.items.push(item);
  }

  get(index: number): T | undefined {
    return this.items[index];
  }

  getAll(): T[] {
    return [...this.items];
  }

  find(predicate: (item: T) => boolean): T | undefined {
    return this.items.find(predicate);
  }

  map<U>(fn: (item: T) => U): Container<U> {
    const result = new Container<U>();
    for (const item of this.items) {
      result.add(fn(item));
    }
    return result;
  }
}

// === Static members ===

export class Counter {
  private static count = 0;
  readonly id: number;

  constructor() {
    this.id = Counter.count++;
  }

  static getCount(): number {
    return Counter.count;
  }

  static reset(): void {
    Counter.count = 0;
  }
}

// === Private constructor (singleton pattern) ===

export class Singleton {
  private static instance: Singleton | null = null;
  readonly timestamp: Date;

  private constructor() {
    this.timestamp = new Date();
  }

  static getInstance(): Singleton {
    if (!Singleton.instance) {
      Singleton.instance = new Singleton();
    }
    return Singleton.instance;
  }
}

// === Class with accessors ===

export class Person {
  private _age: number;

  constructor(
    public readonly firstName: string,
    public readonly lastName: string,
    age: number,
  ) {
    this._age = age;
  }

  get fullName(): string {
    return `${this.firstName} ${this.lastName}`;
  }

  get age(): number {
    return this._age;
  }

  set age(value: number) {
    if (value < 0) throw new Error("Age cannot be negative");
    this._age = value;
  }
}

// === Generic Service Pattern (for transform search testing) ===

export interface Entity {
  id: string;
}

export interface WorkflowInput extends Entity {
  name: string;
}

export interface WorkflowOutput extends Entity {
  result: string;
}

export class WorkflowBaseService<T extends Entity> {
  duplicate(entity: T): T {
    return { ...entity } as T;
  }

  process(input: WorkflowInput): WorkflowOutput {
    return { id: input.id, result: input.name };
  }
}

export class ConcreteWorkflowService extends WorkflowBaseService<WorkflowInput> {
  // Inherits methods with T = WorkflowInput
}
