import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: getDatabaseUrl() }
});

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL === undefined) {
    throw new Error("DATABASE_URL is required for Drizzle commands.");
  }

  return process.env.DATABASE_URL;
}
