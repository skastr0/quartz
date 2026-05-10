import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import type { PackageInfo } from "./discovery";
import type { FileDeclarationInfo, FileExportMetadata, FileInspectionResult } from "./project-types";
import { getDeclarationName } from "./symbol-lookup";

export interface FileInspectionContext {
  readonly kindToString: (kind: SyntaxKind) => string;
  readonly relativePath: (absolutePath: string) => string;
}

export interface FileInspectionOptions {
  readonly symbol?: string;
  readonly includePrivate?: boolean;
}

export const inspectSourceFile = (
  sourceFile: SourceFile,
  pkg: PackageInfo,
  options: FileInspectionOptions,
  context: FileInspectionContext,
): FileInspectionResult => {
  const symbolFilter = options.symbol ? new RegExp(options.symbol, "i") : null;
  const exportMetadata = getFileExportMetadata(sourceFile);
  const declarations = collectFileDeclarations(sourceFile, exportMetadata, {
    symbolFilter,
    includePrivate: options.includePrivate ?? false,
    context,
  });

  sortFileDeclarations(declarations);

  return {
    file: context.relativePath(sourceFile.getFilePath()),
    package: pkg.name,
    declarations,
    total: declarations.length,
  };
};

const getFileExportMetadata = (sourceFile: SourceFile): FileExportMetadata => {
  const exportedNames = new Set<string>();
  const defaultExportNames = new Set<string>();
  const exportAliases = new Map<string, string>();

  for (const [exportName, declarations] of sourceFile.getExportedDeclarations()) {
    if (exportName === "default") {
      for (const declaration of declarations) {
        const actualName = getDeclarationName(declaration);
        if (actualName !== null) {
          defaultExportNames.add(actualName);
          exportedNames.add(actualName);
        }
      }
      continue;
    }

    for (const declaration of declarations) {
      const actualName = getDeclarationName(declaration);
      if (actualName !== null && actualName !== exportName) {
        exportAliases.set(actualName, exportName);
        exportedNames.add(actualName);
      } else {
        exportedNames.add(exportName);
      }
    }
  }

  return { exportedNames, defaultExportNames, exportAliases };
};

const collectFileDeclarations = (
  sourceFile: SourceFile,
  exportMetadata: FileExportMetadata,
  options: {
    readonly symbolFilter: RegExp | null;
    readonly includePrivate: boolean;
    readonly context: FileInspectionContext;
  },
): FileDeclarationInfo[] => {
  const declarations: FileDeclarationInfo[] = [];
  const addDeclaration = (node: Node, name: string) => {
    const declaration = createFileDeclarationInfo(node, name, exportMetadata, options);
    if (declaration !== null) declarations.push(declaration);
  };

  for (const classDeclaration of sourceFile.getClasses()) {
    const name = classDeclaration.getName();
    if (name !== undefined) addDeclaration(classDeclaration, name);
  }

  for (const interfaceDeclaration of sourceFile.getInterfaces()) {
    addDeclaration(interfaceDeclaration, interfaceDeclaration.getName());
  }

  for (const typeAlias of sourceFile.getTypeAliases()) {
    addDeclaration(typeAlias, typeAlias.getName());
  }

  for (const functionDeclaration of sourceFile.getFunctions()) {
    const name = functionDeclaration.getName();
    if (name !== undefined) addDeclaration(functionDeclaration, name);
  }

  for (const enumDeclaration of sourceFile.getEnums()) {
    addDeclaration(enumDeclaration, enumDeclaration.getName());
  }

  for (const variableStatement of sourceFile.getVariableStatements()) {
    for (const variableDeclaration of variableStatement.getDeclarations()) {
      addDeclaration(variableDeclaration, variableDeclaration.getName());
    }
  }

  return declarations;
};

const createFileDeclarationInfo = (
  node: Node,
  name: string,
  exportMetadata: FileExportMetadata,
  options: {
    readonly symbolFilter: RegExp | null;
    readonly includePrivate: boolean;
    readonly context: FileInspectionContext;
  },
): FileDeclarationInfo | null => {
  if (options.symbolFilter !== null && !options.symbolFilter.test(name)) return null;

  const isExported = exportMetadata.exportedNames.has(name);
  if (!isExported && !options.includePrivate) return null;

  const kind = options.context.kindToString(node.getKind());
  const exportedAs = exportMetadata.exportAliases.get(name);
  const info: FileDeclarationInfo = {
    name,
    kind,
    line: node.getStartLineNumber(),
    exported: isExported,
    isDefaultExport: exportMetadata.defaultExportNames.has(name),
    ...(exportedAs === undefined ? {} : { exportedAs }),
  };

  const type = node.getType();
  if (kind !== "class" && kind !== "interface" && kind !== "enum") {
    info.type = type.getText(node);
  }

  const signature = getFileDeclarationSignature(node, name, kind, type);
  if (signature !== undefined) info.signature = signature;
  return info;
};

const getFileDeclarationSignature = (
  node: Node,
  name: string,
  kind: string,
  type: import("ts-morph").Type,
): string | undefined => {
  if (kind === "function") {
    const callSignatures = type.getCallSignatures();
    if (callSignatures.length === 0) return undefined;
    return callSignatures
      .map((signature) => {
        const parameters = signature
          .getParameters()
          .map((parameter) => `${parameter.getName()}: ${parameter.getTypeAtLocation(node).getText(node)}`)
          .join(", ");
        const returnType = signature.getReturnType().getText(node);
        return `(${parameters}) => ${returnType}`;
      })
      .join(" | ");
  }

  if (kind !== "class") return undefined;

  const properties = type.getProperties().slice(0, 20);
  const methods = properties.filter((property) => {
    const declaration = property.getDeclarations()[0];
    return declaration !== undefined && declaration.getKind() === SyntaxKind.MethodDeclaration;
  });
  const methodList = methods.map((method) => method.getName() + "()").join(", ");
  const suffix = methods.length < properties.length ? ", ..." : "";
  return `class ${name} { ${methodList}${suffix} }`;
};

const sortFileDeclarations = (declarations: FileDeclarationInfo[]): void => {
  declarations.sort((a, b) => {
    if (a.exported && !b.exported) return -1;
    if (!a.exported && b.exported) return 1;
    if (a.isDefaultExport && !b.isDefaultExport) return -1;
    if (!a.isDefaultExport && b.isDefaultExport) return 1;
    return a.name.localeCompare(b.name);
  });
};
