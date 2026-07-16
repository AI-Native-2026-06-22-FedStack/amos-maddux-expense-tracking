import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import { getApiRuntimeConfig } from "../config/runtime-config.js";
import { getRuntimeSecrets } from "../config/runtime-secrets.js";
import * as schema from "./schema.js";

const { Pool } = pg;

const defaultPoolMax = 10;

let databasePool: pg.Pool | undefined;
let db: NodePgDatabase<typeof schema> | undefined;

export async function checkDatabaseReady(): Promise<boolean> {
  try {
    await assertDatabaseReady();
    return true;
  } catch {
    return false;
  }
}

export async function assertDatabaseReady(): Promise<void> {
  await getDatabasePool().query("SELECT 1");
}

export function getDb(): NodePgDatabase<typeof schema> {
  db ??= drizzle(getDatabasePool(), { schema });

  return db;
}

export function getDatabasePool(): pg.Pool {
  databasePool ??= new Pool({
    connectionString: getDatabaseConnectionString(),
    max: defaultPoolMax
  });

  return databasePool;
}

export async function closeDatabasePool(): Promise<void> {
  if (databasePool === undefined) {
    return;
  }

  await databasePool.end();
  databasePool = undefined;
  db = undefined;
}

function getDatabaseConnectionString(): string {
  const config = getApiRuntimeConfig();
  const databaseUrl = new URL(config.DATABASE_URI);

  if (databaseUrl.password !== "" && config.NODE_ENV === "test") {
    return config.DATABASE_URI;
  }

  if (databaseUrl.password !== "") {
    throw new Error("DATABASE_URI must not contain a password; use DB_PASSWORD_SECRET_ID instead.");
  }

  databaseUrl.password = getRuntimeSecrets().dbPassword;

  return databaseUrl.toString();
}
