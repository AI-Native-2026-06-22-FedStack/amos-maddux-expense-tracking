"""Expected read schema for the ExpenseFlow analytical export (JSONL, gzip).

Source of truth for every column below is:
  1. apps/api/src/db/schema.ts (expense_line_item, receipt, mileage_entry) and
     services/compute/db/seeds/0001_default_gl_mappings.sql (GL codes stored as text).
  2. Direct inspection of data/exports/expense_export_seed42_rows*.jsonl.gz.
  3. notebooks/expense-export-eda.ipynb, re-run against the real export files
     (the checked-in notebook had no saved outputs) to confirm pandas's actual
     default inference on this environment's pandas 3.0.5 install.

This is a READ schema, not a cleaning pipeline: seeded defects (leading-zero
GL codes, non-positive amount_cents, US-format trip_date, null receipt_date
on a populated receipt, duplicate record_id) are preserved as their declared
type, not repaired. A cleaning/validation pass is a separate, later step.
"""

from __future__ import annotations

from enum import Enum


class ReadType(str, Enum):
    """Framework-agnostic column intent, one level above a pandas/Polars dtype.

    Kept deliberately narrower than a concrete dtype enum so this module has
    no pandas or Polars import: Task 2's reader maps each ReadType to that
    library's own dtype (e.g. STRING -> pandas "string"/pl.Utf8, INT64 ->
    pandas "Int64"/pl.Int64, DATE -> parsed via an explicit format string
    below, not left to the library's own date inference).
    """

    STRING = "string"          # exact text, never coerced to a number
    INT64 = "int64"            # whole-number counts/minor-unit money, nullable
    BOOL = "bool"               # true/false, no null observed in the export
    DATE = "date"               # calendar date, no time component
    DATETIME_UTC = "datetime_utc"  # instant with an explicit UTC offset


# Columns whose JSON values are strings but follow more than one textual
# layout (e.g. "2026-01-27" and "01/27/2026" both occur in trip_date, see
# notebooks/expense-export-eda.ipynb section 9/12). Declaring the expected
# formats here, rather than a bare DATE type, means a Task-2 reader can parse
# the common case explicitly and route anything else to an explicit rejection
# path instead of a silent, wrong parse.
ISO_DATE_FORMAT = "%Y-%m-%d"
US_DATE_FORMAT = "%m/%d/%Y"
ISO_DATETIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"

DATE_FORMATS_BY_COLUMN: dict[str, tuple[str, ...]] = {
    # trip_date is ISO in the common case; a seeded defect (~2% of mileage
    # rows) emits US-locale MM/DD/YYYY instead. Both are listed so a Task-2
    # parser tries them in order rather than guessing.
    "trip_date": (ISO_DATE_FORMAT, US_DATE_FORMAT),
    # receipt_date had no locale-drift defect seeded (only the separate
    # null-despite-receipt defect); ISO is the only format observed.
    "receipt_date": (ISO_DATE_FORMAT,),
    # created_at is always "<ISO date>T00:00:00Z" in the generator; no drift
    # defect targets this column.
    "created_at": (ISO_DATETIME_FORMAT,),
}


# One explicit entry per column in FIELD_ORDER
# (services/pipeline/tools/generate_export.py). Order matches the export.
SCHEMA: dict[str, ReadType] = {
    "record_type": ReadType.STRING,
    "tenant_id": ReadType.STRING,
    "expense_report_id": ReadType.STRING,
    "record_id": ReadType.STRING,
    "submitter_id": ReadType.STRING,
    "current_stage": ReadType.STRING,
    "merchant": ReadType.STRING,
    "category": ReadType.STRING,
    "amount_cents": ReadType.INT64,
    "currency": ReadType.STRING,
    "miles": ReadType.STRING,
    "trip_date": ReadType.DATE,
    "origin": ReadType.STRING,
    "destination": ReadType.STRING,
    "business_purpose": ReadType.STRING,
    "gl_account_code": ReadType.STRING,
    "gl_account_name": ReadType.STRING,
    "gl_normal_balance": ReadType.STRING,
    "gl_coding_status": ReadType.STRING,
    "receipt_number": ReadType.STRING,
    "receipt_date": ReadType.DATE,
    "flagged": ReadType.BOOL,
    "deductible": ReadType.BOOL,
    "manager_review_status": ReadType.STRING,
    "created_at": ReadType.DATETIME_UTC,
}

# Columns that are legitimately null in the raw export for structural reasons
# (record_type-dependent fields), not data-quality defects. A Task-2 reader
# should allow null on exactly these regardless of ReadType; null anywhere
# else is a candidate anomaly, not an expected shape.
NULLABLE_COLUMNS: frozenset[str] = frozenset(
    {
        "merchant",
        "amount_cents",
        "currency",
        "miles",
        "trip_date",
        "origin",
        "destination",
        "business_purpose",
        "receipt_number",
        "receipt_date",
    }
)

assert set(SCHEMA) == {
    "record_type", "tenant_id", "expense_report_id", "record_id", "submitter_id",
    "current_stage", "merchant", "category", "amount_cents", "currency", "miles",
    "trip_date", "origin", "destination", "business_purpose", "gl_account_code",
    "gl_account_name", "gl_normal_balance", "gl_coding_status", "receipt_number",
    "receipt_date", "flagged", "deductible", "manager_review_status", "created_at",
}, "SCHEMA must declare exactly the columns generate_export.py's FIELD_ORDER emits."
