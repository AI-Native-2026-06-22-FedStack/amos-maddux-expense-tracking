import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema.js";

const { Pool } = pg;

const defaultPoolMax = 10;

export const databasePool = new Pool({
  connectionString: getDatabaseUrl(),
  max: defaultPoolMax
});

export const db = drizzle(databasePool, { schema });

export async function checkDatabaseReady(): Promise<boolean> {
  try {
    await databasePool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URI === undefined) {
    throw new Error("DATABASE_URL is required to create the database client.");
  }

  return process.env.DATABASE_URI;
}
