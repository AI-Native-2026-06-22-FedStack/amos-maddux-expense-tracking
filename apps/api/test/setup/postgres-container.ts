import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

const { Client } = pg;

export async function setup(): Promise<() => Promise<void>> {
  let client: pg.Client | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  try {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    // API integration tests read this runtime-only URL to connect to the disposable database.
    process.env.DATABASE_URL = container.getConnectionUri();

    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await applyMigrations(client);
  } catch (error: unknown) {
    await stopPostgres(client, container);
    throw error;
  }

  return async () => {
    await stopPostgres(client, container);
  };
}

async function applyMigrations(client: pg.Client): Promise<void> {
  const migrationsDirectory = getMigrationsDirectory();
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();

  for (const migrationFile of migrationFiles) {
    const migrationSql = await readFile(join(migrationsDirectory, migrationFile), "utf8");
    await client.query(migrationSql);
  }
}

function getMigrationsDirectory(): string {
  const setupDirectory = dirname(fileURLToPath(import.meta.url));

  return join(setupDirectory, "../../db/migrations");
}

async function stopPostgres(
  client: pg.Client | undefined,
  container: StartedPostgreSqlContainer | undefined
): Promise<void> {
  await client?.end();
  await container?.stop();
}
