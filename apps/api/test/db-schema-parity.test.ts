import { describe, expect, it } from "vitest";

import { getTableColumns, getTableName } from "drizzle-orm";
import pg from "pg";

import {
  auditEntry,
  expenseReport,
  lineItem,
  mileageEntry,
  receipt,
  stageTransition
} from "../src/db/schema.js";

const { Client } = pg;

const tableShapes = [
  {
    table: expenseReport,
    columns: {
      id: { dataType: "uuid", nullable: false, defaultExpression: "gen_random_uuid()" },
      tenant_id: { dataType: "uuid", nullable: false },
      submitter_id: { dataType: "text", nullable: false },
      assigned_owner_id: { dataType: "text", nullable: true },
      manager_approver_id: { dataType: "text", nullable: true },
      ap_reviewer_id: { dataType: "text", nullable: true },
      payment_id: { dataType: "text", nullable: true },
      current_stage: { dataType: "text", nullable: false, defaultExpression: "'Drafted'::text" },
      priority: { dataType: "text", nullable: false, defaultExpression: "'Normal'::text" },
      due_date: { dataType: "date", nullable: true },
      on_hold: { dataType: "boolean", nullable: false, defaultExpression: "false" },
      hold_reason: { dataType: "text", nullable: true },
      created_at: {
        dataType: "timestamp with time zone",
        nullable: false,
        defaultExpression: "now()"
      },
      updated_at: {
        dataType: "timestamp with time zone",
        nullable: false,
        defaultExpression: "now()"
      }
    },
    constraints: [
      "expense_report_current_stage_check",
      "expense_report_hold_reason_check",
      "expense_report_pkey",
      "expense_report_priority_check",
      "expense_report_tenant_id_id_unique"
    ],
    indexes: [
      "expense_report_case_queue_idx",
      "expense_report_pkey",
      "expense_report_tenant_id_id_unique"
    ]
  },
  {
    table: lineItem,
    columns: {
      id: { dataType: "uuid", nullable: false, defaultExpression: "gen_random_uuid()" },
      tenant_id: { dataType: "uuid", nullable: false },
      expense_report_id: { dataType: "uuid", nullable: false },
      merchant: { dataType: "text", nullable: false },
      amount_cents: { dataType: "integer", nullable: false },
      currency: { dataType: "text", nullable: false },
      category: { dataType: "text", nullable: false },
      flagged: { dataType: "boolean", nullable: false, defaultExpression: "false" },
      flag_cleared: { dataType: "boolean", nullable: false, defaultExpression: "false" },
      deductible: { dataType: "boolean", nullable: false, defaultExpression: "false" },
      created_at: {
        dataType: "timestamp with time zone",
        nullable: false,
        defaultExpression: "now()"
      }
    },
    constraints: [
      "expense_line_item_amount_cents_check",
      "expense_line_item_currency_check",
      "expense_line_item_flag_state_check",
      "expense_line_item_pkey",
      "expense_line_item_report_fk",
      "expense_line_item_tenant_id_id_unique",
      "expense_line_item_tenant_report_id_id_unique"
    ],
    indexes: [
      "expense_line_item_pkey",
      "expense_line_item_tenant_id_id_unique",
      "expense_line_item_tenant_report_id_id_unique"
    ]
  },
  {
    table: receipt,
    columns: {
      id: { dataType: "uuid", nullable: false, defaultExpression: "gen_random_uuid()" },
      tenant_id: { dataType: "uuid", nullable: false },
      expense_report_id: { dataType: "uuid", nullable: false },
      expense_line_item_id: { dataType: "uuid", nullable: false },
      attachment_metadata_id: { dataType: "uuid", nullable: true },
      receipt_number: { dataType: "text", nullable: true },
      merchant: { dataType: "text", nullable: true },
      receipt_date: { dataType: "date", nullable: true },
      amount_cents: { dataType: "integer", nullable: true },
      currency: { dataType: "text", nullable: true },
      created_at: {
        dataType: "timestamp with time zone",
        nullable: false,
        defaultExpression: "now()"
      }
    },
    constraints: [
      "receipt_amount_cents_check",
      "receipt_attachment_metadata_fk",
      "receipt_currency_check",
      "receipt_line_item_report_fk",
      "receipt_pkey",
      "receipt_report_fk",
      "receipt_tenant_id_id_unique"
    ],
    indexes: ["receipt_pkey", "receipt_tenant_id_id_unique"]
  },
  {
    table: mileageEntry,
    columns: {
      id: { dataType: "uuid", nullable: false, defaultExpression: "gen_random_uuid()" },
      tenant_id: { dataType: "uuid", nullable: false },
      expense_report_id: { dataType: "uuid", nullable: false },
      trip_date: { dataType: "date", nullable: false },
      origin: { dataType: "text", nullable: false },
      destination: { dataType: "text", nullable: false },
      miles: { dataType: "numeric", nullable: false, numericPrecision: 10, numericScale: 2 },
      business_purpose: { dataType: "text", nullable: false },
      created_at: {
        dataType: "timestamp with time zone",
        nullable: false,
        defaultExpression: "now()"
      }
    },
    constraints: [
      "mileage_entry_miles_check",
      "mileage_entry_pkey",
      "mileage_entry_report_fk",
      "mileage_entry_tenant_id_id_unique"
    ],
    indexes: ["mileage_entry_pkey", "mileage_entry_tenant_id_id_unique"]
  },
  {
    table: auditEntry,
    columns: {
      id: { dataType: "uuid", nullable: false, defaultExpression: "gen_random_uuid()" },
      tenant_id: { dataType: "uuid", nullable: false },
      expense_report_id: { dataType: "uuid", nullable: false },
      actor_id: { dataType: "text", nullable: false },
      action: { dataType: "text", nullable: false },
      details: { dataType: "text", nullable: true },
      occurred_at: {
        dataType: "timestamp with time zone",
        nullable: false,
        defaultExpression: "now()"
      }
    },
    constraints: ["audit_entry_pkey", "audit_entry_report_fk", "audit_entry_tenant_id_id_unique"],
    indexes: ["audit_entry_pkey", "audit_entry_tenant_id_id_unique"]
  },
  {
    table: stageTransition,
    columns: {
      id: { dataType: "uuid", nullable: false, defaultExpression: "gen_random_uuid()" },
      tenant_id: { dataType: "uuid", nullable: false },
      expense_report_id: { dataType: "uuid", nullable: false },
      from_stage: { dataType: "text", nullable: true },
      to_stage: { dataType: "text", nullable: false },
      actor_id: { dataType: "text", nullable: false },
      reason: { dataType: "text", nullable: true },
      transitioned_at: {
        dataType: "timestamp with time zone",
        nullable: false,
        defaultExpression: "now()"
      }
    },
    constraints: [
      "stage_transition_from_stage_check",
      "stage_transition_pkey",
      "stage_transition_report_fk",
      "stage_transition_stage_change_check",
      "stage_transition_tenant_id_id_unique",
      "stage_transition_to_stage_check"
    ],
    indexes: ["stage_transition_pkey", "stage_transition_tenant_id_id_unique"]
  }
] as const;

interface ExpectedColumn {
  dataType: string;
  nullable: boolean;
  defaultExpression?: string;
  numericPrecision?: number;
  numericScale?: number;
}

interface CatalogColumn {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
}

describe.skipIf(process.env.DATABASE_URL === undefined)("Drizzle schema parity", () => {
  it("matches migrated PostgreSQL columns, constraints, and indexes", async () => {
    const client = new Client({ connectionString: getDatabaseUrl() });
    await client.connect();

    try {
      for (const shape of tableShapes) {
        const tableName = getTableName(shape.table);
        const schemaColumnNames = Object.values(getTableColumns(shape.table)).map(
          (column) => column.name
        );
        const expectedColumnNames = Object.keys(shape.columns);

        expect(schemaColumnNames).toEqual(expectedColumnNames);
        expect(await readColumns(client, tableName)).toEqual(shape.columns);
        expect(await readConstraintNames(client, tableName)).toEqual(shape.constraints);
        expect(await readIndexNames(client, tableName)).toEqual(shape.indexes);
      }
    } finally {
      await client.end();
    }
  });
});

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL === undefined) {
    throw new Error("DATABASE_URL is required for Drizzle schema parity tests.");
  }

  return process.env.DATABASE_URL;
}

async function readColumns(
  client: pg.Client,
  tableName: string
): Promise<Record<string, ExpectedColumn>> {
  const result = await client.query<CatalogColumn>(
    `
    select
      column_name,
      data_type,
      is_nullable,
      column_default,
      numeric_precision,
      numeric_scale
    from information_schema.columns
    where table_schema = 'public'
      and table_name = $1
    order by ordinal_position;
    `,
    [tableName]
  );

  return Object.fromEntries(
    result.rows.map((row) => [
      row.column_name,
      {
        dataType: row.data_type,
        nullable: row.is_nullable === "YES",
        ...(row.column_default === null ? {} : { defaultExpression: row.column_default }),
        ...(row.data_type === "numeric" && row.numeric_precision !== null
          ? { numericPrecision: row.numeric_precision }
          : {}),
        ...(row.data_type === "numeric" && row.numeric_scale !== null
          ? { numericScale: row.numeric_scale }
          : {})
      }
    ])
  );
}

async function readConstraintNames(client: pg.Client, tableName: string): Promise<string[]> {
  const result = await client.query<{ constraint_name: string }>(
    `
    select constraint_name
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = $1
      and constraint_name not like '%_not_null'
    order by constraint_name;
    `,
    [tableName]
  );

  return result.rows.map((row) => row.constraint_name);
}

async function readIndexNames(client: pg.Client, tableName: string): Promise<string[]> {
  const result = await client.query<{ indexname: string }>(
    `
    select indexname
    from pg_indexes
    where schemaname = 'public'
      and tablename = $1
    order by indexname;
    `,
    [tableName]
  );

  return result.rows.map((row) => row.indexname);
}
