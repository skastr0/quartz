/**
 * Callable Enumeration
 *
 * Enumerate all callable declarations in a TypeScript package.
 * This is Layer A of the indexing architecture - finding every
 * "callable thing" in the codebase without invoking the type checker.
 */

import {
  type SourceFile,
  type Node,
  type VariableDeclaration,
  type PropertySignature,
  type PropertyAssignment,
  type MethodSignature,
  type ShorthandPropertyAssignment,
  type GetAccessorDeclaration,
  type SetAccessorDeclaration,
  type MethodDeclaration,
  type FunctionDeclaration,
  type ConstructorDeclaration,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type TypeAliasDeclaration,
  type VariableStatement,
  type ObjectLiteralExpression,
  SyntaxKind,
} from "ts-morph";
import { relative } from "path";

import type {
  CallableEntry,
  CallableKind,
  ExportState,
  EnumerationResult,
  EnumerationStats,
} from "./types";

interface EnumerationAccumulator {
  entries: CallableEntry[];
  stats: EnumerationStats;
  nextId: number;
}

interface SourceEnumerationContext {
  filePath: string;
  isDeclarationFile: boolean;
}

/**
 * Enumerate all callables in the given source files.
 *
 * @param sourceFiles - Source files to scan
 * @param packagePath - Root path of the package (for relative paths)
 * @returns Enumeration result with all callable entries and stats
 */
export function enumerateCallables(
  sourceFiles: SourceFile[],
  packagePath: string,
): EnumerationResult {
  const acc = createEnumerationAccumulator();

  for (const sf of sourceFiles) {
    if (sf.isInNodeModules()) continue;
    enumerateSourceFile(acc, sf, packagePath);
  }

  acc.stats.total = acc.entries.length;

  return { entries: acc.entries, stats: acc.stats };
}

function createEnumerationAccumulator(): EnumerationAccumulator {
  return {
    entries: [],
    nextId: 0,
    stats: {
      functions: 0,
      variableCallables: 0,
      classMethods: 0,
      staticMethods: 0,
      constructors: 0,
      objectMethods: 0,
      interfaceMethods: 0,
      typeLiteralMethods: 0,
      callableProperties: 0,
      total: 0,
    },
  };
}

function enumerateSourceFile(
  acc: EnumerationAccumulator,
  sf: SourceFile,
  packagePath: string,
): void {
  const absolutePath = sf.getFilePath();
  const context: SourceEnumerationContext = {
    filePath: relativePath(absolutePath, packagePath),
    isDeclarationFile: absolutePath.endsWith(".d"),
  };

  enumerateFunctions(acc, sf, context);
  enumerateVariableCallables(acc, sf, context);
  enumerateClassMembers(acc, sf, context);
  enumerateInterfaceMembers(acc, sf, context);
  enumerateTypeLiteralMembers(acc, sf, context);
  enumerateObjectLiteralMethods(acc, sf, context);
}

function appendEntry(
  acc: EnumerationAccumulator,
  entry: CallableEntry | null,
  stat: keyof Omit<EnumerationStats, "total">,
): void {
  if (!entry) return;
  acc.entries.push(entry);
  acc.stats[stat]++;
}

function nextEntryId(acc: EnumerationAccumulator): number {
  return acc.nextId++;
}

function enumerateFunctions(
  acc: EnumerationAccumulator,
  sf: SourceFile,
  context: SourceEnumerationContext,
): void {
  for (const func of sf.getFunctions()) {
    appendEntry(
      acc,
      createFunctionEntry(nextEntryId(acc), func, context.filePath, context.isDeclarationFile),
      "functions",
    );
  }
}

function enumerateVariableCallables(
  acc: EnumerationAccumulator,
  sf: SourceFile,
  context: SourceEnumerationContext,
): void {
  for (const varStmt of sf.getVariableStatements()) {
    for (const varDecl of varStmt.getDeclarations()) {
      if (!isCallableInitializer(varDecl)) continue;
      appendEntry(
        acc,
        createVariableCallableEntry(
          nextEntryId(acc),
          varDecl,
          varStmt,
          context.filePath,
          context.isDeclarationFile,
        ),
        "variableCallables",
      );
    }
  }
}

function enumerateClassMembers(
  acc: EnumerationAccumulator,
  sf: SourceFile,
  context: SourceEnumerationContext,
): void {
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? "anonymous";
    enumerateClassMethods(acc, cls, className, context);
    enumerateClassConstructors(acc, cls, className, context);
  }
}

function enumerateClassMethods(
  acc: EnumerationAccumulator,
  cls: ClassDeclaration,
  className: string,
  context: SourceEnumerationContext,
): void {
  for (const method of cls.getMethods()) {
    const isStatic = method.isStatic();
    const kind: CallableKind = isStatic ? "StaticMethod" : "ClassMethod";
    appendEntry(
      acc,
      createMethodEntry(nextEntryId(acc), kind, method, className, context.filePath, cls),
      isStatic ? "staticMethods" : "classMethods",
    );
  }
}

function enumerateClassConstructors(
  acc: EnumerationAccumulator,
  cls: ClassDeclaration,
  className: string,
  context: SourceEnumerationContext,
): void {
  for (const ctor of cls.getConstructors()) {
    appendEntry(
      acc,
      createConstructorEntry(nextEntryId(acc), ctor, className, context.filePath, cls),
      "constructors",
    );
  }
}

function enumerateInterfaceMembers(
  acc: EnumerationAccumulator,
  sf: SourceFile,
  context: SourceEnumerationContext,
): void {
  for (const iface of sf.getInterfaces()) {
    const ifaceName = iface.getName();
    enumerateInterfaceMethods(acc, iface, ifaceName, context);
    enumerateInterfaceCallableProperties(acc, iface, ifaceName, context);
  }
}

function enumerateInterfaceMethods(
  acc: EnumerationAccumulator,
  iface: InterfaceDeclaration,
  ifaceName: string,
  context: SourceEnumerationContext,
): void {
  for (const method of iface.getMethods()) {
    appendEntry(
      acc,
      createInterfaceMethodEntry(nextEntryId(acc), method, ifaceName, context.filePath, iface),
      "interfaceMethods",
    );
  }
}

function enumerateInterfaceCallableProperties(
  acc: EnumerationAccumulator,
  iface: InterfaceDeclaration,
  ifaceName: string,
  context: SourceEnumerationContext,
): void {
  for (const prop of iface.getProperties()) {
    if (!hasCallableType(prop)) continue;
    appendEntry(
      acc,
      createCallablePropertyEntry(nextEntryId(acc), prop, ifaceName, context.filePath, iface),
      "callableProperties",
    );
  }
}

function enumerateTypeLiteralMembers(
  acc: EnumerationAccumulator,
  sf: SourceFile,
  context: SourceEnumerationContext,
): void {
  for (const typeAlias of sf.getTypeAliases()) {
    const typeNode = typeAlias.getTypeNode();
    if (typeNode?.getKind() !== SyntaxKind.TypeLiteral) continue;

    const typeName = typeAlias.getName();
    for (const member of typeNode.forEachChildAsArray()) {
      enumerateTypeLiteralMember(acc, member, typeName, typeAlias, context);
    }
  }
}

function enumerateTypeLiteralMember(
  acc: EnumerationAccumulator,
  member: Node,
  typeName: string,
  typeAlias: TypeAliasDeclaration,
  context: SourceEnumerationContext,
): void {
  if (member.getKind() === SyntaxKind.MethodSignature) {
    appendEntry(
      acc,
      createTypeLiteralMethodEntry(
        nextEntryId(acc),
        member as MethodSignature,
        typeName,
        context.filePath,
        typeAlias,
      ),
      "typeLiteralMethods",
    );
    return;
  }

  if (member.getKind() !== SyntaxKind.PropertySignature) return;

  const propSig = member as PropertySignature;
  if (!hasCallableType(propSig)) return;
  appendEntry(
    acc,
    createTypeLiteralCallablePropertyEntry(
      nextEntryId(acc),
      propSig,
      typeName,
      context.filePath,
      typeAlias,
    ),
    "callableProperties",
  );
}

function enumerateObjectLiteralMethods(
  acc: EnumerationAccumulator,
  sf: SourceFile,
  context: SourceEnumerationContext,
): void {
  for (const varStmt of sf.getVariableStatements()) {
    if (!isExported(varStmt)) continue;

    for (const varDecl of varStmt.getDeclarations()) {
      const init = varDecl.getInitializer();
      if (init?.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;

      const objLit = init as ObjectLiteralExpression;
      const objName = varDecl.getName();
      for (const prop of objLit.getProperties()) {
        if (!isCallableProperty(prop)) continue;
        appendEntry(
          acc,
          createObjectMethodEntry(nextEntryId(acc), prop, objName, context.filePath, varStmt),
          "objectMethods",
        );
      }
    }
  }
}

// === Helper Functions ===

/**
 * Get relative path from package root.
 */
function relativePath(absolutePath: string, packagePath: string): string {
  const rel = relative(packagePath, absolutePath);
  // Normalize to forward slashes
  return rel.replace(/\\/g, "/");
}

/**
 * Check if a variable declaration has a callable initializer.
 */
function isCallableInitializer(varDecl: VariableDeclaration): boolean {
  const init = varDecl.getInitializer();
  if (!init) return false;
  const kind = init.getKind();
  return kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression;
}

/**
 * Check if a property signature has a function type.
 */
function hasCallableType(prop: PropertySignature): boolean {
  const typeNode = prop.getTypeNode();
  if (!typeNode) return false;
  return typeNode.getKind() === SyntaxKind.FunctionType;
}

/**
 * Check if an object literal property is callable.
 */
function isCallableProperty(
  prop:
    | PropertyAssignment
    | ShorthandPropertyAssignment
    | MethodDeclaration
    | GetAccessorDeclaration
    | SetAccessorDeclaration
    | Node,
): boolean {
  const kind = prop.getKind();

  // Method definition: { method() {} }
  if (kind === SyntaxKind.MethodDeclaration) {
    return true;
  }

  // Property assignment with callable value: { handler: () => {} }
  if (kind === SyntaxKind.PropertyAssignment) {
    const propAssign = prop as PropertyAssignment;
    const init = propAssign.getInitializer();
    if (!init) return false;
    const initKind = init.getKind();
    return initKind === SyntaxKind.ArrowFunction || initKind === SyntaxKind.FunctionExpression;
  }

  return false;
}

/**
 * Determine the export state of a node.
 */
function getExportState(
  node: Node,
  isDeclarationFile: boolean,
  parentClass?: ClassDeclaration,
  parentInterface?: InterfaceDeclaration,
  parentTypeAlias?: TypeAliasDeclaration,
): ExportState {
  if (isDeclarationFile) {
    return "ambient";
  }

  // Check if the node itself has export modifiers
  if ("isExported" in node && typeof node.isExported === "function") {
    if ((node as FunctionDeclaration).isExported()) {
      return "exported";
    }
  }

  // Check if the node is a default export
  if ("isDefaultExport" in node && typeof node.isDefaultExport === "function") {
    if ((node as FunctionDeclaration).isDefaultExport()) {
      return "exported";
    }
  }

  // For class/interface members, check parent export state
  if (parentClass) {
    const classExported = parentClass.isExported() || parentClass.isDefaultExport();
    return classExported ? "exported" : "internal";
  }

  if (parentInterface) {
    const ifaceExported = parentInterface.isExported();
    return ifaceExported ? "exported" : "internal";
  }

  if (parentTypeAlias) {
    const typeExported = parentTypeAlias.isExported();
    return typeExported ? "exported" : "internal";
  }

  return "internal";
}

/**
 * Check if a variable statement is exported.
 */
function isExported(varStmt: VariableStatement): boolean {
  return varStmt.isExported();
}

/**
 * Extract JSDoc tags from a node.
 */
function extractJsDocTags(node: Node): string[] {
  const tags: string[] = [];

  if ("getJsDocs" in node && typeof node.getJsDocs === "function") {
    const jsDocs = (node as FunctionDeclaration).getJsDocs();
    for (const jsDoc of jsDocs) {
      for (const tag of jsDoc.getTags()) {
        const tagName = tag.getTagName();
        if (!tags.includes(tagName)) {
          tags.push(tagName);
        }
      }
    }
  }

  return tags;
}

/**
 * Check if node has @deprecated JSDoc tag.
 */
function isDeprecated(jsDocTags: string[]): boolean {
  return jsDocTags.includes("deprecated");
}

/**
 * Get arity information from parameters.
 */
function getArityInfo(node: Node): { minArity: number; maxArity: number; hasRest: boolean } {
  let params: { isOptional: () => boolean; isRestParameter: () => boolean }[] = [];

  if ("getParameters" in node && typeof node.getParameters === "function") {
    params = (node as FunctionDeclaration).getParameters();
  }

  let minArity = 0;
  let hasRest = false;

  for (const param of params) {
    if (param.isRestParameter()) {
      hasRest = true;
    } else if (!param.isOptional()) {
      minArity++;
    }
  }

  const maxArity = hasRest ? Infinity : params.length;

  return { minArity, maxArity, hasRest };
}

/**
 * Check if node has type annotations.
 */
function hasTypeAnnotations(node: Node): boolean {
  // Check return type
  if ("getReturnTypeNode" in node && typeof node.getReturnTypeNode === "function") {
    if ((node as FunctionDeclaration).getReturnTypeNode()) {
      return true;
    }
  }

  // Check parameter types
  if ("getParameters" in node && typeof node.getParameters === "function") {
    const params = (node as FunctionDeclaration).getParameters();
    for (const param of params) {
      if (param.getTypeNode()) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if function is async (syntactically).
 */
function isAsyncSyntax(node: Node): boolean {
  if ("isAsync" in node && typeof node.isAsync === "function") {
    return (node as FunctionDeclaration).isAsync();
  }
  return false;
}

/**
 * Count overload signatures for a function/method.
 */
function countOverloads(node: Node): number {
  if ("getOverloads" in node && typeof node.getOverloads === "function") {
    const overloads = (node as FunctionDeclaration).getOverloads();
    return overloads.length > 0 ? overloads.length + 1 : 1; // +1 for implementation
  }
  return 1;
}

// === Entry Creation Functions ===

function createFunctionEntry(
  id: number,
  func: FunctionDeclaration,
  filePath: string,
  isDeclarationFile: boolean,
): CallableEntry | null {
  const name = func.getName();
  if (!name && !func.isDefaultExport()) {
    // Skip unnamed non-default functions
    return null;
  }

  const qualifiedName = name ?? "default";
  const jsDocTags = extractJsDocTags(func);
  const arity = getArityInfo(func);

  return {
    id,
    kind: "Function",
    qualifiedName,
    exportState: getExportState(func, isDeclarationFile),
    filePath,
    pos: func.getStart(),
    end: func.getEnd(),
    minArity: arity.minArity,
    maxArity: arity.maxArity,
    hasRest: arity.hasRest,
    isAsyncSyntax: isAsyncSyntax(func),
    hasTypeAnnotations: hasTypeAnnotations(func),
    syntacticOverloadCount: countOverloads(func),
    paramTokens: [], // Filled in by token extraction
    returnTokens: [],
    paramPropKeys: [],
    returnPropKeys: [],
    jsDocTags,
    isDeprecated: isDeprecated(jsDocTags),
  };
}

function createVariableCallableEntry(
  id: number,
  varDecl: VariableDeclaration,
  varStmt: VariableStatement,
  filePath: string,
  isDeclarationFile: boolean,
): CallableEntry | null {
  const name = varDecl.getName();
  const init = varDecl.getInitializer();
  if (!init) return null;

  const jsDocTags = extractJsDocTags(varStmt);
  const arity = getArityInfo(init);

  return {
    id,
    kind: "VariableCallable",
    qualifiedName: name,
    exportState: isExported(varStmt) ? "exported" : isDeclarationFile ? "ambient" : "internal",
    filePath,
    pos: varDecl.getStart(),
    end: varDecl.getEnd(),
    minArity: arity.minArity,
    maxArity: arity.maxArity,
    hasRest: arity.hasRest,
    isAsyncSyntax: isAsyncSyntax(init),
    hasTypeAnnotations: hasTypeAnnotations(init) || !!varDecl.getTypeNode(),
    syntacticOverloadCount: 1,
    paramTokens: [],
    returnTokens: [],
    paramPropKeys: [],
    returnPropKeys: [],
    jsDocTags,
    isDeprecated: isDeprecated(jsDocTags),
  };
}

function createMethodEntry(
  id: number,
  kind: "ClassMethod" | "StaticMethod",
  method: MethodDeclaration,
  className: string,
  filePath: string,
  parentClass: ClassDeclaration,
): CallableEntry | null {
  const name = method.getName();
  const qualifiedName = `${className}.${name}`;
  const jsDocTags = extractJsDocTags(method);
  const arity = getArityInfo(method);
  const isDeclarationFile = filePath.endsWith(".d");

  return {
    id,
    kind,
    qualifiedName,
    exportState: getExportState(method, isDeclarationFile, parentClass),
    filePath,
    pos: method.getStart(),
    end: method.getEnd(),
    minArity: arity.minArity,
    maxArity: arity.maxArity,
    hasRest: arity.hasRest,
    isAsyncSyntax: isAsyncSyntax(method),
    hasTypeAnnotations: hasTypeAnnotations(method),
    syntacticOverloadCount: countOverloads(method),
    paramTokens: [],
    returnTokens: [],
    paramPropKeys: [],
    returnPropKeys: [],
    jsDocTags,
    isDeprecated: isDeprecated(jsDocTags),
  };
}

function createConstructorEntry(
  id: number,
  ctor: ConstructorDeclaration,
  className: string,
  filePath: string,
  parentClass: ClassDeclaration,
): CallableEntry | null {
  const qualifiedName = className;
  const jsDocTags = extractJsDocTags(ctor);
  const arity = getArityInfo(ctor);
  const isDeclarationFile = filePath.endsWith(".d");

  return {
    id,
    kind: "Constructor",
    qualifiedName,
    exportState: getExportState(ctor, isDeclarationFile, parentClass),
    filePath,
    pos: ctor.getStart(),
    end: ctor.getEnd(),
    minArity: arity.minArity,
    maxArity: arity.maxArity,
    hasRest: arity.hasRest,
    isAsyncSyntax: false, // Constructors can't be async
    hasTypeAnnotations: hasTypeAnnotations(ctor),
    syntacticOverloadCount: countOverloads(ctor),
    paramTokens: [],
    returnTokens: [],
    paramPropKeys: [],
    returnPropKeys: [],
    jsDocTags,
    isDeprecated: isDeprecated(jsDocTags),
  };
}

function createInterfaceMethodEntry(
  id: number,
  method: MethodSignature,
  interfaceName: string,
  filePath: string,
  parentInterface: InterfaceDeclaration,
): CallableEntry | null {
  const name = method.getName();
  const qualifiedName = `${interfaceName}.${name}`;
  const jsDocTags = extractJsDocTags(method);
  const arity = getArityInfo(method);
  const isDeclarationFile = filePath.endsWith(".d");

  return {
    id,
    kind: "InterfaceMethod",
    qualifiedName,
    exportState: getExportState(method, isDeclarationFile, undefined, parentInterface),
    filePath,
    pos: method.getStart(),
    end: method.getEnd(),
    minArity: arity.minArity,
    maxArity: arity.maxArity,
    hasRest: arity.hasRest,
    isAsyncSyntax: false, // Signatures don't have async keyword
    hasTypeAnnotations: hasTypeAnnotations(method),
    syntacticOverloadCount: 1,
    paramTokens: [],
    returnTokens: [],
    paramPropKeys: [],
    returnPropKeys: [],
    jsDocTags,
    isDeprecated: isDeprecated(jsDocTags),
  };
}

function createCallablePropertyEntry(
  id: number,
  prop: PropertySignature,
  interfaceName: string,
  filePath: string,
  parentInterface: InterfaceDeclaration,
): CallableEntry | null {
  const name = prop.getName();
  const qualifiedName = `${interfaceName}.${name}`;
  const jsDocTags = extractJsDocTags(prop);
  const isDeclarationFile = filePath.endsWith(".d");

  // Get arity from the function type
  const typeNode = prop.getTypeNode();
  let minArity = 0;
  let maxArity = 0;
  let hasRest = false;

  if (typeNode && typeNode.getKind() === SyntaxKind.FunctionType) {
    const arity = getArityInfo(typeNode);
    minArity = arity.minArity;
    maxArity = arity.maxArity;
    hasRest = arity.hasRest;
  }

  return {
    id,
    kind: "CallableProperty",
    qualifiedName,
    exportState: getExportState(prop, isDeclarationFile, undefined, parentInterface),
    filePath,
    pos: prop.getStart(),
    end: prop.getEnd(),
    minArity,
    maxArity,
    hasRest,
    isAsyncSyntax: false,
    hasTypeAnnotations: true, // Always has type annotation (that's how we know it's callable)
    syntacticOverloadCount: 1,
    paramTokens: [],
    returnTokens: [],
    paramPropKeys: [],
    returnPropKeys: [],
    jsDocTags,
    isDeprecated: isDeprecated(jsDocTags),
  };
}

function createTypeLiteralMethodEntry(
  id: number,
  method: MethodSignature,
  typeName: string,
  filePath: string,
  parentTypeAlias: TypeAliasDeclaration,
): CallableEntry | null {
  const name = method.getName();
  const qualifiedName = `${typeName}.${name}`;
  const jsDocTags = extractJsDocTags(method);
  const arity = getArityInfo(method);
  const isDeclarationFile = filePath.endsWith(".d");

  return {
    id,
    kind: "TypeLiteralMethod",
    qualifiedName,
    exportState: getExportState(method, isDeclarationFile, undefined, undefined, parentTypeAlias),
    filePath,
    pos: method.getStart(),
    end: method.getEnd(),
    minArity: arity.minArity,
    maxArity: arity.maxArity,
    hasRest: arity.hasRest,
    isAsyncSyntax: false,
    hasTypeAnnotations: hasTypeAnnotations(method),
    syntacticOverloadCount: 1,
    paramTokens: [],
    returnTokens: [],
    paramPropKeys: [],
    returnPropKeys: [],
    jsDocTags,
    isDeprecated: isDeprecated(jsDocTags),
  };
}

function createTypeLiteralCallablePropertyEntry(
  id: number,
  prop: PropertySignature,
  typeName: string,
  filePath: string,
  parentTypeAlias: TypeAliasDeclaration,
): CallableEntry | null {
  const name = prop.getName();
  const qualifiedName = `${typeName}.${name}`;
  const jsDocTags = extractJsDocTags(prop);
  const isDeclarationFile = filePath.endsWith(".d");

  // Get arity from the function type
  const typeNode = prop.getTypeNode();
  let minArity = 0;
  let maxArity = 0;
  let hasRest = false;

  if (typeNode && typeNode.getKind() === SyntaxKind.FunctionType) {
    const arity = getArityInfo(typeNode);
    minArity = arity.minArity;
    maxArity = arity.maxArity;
    hasRest = arity.hasRest;
  }

  return {
    id,
    kind: "CallableProperty",
    qualifiedName,
    exportState: getExportState(prop, isDeclarationFile, undefined, undefined, parentTypeAlias),
    filePath,
    pos: prop.getStart(),
    end: prop.getEnd(),
    minArity,
    maxArity,
    hasRest,
    isAsyncSyntax: false,
    hasTypeAnnotations: true,
    syntacticOverloadCount: 1,
    paramTokens: [],
    returnTokens: [],
    paramPropKeys: [],
    returnPropKeys: [],
    jsDocTags,
    isDeprecated: isDeprecated(jsDocTags),
  };
}

function createObjectMethodEntry(
  id: number,
  prop: Node,
  objectName: string,
  filePath: string,
  varStmt: VariableStatement,
): CallableEntry | null {
  let name: string;
  let callableNode: Node;

  if (prop.getKind() === SyntaxKind.MethodDeclaration) {
    const method = prop as MethodDeclaration;
    name = method.getName();
    callableNode = method;
  } else if (prop.getKind() === SyntaxKind.PropertyAssignment) {
    const propAssign = prop as PropertyAssignment;
    name = propAssign.getName();
    const init = propAssign.getInitializer();
    if (!init) return null;
    callableNode = init;
  } else {
    return null;
  }

  const qualifiedName = `${objectName}.${name}`;
  const jsDocTags = extractJsDocTags(prop);
  const arity = getArityInfo(callableNode);
  const isDeclarationFile = filePath.endsWith(".d");

  return {
    id,
    kind: "ObjectMethod",
    qualifiedName,
    exportState: isExported(varStmt) ? "exported" : isDeclarationFile ? "ambient" : "internal",
    filePath,
    pos: prop.getStart(),
    end: prop.getEnd(),
    minArity: arity.minArity,
    maxArity: arity.maxArity,
    hasRest: arity.hasRest,
    isAsyncSyntax: isAsyncSyntax(callableNode),
    hasTypeAnnotations: hasTypeAnnotations(callableNode),
    syntacticOverloadCount: 1,
    paramTokens: [],
    returnTokens: [],
    paramPropKeys: [],
    returnPropKeys: [],
    jsDocTags,
    isDeprecated: isDeprecated(jsDocTags),
  };
}
