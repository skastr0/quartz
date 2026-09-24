import { describe, expect, it } from "vitest"
import { snippetTopLevelBindings } from "../packages/engine/src/snippet-bindings"

const names = (code: string) => [...snippetTopLevelBindings(code)].sort()

describe("snippetTopLevelBindings", () => {
  it("collects import bindings", () => {
    expect(names("import type { User } from './index'")).toEqual(["User"])
    expect(names("import { toName, type Named, User as Person } from './index'")).toEqual(["Named", "Person", "toName"])
    expect(names("import api from './index'")).toEqual(["api"])
    expect(names("import api, { User } from './index'")).toEqual(["User", "api"])
    expect(names("import * as api from './index'")).toEqual(["api"])
    expect(names("import type * as api from './index'")).toEqual(["api"])
    expect(names("import fs = require('node:fs')")).toEqual(["fs"])
    expect(names("import './side-effect'")).toEqual([])
    expect(names("const lazy = await import('./index')")).toEqual(["lazy"])
  })

  it("collects top-level declarations", () => {
    expect(names("interface User { local: true }")).toEqual(["User"])
    expect(names("type Alias<T> = T[]")).toEqual(["Alias"])
    expect(names("export async function* load() {}")).toEqual(["load"])
    expect(names("declare class Box {}\nabstract class Shape {}")).toEqual(["Box", "Shape"])
    expect(names("const enum Mode { A }\nnamespace Space {}")).toEqual(["Mode", "Space"])
    expect(names("const a = 1, b = [1, 2], c = { d: 1 }")).toEqual(["a", "b", "c"])
    expect(names("let { id, name: label, ...rest } = user")).toEqual(["id", "label", "rest"])
    expect(names("var [first, , third = 3] = list")).toEqual(["first", "third"])
  })

  it("ignores nested scopes, strings, comments, and templates", () => {
    expect(names("function outer() { const inner = 1; interface Hidden {} }")).toEqual(["outer"])
    expect(names("const text = `const hidden = ${ { value: 1 }.value }`")).toEqual(["text"])
    expect(names("// const commented = 1\n/* interface Gone {} */\nconst kept = 'const quoted = 1'")).toEqual(["kept"])
    expect(names("declare global { interface Global {} }\nexport {}")).toEqual([])
    expect(names("const type = 1\ntype.toFixed()")).toEqual(["type"])
  })
})
