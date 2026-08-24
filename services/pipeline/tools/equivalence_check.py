#!/usr/bin/env python3
"""Prove the spend total in DuckDB-over-Parquet matches DuckDB-over-Postgres
exactly, in one DuckDB session.

Both queries run through the same engine (DuckDB) against the same logical
row set (see valid_line_items.py: rows that could actually exist in a real
expense_line_item table — the export's amount/currency/duplicate-record_id
defects are excluded on both sides identically), so a mismatch can only be
a real data defect, not a difference in tooling or in what each side chose
to filter.

  - Parquet side: `read_parquet(..., hive_partitioning=true)` directly over
    the row-level archive on floci S3 — no intermediate load into a local
    dataframe or table.
  - Postgres side: `ATTACH ... (TYPE postgres)` against the live database,
    querying expense_line_item directly.

Exits non-zero and raises if the totals differ by even one cent. This is a
deliberately exact assertion, not a tolerance — see the module docstring in
tools/load_line_items_to_postgres.py and valid_line_items.py for why the
row sets should already be identical; if they are not, that gap IS the
finding this script exists to surface, not something to average away.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from valid_line_items import DEFAULT_POSTGRES_DSN  # noqa: E402


def parquet_total(con: duckdb.DuckDBPyConnection, bucket: str, prefix: str) -> tuple[int, int]:
    """Returns (row_count, total_spend_cents) read directly from Parquet on floci."""
    row_count, total_cents = con.execute(f"""
        SELECT count(*), sum(amount_cents)
        FROM read_parquet('s3://{bucket}/{prefix}/**/*.parquet', hive_partitioning=true)
    """).fetchone()
    return row_count, int(total_cents)


def postgres_total(con: duckdb.DuckDBPyConnection) -> tuple[int, int]:
    """Returns (row_count, total_spend_cents) read via ATTACH from live Postgres."""
    row_count, total_cents = con.execute("""
        SELECT count(*), sum(amount_cents)
        FROM pg.public.expense_line_item
    """).fetchone()
    return row_count, int(total_cents)


def run_equivalence_check(
    *,
    bucket: str,
    prefix: str,
    postgres_dsn: str,
    endpoint_url: str,
) -> None:
    con = duckdb.connect()

    con.execute("INSTALL httpfs;")
    con.execute("LOAD httpfs;")
    con.execute(f"""
        CREATE SECRET floci_s3 (
            TYPE s3,
            KEY_ID 'test',
            SECRET 'test',
            REGION 'us-east-1',
            ENDPOINT '{endpoint_url.split("://")[-1]}',
            URL_STYLE 'path',
            USE_SSL false
        );
    """)

    con.execute("INSTALL postgres;")
    con.execute("LOAD postgres;")
    con.execute(f"ATTACH '{postgres_dsn}' AS pg (TYPE postgres);")

    parquet_rows, parquet_cents = parquet_total(con, bucket, prefix)
    postgres_rows, postgres_cents = postgres_total(con)

    con.close()

    print(f"Parquet  (s3://{bucket}/{prefix}): {parquet_rows:,} rows, {parquet_cents:,} cents "
          f"(${parquet_cents / 100:,.2f})")
    print(f"Postgres (expense_line_item):       {postgres_rows:,} rows, {postgres_cents:,} cents "
          f"(${postgres_cents / 100:,.2f})")

    if parquet_rows != postgres_rows:
        raise AssertionError(
            f"ROW COUNT MISMATCH: Parquet has {parquet_rows:,} rows, "
            f"Postgres has {postgres_rows:,} rows. The two sides are not "
            f"summing the same row set — check the archive/load filters in "
            f"valid_line_items.py against what actually landed in each place."
        )

    # Exact equality, deliberately. A tolerance here would hide the one bug
    # this script exists to catch: a money value that passed through a
    # float somewhere and picked up a rounding error.
    if parquet_cents != postgres_cents:
        raise AssertionError(
            f"SPEND TOTAL MISMATCH: Parquet sums to {parquet_cents:,} cents, "
            f"Postgres sums to {postgres_cents:,} cents (difference: "
            f"{parquet_cents - postgres_cents:,} cents). Row counts match, so "
            f"this is not a filtering/row-scope difference — check for a "
            f"float in the money path on either side."
        )

    print(f"\nMATCH: both sides sum to exactly {parquet_cents:,} cents "
          f"(${parquet_cents / 100:,.2f}) over {parquet_rows:,} rows.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", default="expenseflow-valid-line-items-m9d1")
    parser.add_argument("--prefix", default="valid-line-items")
    parser.add_argument(
        "--postgres-dsn",
        default=DEFAULT_POSTGRES_DSN,
        help="DuckDB postgres attach connection string (libpq keyword/value format).",
    )
    parser.add_argument("--endpoint-url", default="http://localhost:4566")
    args = parser.parse_args()

    try:
        run_equivalence_check(
            bucket=args.bucket,
            prefix=args.prefix,
            postgres_dsn=args.postgres_dsn,
            endpoint_url=args.endpoint_url,
        )
    except AssertionError as error:
        print(f"\nFAIL: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
