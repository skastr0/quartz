import { Node } from "ts-morph";

export const getDeclarationName = (node: Node): string | null => {
  if (Node.isClassDeclaration(node)) return node.getName() ?? null;
  if (Node.isFunctionDeclaration(node)) return node.getName() ?? null;
  if (Node.isInterfaceDeclaration(node)) return node.getName();
  if (Node.isTypeAliasDeclaration(node)) return node.getName();
  if (Node.isEnumDeclaration(node)) return node.getName();
  if (Node.isVariableDeclaration(node)) return node.getName();

  const symbol = node.getSymbol();
  if (symbol === undefined) return null;
  const name = symbol.getName();
  return name === "default" ? null : name;
};
