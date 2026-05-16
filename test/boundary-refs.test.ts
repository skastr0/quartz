import { describe, expect, it } from "vitest"
import {
  BoundaryRefError,
  parseFileRef,
  parsePackageRef,
  parseSourcePositionRef,
  parseTypeExpressionRef,
} from "../packages/core/src/boundary-refs"

describe("boundary refs", () => {
  it("constructs trimmed refs at parse boundaries", () => {
    expect(parseTypeExpressionRef("from", "  User  ")).toBe("User")
    expect(parsePackageRef("  (root)  ")).toBe("(root)")
    expect(parseFileRef("file", "  types/basic.ts  ")).toBe("types/basic.ts")
  })

  it("rejects blank refs with structured boundary errors", () => {
    expect(() => parseTypeExpressionRef("from", "   ")).toThrow(BoundaryRefError)
    expect(() => parseSourcePositionRef({ file: "types/basic.ts", line: 0, column: 1 })).toThrow(BoundaryRefError)
    expect(() => parseSourcePositionRef({ file: "types/basic.ts", line: 1, column: 0 })).toThrow(BoundaryRefError)
  })
})
