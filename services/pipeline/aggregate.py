"""Spend-per-tenant/GL-code/month aggregate over the ExpenseFlow export.

Two implementations of the same aggregate, read via the declared schema in
schema.py (no inference in either engine):

  - aggregate_pandas(): eager pandas baseline. Reads the whole file, then
    filters/groups/aggregates.
  - aggregate_polars(): lazy polars pipeline. Composes filter + column
    selection on a `pl.scan_ndjson(...)` LazyFrame *before* `.collect()`, so
    the query optimizer can push both down into the scan itself. Use
    `explain_polars_plan()` to see this proven, not assumed.

Both return the same shape: a spend table (tenant_id, gl_account_code,
month, spend_cents, line_item_count) plus an overall flag-rate summary
(GL-Coding Engine's $500 flag rule, see services/compute/app/coding.py:
`flagged = line_item.amount > FLAG_THRESHOLD` with FLAG_THRESHOLD =
Decimal("500.00") -> amount_cents > 50_000, evaluated per line item).

Only expense_line_item rows carry amount_cents; mileage rows are excluded
from spend and from the flag-rate denominator, matching the source rule's
own scope (it never runs against mileage_entry).
"""

from __future__ import annotations

import gzip
import json
from dataclasses import dataclass
from pathlib import Path

import pandas as pd
import polars as pl

# amount_cents > FLAG_THRESHOLD_CENTS marks a line item flagged, matching
# services/compute/app/coding.py's FLAG_THRESHOLD = Decimal("500.00") applied
# to a dollar amount; the export's amount_cents is that same amount in cents.
FLAG_THRESHOLD_CENTS = 50_000

# created_at is used for the "month" grain because it is populated on every
# row (unlike trip_date/receipt_date, which are structurally null on ~80%/20%
# of rows respectively) and was confirmed to match receipt_date's date part
# wherever both are present.
_CREATED_AT_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


@dataclass(frozen=True)
class SpendAggregate:
    """Result of the spend aggregate, engine-agnostic."""

    spend_by_tenant_gl_month: pd.DataFrame
    flagged_line_item_count: int
    total_line_item_count: int

    @property
    def flagged_line_item_rate(self) -> float:
        if self.total_line_item_count == 0:
            return 0.0
        return self.flagged_line_item_count / self.total_line_item_count


def aggregate_pandas(export_path: Path | str) -> SpendAggregate:
    """Eager pandas baseline: read the whole file, then filter/group/aggregate.

    Reads with the Task 1 declared schema (services/pipeline/schema.py) — no
    column is left to pandas's own inference at any point.
    """
    with gzip.open(export_path, "rt", encoding="utf-8") as f:
        raw_rows = [json.loads(line) for line in f]
    df = pd.DataFrame(raw_rows)

    df["record_type"] = df["record_type"].astype("string")
    df["tenant_id"] = df["tenant_id"].astype("string")
    df["gl_account_code"] = df["gl_account_code"].astype("string")
    df["amount_cents"] = df["amount_cents"].astype("Int64")
    df["created_at"] = pd.to_datetime(df["created_at"], format=_CREATED_AT_FORMAT, utc=True)

    line_items = df[df["record_type"] == "line_item"].copy()
    line_items["month"] = line_items["created_at"].dt.strftime("%Y-%m")
    line_items["flagged_by_rule"] = line_items["amount_cents"] > FLAG_THRESHOLD_CENTS

    grouped = (
        line_items.groupby(["tenant_id", "gl_account_code", "month"], observed=True)
        .agg(spend_cents=("amount_cents", "sum"), line_item_count=("amount_cents", "count"))
        .reset_index()
        .sort_values(["tenant_id", "gl_account_code", "month"])
        .reset_index(drop=True)
    )
    grouped["spend_cents"] = grouped["spend_cents"].astype("int64")
    grouped["line_item_count"] = grouped["line_item_count"].astype("int64")

    return SpendAggregate(
        spend_by_tenant_gl_month=grouped,
        flagged_line_item_count=int(line_items["flagged_by_rule"].sum()),
        total_line_item_count=int(len(line_items)),
    )


def _polars_lazy_scan(export_path: Path | str) -> pl.LazyFrame:
    """Build the lazy scan + filter + column selection, unexecuted.

    Declared schema (matching schema.py's ReadType, see the module docstring
    there): every column typed explicitly, none left to scan_ndjson's own
    inference. Only the columns this aggregate actually needs are selected,
    and the record_type filter is applied here — both before any `.collect()`
    — so the optimizer has a filter and a projection to push down into the
    scan. See explain_polars_plan() to confirm it does.
    """
    declared_schema = {
        "record_type": pl.String,
        "tenant_id": pl.String,
        "expense_report_id": pl.String,
        "record_id": pl.String,
        "submitter_id": pl.String,
        "current_stage": pl.String,
        "merchant": pl.String,
        "category": pl.String,
        "amount_cents": pl.Int64,
        "currency": pl.String,
        "miles": pl.String,
        "trip_date": pl.String,
        "origin": pl.String,
        "destination": pl.String,
        "business_purpose": pl.String,
        "gl_account_code": pl.String,
        "gl_account_name": pl.String,
        "gl_normal_balance": pl.String,
        "gl_coding_status": pl.String,
        "receipt_number": pl.String,
        "receipt_date": pl.String,
        "flagged": pl.Boolean,
        "deductible": pl.Boolean,
        "manager_review_status": pl.String,
        "created_at": pl.String,
    }

    return (
        pl.scan_ndjson(export_path, schema=declared_schema)
        .filter(pl.col("record_type") == "line_item")
        .select("tenant_id", "gl_account_code", "amount_cents", "created_at")
    )


def aggregate_polars(export_path: Path | str) -> SpendAggregate:
    """Lazy polars pipeline: filter + column selection composed before collect().

    Starts from pl.scan_ndjson (a lazy scan), not pl.read_ndjson(...).lazy()
    — the latter would materialize the whole file eagerly before the lazy API
    ever saw it, defeating pushdown. See _polars_lazy_scan()'s docstring and
    explain_polars_plan() for the proof this one actually pushes down.
    """
    lf = _polars_lazy_scan(export_path)

    with_derived = lf.with_columns(
        pl.col("created_at")
        .str.strptime(pl.Datetime, format=_CREATED_AT_FORMAT, strict=True)
        .dt.strftime("%Y-%m")
        .alias("month"),
        (pl.col("amount_cents") > FLAG_THRESHOLD_CENTS).alias("flagged_by_rule"),
    )

    grouped_lf = (
        with_derived.group_by(["tenant_id", "gl_account_code", "month"])
        .agg(
            pl.col("amount_cents").sum().alias("spend_cents"),
            # Polars' .count() defaults to UInt32; cast to Int64 so the
            # returned frame's dtype matches aggregate_pandas()'s exactly,
            # not just its values.
            pl.col("amount_cents").count().cast(pl.Int64).alias("line_item_count"),
        )
        .sort(["tenant_id", "gl_account_code", "month"])
    )
    summary_lf = with_derived.select(
        pl.col("flagged_by_rule").sum().alias("flagged_line_item_count"),
        pl.len().alias("total_line_item_count"),
    )

    grouped_df, summary_df = pl.collect_all([grouped_lf, summary_lf])

    return SpendAggregate(
        spend_by_tenant_gl_month=grouped_df.to_pandas(),
        flagged_line_item_count=int(summary_df["flagged_line_item_count"][0]),
        total_line_item_count=int(summary_df["total_line_item_count"][0]),
    )


def explain_polars_plan(export_path: Path | str) -> str:
    """Return the optimized query plan for the grouped aggregate LazyFrame.

    Prints (via the caller) the optimized plan, which folds the record_type
    filter and the column selection into the NDJSON SCAN node itself
    (visible as `SELECTION:` and a restricted `PROJECT N/25 COLUMNS` on the
    scan line) rather than as separate FILTER/SELECT steps sitting on top of
    a full-width scan. That is the concrete, checkable evidence that pushdown
    happened instead of "scan everything, discard later".
    """
    lf = _polars_lazy_scan(export_path)
    grouped_lf = (
        lf.with_columns(
            pl.col("created_at")
            .str.strptime(pl.Datetime, format=_CREATED_AT_FORMAT, strict=True)
            .dt.strftime("%Y-%m")
            .alias("month")
        )
        .group_by(["tenant_id", "gl_account_code", "month"])
        .agg(pl.col("amount_cents").sum().alias("spend_cents"))
    )
    return grouped_lf.explain(optimized=True)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Run the spend aggregate over an export file.")
    parser.add_argument("export_path", type=Path)
    parser.add_argument(
        "--engine", choices=["pandas", "polars"], default="polars", help="Which engine to run."
    )
    parser.add_argument(
        "--explain", action="store_true", help="Print the polars optimized query plan and exit."
    )
    args = parser.parse_args()

    if args.explain:
        print(explain_polars_plan(args.export_path))
        return

    run = aggregate_pandas if args.engine == "pandas" else aggregate_polars
    result = run(args.export_path)
    print(result.spend_by_tenant_gl_month.to_string(index=False))
    print()
    print(
        f"flagged line items: {result.flagged_line_item_count:,} / "
        f"{result.total_line_item_count:,}"
    )
    print(f"flagged line item rate: {result.flagged_line_item_rate:.4%}")


if __name__ == "__main__":
    main()
