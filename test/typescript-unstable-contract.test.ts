/**
 * Compile-time + runtime contract for the unstable TypeScript APIs Quartz consumes.
 * Fails loudly when a nightly removes or renames a required surface.
 */
import { describe, expect, it } from "vitest"
import { typescriptVersion, version } from "tsrs"
import { API, Checker, LanguageService, Program } from "tsrs/unstable/async"
import type { NodeHandle, Project, Snapshot } from "tsrs/unstable/async"
import type { Declaration } from "tsrs/unstable/ast"

describe("typescript unstable API contract", () => {
  it("pins a concrete tsrs release built from a 7.x nightly (never a moving tag)", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+-ts7\.\d+\.\d+-dev\.\d{8}$/)
    expect(typescriptVersion).toMatch(/^7\.\d+\.\d+-dev\.\d{8}$/)
  })

  it("exposes the workspace lifecycle methods Quartz uses", () => {
    const proto = API.prototype as API
    expect(typeof proto.createSnapshot).toBe("function")
    expect(typeof proto.close).toBe("function")
    expect(typeof proto.clearSourceFileCache).toBe("function")
    expect(typeof proto.getTimingInfo).toBe("function")
    expect(typeof proto.resetTimingInfo).toBe("function")
  })

  it("exposes runWithTemporaryFileUpdate for ephemeral analysis", () => {
    const proto = API.prototype as API
    expect(typeof proto.runWithTemporaryFileUpdate).toBe("function")
  })

  it("exposes the compiler services used by existing Quartz workflows", () => {
    expect(typeof LanguageService.prototype.getReferencedSymbolsForNode).toBe("function")
    expect(typeof Checker.prototype.getSymbolOfSourceFile).toBe("function")
    expect(typeof Checker.prototype.getFullyQualifiedName).toBe("function")
    expect(typeof Checker.prototype.getTargetSymbol).toBe("function")
    expect(typeof Program.prototype.isSourceFileFromExternalLibrary).toBe("function")
    expect(typeof Program.prototype.isSourceFileDefaultLibrary).toBe("function")
  })

  it("types Snapshot project accessors used by QuartzWorkspace", () => {
    // Compile-time presence: if these renames break, tsc/vitest typecheck fails.
    type SnapshotContract = {
      getProject: Snapshot["getProject"]
      getDefaultProjectForFile: Snapshot["getDefaultProjectForFile"]
      dispose: Snapshot["dispose"]
    }
    type ProjectContract = {
      program: Project["program"]
      checker: Project["checker"]
      languageService: Project["languageService"]
    }
    type DeclarationHandle = NodeHandle<Declaration>
    const _snapshot: SnapshotContract | null = null
    const _project: ProjectContract | null = null
    const _handle: DeclarationHandle | null = null
    expect(_snapshot).toBeNull()
    expect(_project).toBeNull()
    expect(_handle).toBeNull()
  })
})
