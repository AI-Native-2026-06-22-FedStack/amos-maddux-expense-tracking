"""Shared DuckDB SQL for the row set that can actually exist in a real
expense_line_item table — used by both the Postgres loader
(tools/load_line_items_to_postgres.py) and the row-level Parquet archive
writer (tools/archive_valid_line_items.py), so the equivalence check
(tools/equivalence_check.py) sums the exact same rows on both sides.

Two of the export's seeded defects are structurally impossible to load into
a real expense_line_item table:
  - amount_cents <= 0 or a non-[A-Z]{3} currency violates
    expense_line_item_amount_cents_check / expense_line_item_currency_check
    (apps/api/src/db/schema.ts).
  - a record_id reused from the immediately preceding row (the export's
    "Defect 6") collides with expense_line_item's primary key once the
    first occurrence is inserted.
Both exclusions are real and structural, not invented by this pipeline.
"""

from __future__ import annotations

# Default DuckDB `ATTACH ... (TYPE postgres)` DSN for the local docker-compose
# postgres service (docker-compose.yml: host port 5433, see .env.example for
# the default POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB). Shared by every
# tool that attaches to Postgres so there is one place to change it.
DEFAULT_POSTGRES_DSN = (
    "host=localhost port=5433 dbname=expenseflow user=expenseflow "
    "password=synthetic-compose-db-password"
)

# Matches schema.py's ReadType, translated to DuckDB SQL types. Kept as a
# flat VARCHAR/BIGINT/BOOLEAN map (not DATE/TIMESTAMP) so nothing is left to
# DuckDB's own date-parsing inference at read time — read_ndjson_auto was
# checked directly and infers receipt_date as DATE by default despite the
# export's own mixed date-format defects living elsewhere (trip_date),
# which is exactly the kind of silent, library-dependent inference Task 1
# exists to avoid.
DECLARED_NDJSON_COLUMNS = {
    "record_type": "VARCHAR",
    "tenant_id": "VARCHAR",
    "expense_report_id": "VARCHAR",
    "record_id": "VARCHAR",
    "submitter_id": "VARCHAR",
    "current_stage": "VARCHAR",
    "merchant": "VARCHAR",
    "category": "VARCHAR",
    "amount_cents": "BIGINT",
    "currency": "VARCHAR",
    "miles": "VARCHAR",
    "trip_date": "VARCHAR",
    "origin": "VARCHAR",
    "destination": "VARCHAR",
    "business_purpose": "VARCHAR",
    "gl_account_code": "VARCHAR",
    "gl_account_name": "VARCHAR",
    "gl_normal_balance": "VARCHAR",
    "gl_coding_status": "VARCHAR",
    "receipt_number": "VARCHAR",
    "receipt_date": "VARCHAR",
    "flagged": "BOOLEAN",
    "deductible": "BOOLEAN",
    "manager_review_status": "VARCHAR",
    "created_at": "VARCHAR",
}


def columns_sql() -> str:
    entries = ", ".join(
        f"'{name}': '{sql_type}'" for name, sql_type in DECLARED_NDJSON_COLUMNS.items()
    )
    return "{" + entries + "}"


# Same predicate as expense_line_item's real check constraints.
VALID_LINE_ITEM_FILTER = r"""
    record_type = 'line_item'
    AND amount_cents > 0
    AND regexp_matches(currency, '^[A-Z]{3}$')
"""


def valid_line_items_cte_sql(export_path: str) -> str:
    """A DuckDB CTE selecting exactly the rows that could exist in Postgres.

    row_number() over the raw scan (no PARTITION/ORDER) establishes each
    row's file-read order BEFORE any filtering, matching
    generate_export.py's "reuse the immediately preceding row's record_id"
    defect semantics, which are defined relative to file order. QUALIFY then
    keeps only the first occurrence of any given record_id among the rows
    that already pass the check-constraint filter — a later duplicate can
    never be inserted once the first occurrence exists.
    """
    return f"""
        WITH ordered_export AS (
            SELECT *, row_number() OVER () AS file_row_number
            FROM read_ndjson_auto({export_path!r}, columns={columns_sql()})
        ),
        valid_line_items AS (
            SELECT *
            FROM ordered_export
            WHERE {VALID_LINE_ITEM_FILTER}
            QUALIFY row_number() OVER (PARTITION BY record_id ORDER BY file_row_number) = 1
        )
    """
