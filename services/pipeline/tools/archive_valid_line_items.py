#!/usr/bin/env python3
"""Write the export's valid, deduped expense_line_item rows (same row set
tools/load_line_items_to_postgres.py inserts into Postgres — see
valid_line_items.py) to Hive-partitioned Parquet, and upload to floci S3.

Partitioned by tenant_id, matching this codebase's tenant-scoped query
pattern and the spend-aggregate archive's own partitioning.

This is a row-level archive (one row per expense_line_item), distinct from
the pre-grouped spend-by-tenant-gl-month archive: it exists so DuckDB can
run the *same-shaped* SUM query against both Parquet and attached Postgres
in tools/equivalence_check.py — an apples-to-apples comparison rather than
comparing a pre-aggregated total (over every line item, valid or not) to
Postgres's total (which can only ever hold the valid subset).
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import duckdb

PIPELINE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PIPELINE_DIR))
from valid_line_items import valid_line_items_cte_sql  # noqa: E402

PARTITION_COLUMNS = ["tenant_id"]

ARCHIVE_COLUMNS = (
    "record_id",
    "tenant_id",
    "expense_report_id",
    "merchant",
    "amount_cents",
    "currency",
    "category",
    "gl_account_code",
    "gl_account_name",
    "gl_normal_balance",
    "gl_coding_status",
    "manager_review_status",
    "flagged",
    "deductible",
    # Cast to a real timestamp here, explicitly, matching schema.py's
    # DATETIME_UTC declaration and its ISO_DATETIME_FORMAT
    # ("%Y-%m-%dT%H:%M:%SZ") — created_at is read as VARCHAR everywhere
    # upstream (valid_line_items.py's DECLARED_NDJSON_COLUMNS) specifically
    # to avoid DuckDB's own date-parsing inference, so the cast to a real
    # date/datetime type happens exactly once, here, at the point this
    # column leaves the pipeline as an archived artifact.
    "created_at::timestamptz AS created_at",
)


def write_partitioned_parquet(export_path: Path, out_dir: Path) -> Path:
    con = duckdb.connect()
    cte = valid_line_items_cte_sql(str(export_path))
    dataset_dir = out_dir / "valid_line_items"
    dataset_dir.mkdir(parents=True, exist_ok=True)
    columns = ", ".join(ARCHIVE_COLUMNS)

    con.execute(f"""
        COPY (
            {cte}
            SELECT {columns} FROM valid_line_items
        )
        TO {str(dataset_dir)!r}
        (FORMAT PARQUET, PARTITION_BY (tenant_id), OVERWRITE_OR_IGNORE);
    """)
    con.close()
    return dataset_dir


def upload_to_floci(dataset_dir: Path, bucket: str, prefix: str, endpoint_url: str) -> None:
    subprocess.run(
        ["aws", "--endpoint-url", endpoint_url, "s3", "sync", str(dataset_dir), f"s3://{bucket}/{prefix}"],
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export_path", type=Path)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--prefix", default="valid-line-items")
    parser.add_argument("--endpoint-url", default="http://localhost:4566")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        dataset_dir = write_partitioned_parquet(args.export_path, Path(tmp))
        file_count = len(list(dataset_dir.rglob("*.parquet")))
        print(f"wrote {file_count} partition files to {dataset_dir}")

        upload_to_floci(dataset_dir, args.bucket, args.prefix, args.endpoint_url)
        print(f"uploaded to s3://{args.bucket}/{args.prefix}")


if __name__ == "__main__":
    main()
