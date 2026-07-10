import { afterEach } from "vitest";

import pg from "pg";

const { Client } = pg;

const truncateDatabaseSql = `
TRUNCATE
    auth_audit_entry,
    credential,
    mfa_enrollment,
    refresh_token,
    "user",
    "role",
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
  if (process.env.DATABASE_URI === undefined) {
    throw new Error("DATABASE_URI is required for API integration test cleanup.");
  }

  const client = new Client({ connectionString: process.env.DATABASE_URI });

  try {
    await client.connect();
    await client.query(truncateDatabaseSql);
  } finally {
    await client.end();
  }
});
