import type { Node, Project, Symbol } from "ts-morph";
import { SyntaxKind } from "ts-morph";
import type { PackageInfo } from "./discovery";
import type { CompatibilityResult, ErrorExplanationIssue, RelatedInfo } from "./project-types";

export interface TypeRelationContext {
  readonly relativePath: (absolutePath: string) => string;
}

export class TypeRelationExplorer {
  constructor(private readonly context: TypeRelationContext) {}

  findRelated(symbolName: string, project: Project, found: { readonly node: Node; readonly symbol: Symbol }): RelatedInfo {
    const result: RelatedInfo = {
      symbol: symbolName,
      referencedBy: [],
      references: [],
    };

    result.referencedBy.push(...this.findIncomingReferences(project, found.node, found.symbol));
    result.references.push(...this.findOutgoingTypeReferences(found.node));

    return result;
  }

  private findIncomingReferences(
    project: Project,
    node: Node,
    symbol: Symbol,
  ): RelatedInfo["referencedBy"] {
    try {
      return this.collectIncomingReferences(project, node, symbol);
    } catch {
      return [];
    }
  }

  private collectIncomingReferences(
    project: Project,
    node: Node,
    symbol: Symbol,
  ): RelatedInfo["referencedBy"] {
    const referencedBy: RelatedInfo["referencedBy"] = [];
    const seenRefs = new Set<string>();

    for (const refSymbol of project.getLanguageService().findReferences(node)) {
      for (const ref of refSymbol.getReferences().slice(0, 100)) {
        const refInfo = this.toIncomingReference(ref.getNode(), symbol);
        if (refInfo === null) continue;

        const key = `${refInfo.symbol}:${refInfo.context}:${refInfo.line}`;
        if (seenRefs.has(key)) continue;
        seenRefs.add(key);
        referencedBy.push(refInfo);
      }
    }

    return referencedBy;
  }

  private toIncomingReference(refNode: Node, symbol: Symbol): RelatedInfo["referencedBy"][number] | null {
    const refSourceFile = refNode.getSourceFile();
    if (refSourceFile.isInNodeModules()) return null;

    const parent = refNode.getParent();
    if (parent === undefined) return null;

    const context = classifyReferenceContext(parent);
    const containingSymbol = findContainingSymbolName(parent, symbol);
    if (containingSymbol === symbol.getName()) return null;

    return {
      symbol: containingSymbol,
      context,
      file: this.context.relativePath(refSourceFile.getFilePath()),
      line: refNode.getStartLineNumber(),
    };
  }

  private findOutgoingTypeReferences(node: Node): RelatedInfo["references"] {
    const type = node.getType();
    return [
      ...findPropertyTypeReferences(type),
      ...findBaseTypeReferences(type),
    ];
  }
}

export const checkTypeCompatibility = (
  fromSymbol: string,
  toSymbol: string,
  project: Project,
  pkg: PackageInfo,
  findSymbol: (symbolName: string, project: Project, pkg: PackageInfo) => { node: Node; symbol: Symbol } | null,
): CompatibilityResult => {
  const fromFound = findSymbol(fromSymbol, project, pkg);
  const toFound = findSymbol(toSymbol, project, pkg);
  return checkResolvedTypeCompatibility(fromSymbol, toSymbol, fromFound, toFound);
};

export const checkResolvedTypeCompatibility = (
  fromSymbol: string,
  toSymbol: string,
  fromFound: { node: Node; symbol: Symbol } | null,
  toFound: { node: Node; symbol: Symbol } | null,
): CompatibilityResult => {
  if (!fromFound) {
    const message = `Symbol "${fromSymbol}" not found`;
    return {
      compatible: false,
      from: fromSymbol,
      to: toSymbol,
      reason: message,
      issues: [{ kind: "other", message }],
    };
  }

  if (!toFound) {
    const message = `Symbol "${toSymbol}" not found`;
    return {
      compatible: false,
      from: fromSymbol,
      to: toSymbol,
      reason: message,
      issues: [{ kind: "other", message }],
    };
  }

  const fromType = fromFound.node.getType();
  const toType = toFound.node.getType();

  const fromTypeText = fromType.getText(fromFound.node);
  const toTypeText = toType.getText(toFound.node);

  if (fromType.isAssignableTo(toType)) {
    return {
      compatible: true,
      from: fromTypeText,
      to: toTypeText,
    };
  }

  const reasons: string[] = [];
  const issues: ErrorExplanationIssue[] = [];

  const toProperties = toType.getProperties();
  const fromProperties = fromType.getProperties();
  const fromPropNames = new Set(fromProperties.map((property) => property.getName()));

  for (const toProperty of toProperties) {
    const propertyName = toProperty.getName();
    if (!toProperty.isOptional() && !fromPropNames.has(propertyName)) {
      const propertyType = toProperty.getTypeAtLocation(toFound.node).getText(toFound.node);
      const message = `Property '${propertyName}' is missing in type '${fromTypeText}' but required in type '${toTypeText}' (expected: ${propertyType})`;
      reasons.push(message);
      issues.push({
        kind: "missing_property",
        property: propertyName,
        expectedType: propertyType,
        message,
      });
    }
  }

  for (const fromProperty of fromProperties) {
    const propertyName = fromProperty.getName();
    const toProperty = toType.getProperty(propertyName);

    if (toProperty !== undefined) {
      const fromPropertyType = fromProperty.getTypeAtLocation(fromFound.node);
      const toPropertyType = toProperty.getTypeAtLocation(toFound.node);

      if (!fromPropertyType.isAssignableTo(toPropertyType)) {
        const fromPropertyText = fromPropertyType.getText(fromFound.node);
        const toPropertyText = toPropertyType.getText(toFound.node);
        const message = `Property '${propertyName}' has incompatible types: '${fromPropertyText}' is not assignable to '${toPropertyText}'`;
        reasons.push(message);
        issues.push({
          kind: "type_mismatch",
          property: propertyName,
          actualType: fromPropertyText,
          expectedType: toPropertyText,
          message,
        });
      }
    }
  }

  const fromCallSignatures = fromType.getCallSignatures();
  const toCallSignatures = toType.getCallSignatures();

  if (toCallSignatures.length > 0 && fromCallSignatures.length === 0) {
    const message = `Type '${fromTypeText}' is not callable but '${toTypeText}' requires call signatures`;
    reasons.push(message);
    issues.push({ kind: "not_callable", message });
  }

  if (reasons.length === 0) {
    const message = `Type '${fromTypeText}' is not assignable to type '${toTypeText}'`;
    reasons.push(message);
    issues.push({ kind: "other", message });
  }

  return {
    compatible: false,
    from: fromTypeText,
    to: toTypeText,
    reason: reasons.join("; "),
    issues,
  };
};

const classifyReferenceContext = (parent: Node): string => {
  const parentKind = parent.getKind();
  if (parentKind === SyntaxKind.HeritageClause) return "extends";
  if (parentKind === SyntaxKind.TypeReference) return "type reference";
  if (parentKind === SyntaxKind.PropertyAccessExpression) return "property access";
  if (parentKind === SyntaxKind.CallExpression) return "call";
  return "usage";
};

const findContainingSymbolName = (parent: Node, symbol: Symbol): string => {
  let current: Node | undefined = parent;
  while (current !== undefined) {
    const currentSymbol = current.getSymbol();
    if (currentSymbol !== undefined && currentSymbol !== symbol) {
      return currentSymbol.getName();
    }
    current = current.getParent();
  }
  return "anonymous";
};

const findPropertyTypeReferences = (type: import("ts-morph").Type): RelatedInfo["references"] => {
  const references: RelatedInfo["references"] = [];

  for (const property of type.getProperties().slice(0, 50)) {
    const propertyDeclaration = property.getDeclarations()[0];
    if (propertyDeclaration === undefined) continue;

    const propertyType = propertyDeclaration.getType();
    const propertyTypeText = propertyType.getText(propertyDeclaration);
    if (isPrimitiveRelatedType(propertyTypeText)) continue;

    const typeSymbol = propertyType.getSymbol() || propertyType.getAliasSymbol();
    if (typeSymbol !== undefined) {
      references.push({
        symbol: typeSymbol.getName(),
        context: `property "${property.getName()}"`,
      });
    }
  }

  return references;
};

const findBaseTypeReferences = (type: import("ts-morph").Type): RelatedInfo["references"] =>
  type.getBaseTypes().flatMap((baseType) => {
    const baseSymbol = baseType.getSymbol();
    return baseSymbol === undefined ? [] : [{ symbol: baseSymbol.getName(), context: "extends" }];
  });

const isPrimitiveRelatedType = (typeText: string): boolean =>
  typeText === "string" || typeText === "number" || typeText === "boolean";
