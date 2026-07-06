import { afterEach } from "vitest";

import pg from "pg";

const { Client } = pg;

const truncateDatabaseSql = `
TRUNCATE
    audit_entry,
    stage_transition,
    expense_report,
    expense_line_item,
    attachment_metadata,
    receipt,
    mileage_entry
RESTART IDENTITY CASCADE;
`;

afterEach(async () => {
  if (process.env.DATABASE_URL === undefined) {
    throw new Error("DATABASE_URL is required for API integration test cleanup.");
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();
    await client.query(truncateDatabaseSql);
  } finally {
    await client.end();
  }
});
