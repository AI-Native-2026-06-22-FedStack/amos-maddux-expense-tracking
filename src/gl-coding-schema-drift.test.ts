import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { checkSchemaCompatibility } from "./gl-coding-schema-drift.js";

type JsonObject = Record<string, unknown>;

const currentSchemaPath = resolve("packages/shared-schemas/gl-coding.schema.json");
const previousSchemaPath = resolve("packages/shared-schemas/snapshots/gl-coding-1.0.0.schema.json");
const packageJsonPath = resolve("packages/shared-schemas/package.json");

describe("GL coding schema drift", () => {
  it("keeps the current schema backward-compatible without a major version bump", () => {
    const currentSchema = readJson(currentSchemaPath);
    const previousSchema = readJson(previousSchemaPath);
    const packageJson = readJson(packageJsonPath);

    const result = checkSchemaCompatibility(
      previousSchema,
      currentSchema,
      "1.0.0",
      stringProperty(packageJson, "version")
    );

    expect(result.breakingChanges).toEqual([]);
    expect(result.compatible).toBe(true);
  });

  it("allows optional fields without a major version bump", () => {
    const previousSchema = minimalSchema();
    const currentSchema = structuredClone(previousSchema);
    const currentProperties = expectObject(expectObject(currentSchema.$defs).Synthetic).properties;

    expectObject(currentProperties).optional_note = { type: "string" };

    const result = checkSchemaCompatibility(previousSchema, currentSchema, "1.0.0", "1.1.0");

    expect(result.breakingChanges).toEqual([]);
    expect(result.compatible).toBe(true);
  });

  it("rejects newly required fields without a major version bump", () => {
    const previousSchema = minimalSchema();
    const currentSchema = structuredClone(previousSchema);
    const currentSynthetic = expectObject(expectObject(currentSchema.$defs).Synthetic);

    expectObject(currentSynthetic.properties).approval_code = { type: "string" };
    currentSynthetic.required = ["id", "approval_code"];

    const result = checkSchemaCompatibility(previousSchema, currentSchema, "1.0.0", "1.1.0");

    expect(result.compatible).toBe(false);
    expect(result.breakingChanges).toContain(
      "#/$defs/Synthetic/required/approval_code became required"
    );
  });

  it("rejects removed fields without a major version bump", () => {
    const previousSchema = minimalSchema();
    const currentSchema = structuredClone(previousSchema);

    delete expectObject(expectObject(expectObject(currentSchema.$defs).Synthetic).properties).id;

    const result = checkSchemaCompatibility(previousSchema, currentSchema, "1.0.0", "1.1.0");

    expect(result.compatible).toBe(false);
    expect(result.breakingChanges).toContain("#/$defs/Synthetic/properties/id was removed");
  });

  it("allows breaking changes with a major version bump", () => {
    const previousSchema = minimalSchema();
    const currentSchema = structuredClone(previousSchema);

    delete expectObject(expectObject(expectObject(currentSchema.$defs).Synthetic).properties).id;

    const result = checkSchemaCompatibility(previousSchema, currentSchema, "1.0.0", "2.0.0");

    expect(result.breakingChanges).toContain("#/$defs/Synthetic/properties/id was removed");
    expect(result.compatible).toBe(true);
  });
});

function minimalSchema(): JsonObject {
  return {
    type: "object",
    $defs: {
      Synthetic: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" }
        }
      }
    }
  };
}

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf-8")) as JsonObject;
}

function stringProperty(value: JsonObject, propertyName: string): string {
  const property = value[propertyName];

  if (typeof property !== "string") {
    throw new Error(`Expected ${propertyName} to be a string.`);
  }

  return property;
}

function expectObject(value: unknown): JsonObject {
  expect(value).toEqual(expect.any(Object));

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object.");
  }

  return value as JsonObject;
}
