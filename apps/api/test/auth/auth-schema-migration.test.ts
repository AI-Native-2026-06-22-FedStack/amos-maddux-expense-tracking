import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { describe, expect, it } from "vitest";

const { Client } = pg;

const systemTenantId = "00000000-0000-0000-0000-000000000000";
const identityTables = ["user", "credential", "role", "refresh_token", "mfa_enrollment"] as const;
const seededRoleNames = [
  "Department Manager",
  "Employee",
  "ExpenseFlow Platform Admin",
  "Finance Admin"
] as const;
const sortedIdentityTables = [...identityTables].sort();

describe("auth identity migration verification", () => {
  it("applies identity migrations and creates expected auth tables, columns, and seed roles", async () => {
    const { client, container } = await startMigratedPostgres();

    try {
      await expect(readAppliedMigrationCount(client)).resolves.toBeGreaterThanOrEqual(4);
      await expect(readExistingTables(client, identityTables)).resolves.toEqual(
        sortedIdentityTables
      );

      for (const tableName of identityTables) {
        await expect(readColumnNullability(client, tableName, "tenant_id")).resolves.toEqual({
          column_name: "tenant_id",
          is_nullable: "NO"
        });
      }

      await expect(readColumnNames(client, "credential")).resolves.toEqual(
        expect.arrayContaining(["password_hash"])
      );
      await expect(readColumnNames(client, "credential")).resolves.not.toEqual(
        expect.arrayContaining(["password", "plaintext_password", "plain_password"])
      );
      await expect(readColumnNames(client, "mfa_enrollment")).resolves.toEqual(
        expect.arrayContaining([
          "encrypted_totp_secret",
          "totp_secret_key_id",
          "last_accepted_totp_time_step",
          "last_accepted_totp_at"
        ])
      );
      await expect(readSeededRoleNames(client)).resolves.toEqual([...seededRoleNames]);
    } finally {
      await client.end();
      await container.stop();
    }
  });
});

interface ColumnNullability {
  column_name: string;
  is_nullable: "YES" | "NO";
}

async function readAppliedMigrationCount(client: pg.Client): Promise<number> {
  const result = await client.query<{ migration_count: number }>(
    `
    select count(*)::integer as migration_count
    from drizzle.__drizzle_migrations;
    `
  );

  return result.rows[0]?.migration_count ?? 0;
}

async function startMigratedPostgres(): Promise<{
  client: pg.Client;
  container: StartedPostgreSqlContainer;
}> {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const client = new Client({ connectionString: container.getConnectionUri() });

  try {
    await client.connect();
    await migrate(drizzle(client), { migrationsFolder: getDrizzleMigrationsDirectory() });

    return { client, container };
  } catch (error: unknown) {
    await client.end();
    await container.stop();
    throw error;
  }
}

function getDrizzleMigrationsDirectory(): string {
  const testDirectory = dirname(fileURLToPath(import.meta.url));

  return join(testDirectory, "../../drizzle");
}

async function readExistingTables(
  client: pg.Client,
  tableNames: readonly string[]
): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    `
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name = any($1::text[])
    order by table_name;
    `,
    [[...tableNames].sort()]
  );

  return result.rows.map((row) => row.table_name).sort();
}

async function readColumnNullability(
  client: pg.Client,
  tableName: string,
  columnName: string
): Promise<ColumnNullability | undefined> {
  const result = await client.query<ColumnNullability>(
    `
    select column_name, is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name = $1
      and column_name = $2;
    `,
    [tableName, columnName]
  );

  return result.rows[0];
}

async function readColumnNames(client: pg.Client, tableName: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = $1
    order by ordinal_position;
    `,
    [tableName]
  );

  return result.rows.map((row) => row.column_name);
}

async function readSeededRoleNames(client: pg.Client): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `
    select name
    from role
    where tenant_id = $1
    order by name;
    `,
    [systemTenantId]
  );

  return result.rows.map((row) => row.name);
}
