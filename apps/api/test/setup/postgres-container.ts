import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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
    await applyDrizzleMigrations(client);
  } catch (error: unknown) {
    await stopPostgres(client, container);
    throw error;
  }

  return async () => {
    await stopPostgres(client, container);
  };
}

async function applyDrizzleMigrations(client: pg.Client): Promise<void> {
  const db = drizzle(client);
  const migrationConfig = { migrationsFolder: getDrizzleMigrationsDirectory() };

  await migrate(db, migrationConfig);
  const migrationCountAfterFirstRun = await readDrizzleMigrationCount(client);

  await migrate(db, migrationConfig);
  const migrationCountAfterSecondRun = await readDrizzleMigrationCount(client);

  if (migrationCountAfterSecondRun !== migrationCountAfterFirstRun) {
    throw new Error(
      "Drizzle migrations were not idempotent; the second migration run changed the journal."
    );
  }
}

function getDrizzleMigrationsDirectory(): string {
  const setupDirectory = dirname(fileURLToPath(import.meta.url));

  return join(setupDirectory, "../../drizzle");
}

async function readDrizzleMigrationCount(client: pg.Client): Promise<number> {
  const result = await client.query<{ migration_count: number }>(
    `
    select count(*)::integer as migration_count
    from drizzle.__drizzle_migrations;
    `
  );

  return result.rows[0]?.migration_count ?? 0;
}

async function stopPostgres(
  client: pg.Client | undefined,
  container: StartedPostgreSqlContainer | undefined
): Promise<void> {
  await client?.end();
  await container?.stop();
}
