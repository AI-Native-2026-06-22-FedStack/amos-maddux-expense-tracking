#!/usr/bin/env python3
"""Load the export's valid, deduped expense_line_item rows into a live
Postgres, for the DuckDB equivalence check in tools/equivalence_check.py.

Row selection (which rows can actually be inserted) lives in
valid_line_items.py, shared with tools/archive_valid_line_items.py so both
the Postgres and Parquet sides of the equivalence check sum over an
identical row set.

expense_report is loaded first (one synthetic report per loaded line item,
1:1, matching how generate_export.py generates a fresh expense_report_id
per row) to satisfy expense_line_item's foreign key.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from valid_line_items import DEFAULT_POSTGRES_DSN, valid_line_items_cte_sql  # noqa: E402


def load(export_path: Path, postgres_dsn: str) -> tuple[int, int]:
    """Returns (expense_report rows inserted, expense_line_item rows inserted)."""
    con = duckdb.connect()
    con.execute("INSTALL postgres;")
    con.execute("LOAD postgres;")
    con.execute(f"ATTACH '{postgres_dsn}' AS pg (TYPE postgres);")

    cte = valid_line_items_cte_sql(str(export_path))

    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE valid_line_items AS
        {cte}
        SELECT * FROM valid_line_items
    """)

    con.execute("""
        INSERT INTO pg.public.expense_report
            (id, tenant_id, submitter_id, current_stage, created_at, updated_at)
        SELECT
            expense_report_id::uuid,
            tenant_id::uuid,
            submitter_id,
            current_stage,
            created_at::timestamptz,
            created_at::timestamptz
        FROM valid_line_items
    """)
    report_count = con.execute("SELECT count(*) FROM valid_line_items").fetchone()[0]

    con.execute("""
        INSERT INTO pg.public.expense_line_item
            (id, tenant_id, expense_report_id, merchant, amount_cents, currency,
             category, gl_coding_status, gl_account_code, gl_account_name,
             gl_normal_balance, manager_review_status, flagged, deductible, created_at)
        SELECT
            record_id::uuid,
            tenant_id::uuid,
            expense_report_id::uuid,
            merchant,
            amount_cents,
            currency,
            category,
            gl_coding_status,
            gl_account_code,
            gl_account_name,
            gl_normal_balance,
            manager_review_status,
            flagged,
            deductible,
            created_at::timestamptz
        FROM valid_line_items
    """)
    line_item_count = con.execute("SELECT count(*) FROM valid_line_items").fetchone()[0]

    con.close()
    return report_count, line_item_count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export_path", type=Path)
    parser.add_argument(
        "--postgres-dsn",
        default=DEFAULT_POSTGRES_DSN,
        help="DuckDB postgres attach connection string (libpq keyword/value format).",
    )
    args = parser.parse_args()

    report_count, line_item_count = load(args.export_path, args.postgres_dsn)
    print(f"loaded {report_count} expense_report rows")
    print(f"loaded {line_item_count} expense_line_item rows")


if __name__ == "__main__":
    main()
