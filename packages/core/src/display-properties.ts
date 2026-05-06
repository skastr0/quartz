import type { Node, Symbol, Type } from "ts-morph"
import { TypeFormatFlags } from "ts-morph"

const MAX_DECLARED_PROPERTIES = 50

export interface DisplayPropertyInfo {
  readonly name: string
  readonly type: string
  readonly optional?: boolean
}

export const getDisplayPropertySymbols = (type: Type, rootDirectory: string): readonly Symbol[] => {
  const properties = type.getProperties()
  if (properties.length === 0 || properties.length > MAX_DECLARED_PROPERTIES) return []

  return properties.filter((property) =>
    property.getDeclarations().some((declaration) =>
      declaration.getSourceFile().getFilePath().startsWith(rootDirectory),
    ),
  )
}

export const getDisplayProperties = (declaration: Node, rootDirectory: string): readonly DisplayPropertyInfo[] =>
  getDisplayPropertySymbols(declaration.getType(), rootDirectory).map((property) => {
    const propertyDeclaration = property.getValueDeclaration() ?? property.getDeclarations()[0]
    const propertyType =
      propertyDeclaration === undefined
        ? property.getDeclaredType().getText()
        : property.getTypeAtLocation(propertyDeclaration).getText(propertyDeclaration, TypeFormatFlags.NoTruncation)

    return {
      name: property.getName(),
      type: propertyType,
      optional: property.isOptional(),
    }
  })
