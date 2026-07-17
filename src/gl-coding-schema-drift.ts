export interface SchemaCompatibilityResult {
  compatible: boolean;
  breakingChanges: string[];
}

type JsonObject = Record<string, unknown>;

export function checkSchemaCompatibility(
  previousSchema: JsonObject,
  currentSchema: JsonObject,
  previousVersion: string,
  currentVersion: string
): SchemaCompatibilityResult {
  const breakingChanges = findBreakingSchemaChanges(previousSchema, currentSchema);
  const previousMajor = parseMajorVersion(previousVersion);
  const currentMajor = parseMajorVersion(currentVersion);

  if (currentMajor > previousMajor) {
    return { compatible: true, breakingChanges };
  }

  return {
    compatible: breakingChanges.length === 0,
    breakingChanges
  };
}

export function findBreakingSchemaChanges(
  previousSchema: JsonObject,
  currentSchema: JsonObject
): string[] {
  const breakingChanges: string[] = [];
  compareSchemaNode(previousSchema, currentSchema, "#", breakingChanges);

  return breakingChanges;
}

function compareSchemaNode(
  previousNode: unknown,
  currentNode: unknown,
  path: string,
  breakingChanges: string[]
): void {
  if (!isObject(previousNode) || !isObject(currentNode)) {
    return;
  }

  const previousProperties = objectProperty(previousNode, "properties");
  const currentProperties = objectProperty(currentNode, "properties");

  if (previousProperties !== undefined && currentProperties !== undefined) {
    for (const propertyName of Object.keys(previousProperties)) {
      if (!(propertyName in currentProperties)) {
        breakingChanges.push(`${path}/properties/${propertyName} was removed`);
      }
    }

    const previousRequired = stringSetProperty(previousNode, "required");
    const currentRequired = stringSetProperty(currentNode, "required");

    for (const propertyName of currentRequired) {
      if (!previousRequired.has(propertyName)) {
        breakingChanges.push(`${path}/required/${propertyName} became required`);
      }
    }

    for (const [propertyName, previousPropertySchema] of Object.entries(previousProperties)) {
      compareSchemaNode(
        previousPropertySchema,
        currentProperties[propertyName],
        `${path}/properties/${propertyName}`,
        breakingChanges
      );
    }
  }

  const previousDefs = objectProperty(previousNode, "$defs");
  const currentDefs = objectProperty(currentNode, "$defs");
  if (previousDefs !== undefined && currentDefs !== undefined) {
    for (const [defName, previousDef] of Object.entries(previousDefs)) {
      compareSchemaNode(
        previousDef,
        currentDefs[defName],
        `${path}/$defs/${defName}`,
        breakingChanges
      );
    }
  }

  compareArrayKeyword(previousNode, currentNode, "oneOf", path, breakingChanges);
  compareArrayKeyword(previousNode, currentNode, "anyOf", path, breakingChanges);
  compareArrayKeyword(previousNode, currentNode, "allOf", path, breakingChanges);
  compareSchemaNode(previousNode.items, currentNode.items, `${path}/items`, breakingChanges);
}

function compareArrayKeyword(
  previousNode: JsonObject,
  currentNode: JsonObject,
  keyword: string,
  path: string,
  breakingChanges: string[]
): void {
  const previousItems = arrayProperty(previousNode, keyword);
  const currentItems = arrayProperty(currentNode, keyword);

  if (previousItems === undefined || currentItems === undefined) {
    return;
  }

  previousItems.forEach((previousItem, index) => {
    compareSchemaNode(
      previousItem,
      currentItems[index],
      `${path}/${keyword}/${index}`,
      breakingChanges
    );
  });
}

function parseMajorVersion(version: string): number {
  const [major] = version.split(".");
  const parsed = Number.parseInt(major ?? "", 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid semver version: ${version}`);
  }

  return parsed;
}

function objectProperty(value: JsonObject, propertyName: string): JsonObject | undefined {
  const property = value[propertyName];

  return isObject(property) ? property : undefined;
}

function arrayProperty(value: JsonObject, propertyName: string): unknown[] | undefined {
  const property = value[propertyName];

  return Array.isArray(property) ? property : undefined;
}

function stringSetProperty(value: JsonObject, propertyName: string): Set<string> {
  const property = value[propertyName];

  if (!Array.isArray(property)) {
    return new Set();
  }

  return new Set(property.filter((item): item is string => typeof item === "string"));
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
