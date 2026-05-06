/**
 * Types for testing refactor preview functionality.
 * Contains types with properties that will be renamed.
 */

// === Base interface with email property ===

/**
 * User interface with email property.
 * The email field is used throughout the application.
 */
export interface RefactorUser {
  id: string;
  name: string;
  email: string; // This is the primary email
}

// === Types that reference RefactorUser ===

export interface RefactorUserInput {
  name: string;
  email: string;
}

export interface RefactorUserResponse {
  user: RefactorUser;
  token: string;
}

// === Function using the type ===

export function createRefactorUser(input: RefactorUserInput): RefactorUser {
  return {
    id: "generated-id",
    name: input.name,
    email: input.email,
  };
}

// === Class with the property ===

export class RefactorUserService {
  // Create a new user with email validation
  createUser(email: string, name: string): RefactorUser {
    return {
      id: crypto.randomUUID(),
      name,
      email,
    };
  }

  // Get user by email
  getUserByEmail(_email: string): RefactorUser | null {
    // In real code, this would query a database
    return null;
  }
}

// === String literals containing "email" (won't be auto-renamed) ===

export const EMAIL_FIELD_NAME = "email";
export const REFACTOR_FIELDS = ["id", "name", "email"];
export const ERROR_MESSAGES = {
  invalidEmail: "Invalid email format",
  emailRequired: "email is required",
};

// === Type with nested email reference ===

export interface RefactorUserProfile {
  user: RefactorUser;
  preferences: {
    emailNotifications: boolean;
    displayEmail: boolean;
  };
}

export interface DuplicateSnippetType {
  source: "refactor";
}

// === Re-export for testing cross-file references ===

export type { RefactorUser as RefactorableUser };
