const boundaryRefBrand: unique symbol = Symbol("quartz.boundaryRef");

export type BoundaryRefKind =
  | "ProjectRoot"
  | "PackageRef"
  | "SymbolRef"
  | "FileRef"
  | "TypeExpression"
  | "SourcePosition";

export type BoundaryRef<K extends BoundaryRefKind> = string & {
  readonly [boundaryRefBrand]: K;
};

export type ProjectRootRef = BoundaryRef<"ProjectRoot">;
export type PackageRef = BoundaryRef<"PackageRef">;
export type SymbolRef = BoundaryRef<"SymbolRef">;
export type FileRef = BoundaryRef<"FileRef">;
export type TypeExpressionRef = BoundaryRef<"TypeExpression">;

export interface SourcePositionRef {
  readonly file: FileRef;
  readonly line: number;
  readonly column: number;
}

export class BoundaryRefError extends Error {
  readonly kind: BoundaryRefKind;
  readonly field: string;
  readonly received: unknown;

  constructor(kind: BoundaryRefKind, field: string, received: unknown) {
    super(`${field} must be a non-empty ${kind}`);
    this.name = "BoundaryRefError";
    this.kind = kind;
    this.field = field;
    this.received = received;
  }
}

export const parseBoundaryRef = <K extends BoundaryRefKind>(
  kind: K,
  field: string,
  value: string,
): BoundaryRef<K> => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BoundaryRefError(kind, field, value);
  }
  return trimmed as BoundaryRef<K>;
};

export const parseOptionalBoundaryRef = <K extends BoundaryRefKind>(
  kind: K,
  field: string,
  value: string | undefined,
): BoundaryRef<K> | undefined =>
  value === undefined ? undefined : parseBoundaryRef(kind, field, value);

export const parseProjectRootRef = (value: string): ProjectRootRef =>
  parseBoundaryRef("ProjectRoot", "root", value);

export const parsePackageRef = (value: string): PackageRef =>
  parseBoundaryRef("PackageRef", "packageName", value);

export const parseSymbolRef = (field: string, value: string): SymbolRef =>
  parseBoundaryRef("SymbolRef", field, value);

export const parseFileRef = (field: string, value: string): FileRef =>
  parseBoundaryRef("FileRef", field, value);

export const parseTypeExpressionRef = (field: string, value: string): TypeExpressionRef =>
  parseBoundaryRef("TypeExpression", field, value);

export const parseSourcePositionRef = (
  input: { readonly file: string; readonly line: number; readonly column: number },
): SourcePositionRef => {
  if (!Number.isInteger(input.line) || input.line <= 0) {
    throw new BoundaryRefError("SourcePosition", "line", input.line);
  }
  if (!Number.isInteger(input.column) || input.column <= 0) {
    throw new BoundaryRefError("SourcePosition", "column", input.column);
  }
  return {
    file: parseFileRef("file", input.file),
    line: input.line,
    column: input.column,
  };
};
