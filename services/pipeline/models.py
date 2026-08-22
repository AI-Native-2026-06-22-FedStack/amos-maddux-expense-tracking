"""Pydantic v2 boundary models for the two edges of the pipeline:

  - ExpenseRow: the incoming boundary, validated when a raw export row
    enters the pipeline (extract.py). Fields and nullability come from
    services/pipeline/schema.py's SCHEMA/NULLABLE_COLUMNS -- the Deliverable
    1 read-schema contract -- not invented here.
  - AnalyticsRow: the outgoing boundary, validated immediately before a
    grouped row is written to pipeline_analytics.spend_by_tenant_gl_month
    (postgres_sink.py). Fields come from that table's actual DDL
    (db/migrations/0001_pipeline_analytics_schema.sql) and
    postgres_sink.py's own _INSERT_COLUMNS.

Follows services/compute/app/gl_coding_contract.py's established Pydantic
v2 style in this codebase: BaseModel + model_config = ConfigDict(...), no
class Config, no @validator, no parse_obj -- model_validate() and
field_validator() only.

ExpenseRow deliberately does NOT repair or reject most of the seeded
export defects documented in docs/data/expense-export-profile.md
(lowercase currency, leading-zero/padded gl_account_code, non-positive
amount_cents, duplicate record_id): schema.py's own docstring is explicit
that this is "a READ schema, not a cleaning pipeline," and a full
data-quality rule suite is a later, separate step. The one exception is a
negative amount_cents, which this boundary rejects outright as a
defense-in-depth structural guarantee (a negative charge is not a
plausible expense in any downstream reading, unlike zero or a malformed
GL code, which are ambiguous enough to defer to the later quality suite).
This is intentionally narrower than the profile doc's "non-positive"
defect definition (which also flags exactly zero) -- zero remains
preserved and unrejected here, exactly like every other seeded defect.

trip_date/receipt_date/created_at are parsed against schema.py's own
declared formats (DATE_FORMATS_BY_COLUMN/ISO_DATETIME_FORMAT) rather than
left as raw strings or handed to Pydantic's own date/datetime inference:
schema.py already declares the two formats a Task-2 reader must try
(ISO first, then the seeded US-locale trip_date defect), so applying that
declared, explicit parsing at this boundary is not new date-parsing logic,
it is the same contract schema.py already states, enforced where a row
first enters the pipeline.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, ValidationInfo, field_validator

from schema import DATE_FORMATS_BY_COLUMN, ISO_DATETIME_FORMAT

RecordType = Literal["line_item", "mileage"]
ExpenseCategory = Literal["Meals", "Lodging", "Mileage", "Supplies", "Other"]
GlNormalBalance = Literal["debit", "credit"]
GlCodingStatus = Literal["mapped", "unmapped"]
ManagerReviewStatus = Literal["pending", "approved", "rejected"]


def _parse_declared_date(value: str, column: str) -> date:
    """Try schema.py's declared formats for `column`, in order, raising a
    ValueError (which field_validator wraps into the field's ValidationError)
    if none match -- the same explicit-formats-or-reject contract
    schema.py's DATE_FORMATS_BY_COLUMN docstring already describes.
    """
    for fmt in DATE_FORMATS_BY_COLUMN[column]:
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue

    tried = " or ".join(DATE_FORMATS_BY_COLUMN[column])
    raise ValueError(f"{column} {value!r} does not match the declared format ({tried})")


class ExpenseRow(BaseModel):
    """Incoming boundary: one raw expense-export row (extract.py).

    Field set and nullability match schema.py's SCHEMA/NULLABLE_COLUMNS
    exactly -- 25 fields, 10 nullable on exactly the columns that are
    structurally null depending on record_type (line_item vs. mileage).
    extra="forbid" so an unexpected column is a validation failure here,
    not a silent pass-through.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    record_type: RecordType
    tenant_id: str
    expense_report_id: str
    record_id: str
    submitter_id: str
    current_stage: str
    merchant: str | None
    category: ExpenseCategory
    amount_cents: int | None
    currency: str | None
    miles: str | None
    trip_date: date | None
    origin: str | None
    destination: str | None
    business_purpose: str | None
    gl_account_code: str
    gl_account_name: str
    gl_normal_balance: GlNormalBalance
    gl_coding_status: GlCodingStatus
    receipt_number: str | None
    receipt_date: date | None
    flagged: bool
    deductible: bool
    manager_review_status: ManagerReviewStatus
    created_at: datetime

    @field_validator("amount_cents")
    @classmethod
    def reject_negative_amount(cls, value: int | None) -> int | None:
        # Defense-in-depth structural guarantee, kept independently
        # testable from the later Task 3 semantic quality suite (which
        # will also flag non-positive amounts as part of a broader rule
        # set): a negative amount_cents fails at the boundary, before any
        # row carrying it can reach validation-error text, quarantine, or
        # persistence. Zero and null are left untouched -- both remain
        # among the seeded defects/structural nulls this boundary
        # preserves rather than repairs.
        if value is not None and value < 0:
            raise ValueError("amount_cents must not be negative")
        return value

    @field_validator("trip_date", "receipt_date", mode="before")
    @classmethod
    def parse_declared_date(cls, value: object, info: ValidationInfo) -> object:
        if value is None or isinstance(value, date):
            return value
        if not isinstance(value, str):
            raise ValueError(f"{info.field_name} must be a string or null, got {type(value)!r}")
        return _parse_declared_date(value, info.field_name)

    @field_validator("created_at", mode="before")
    @classmethod
    def parse_created_at(cls, value: object) -> object:
        if isinstance(value, datetime):
            return value
        if not isinstance(value, str):
            raise ValueError(f"created_at must be a string, got {type(value)!r}")
        return datetime.strptime(value, ISO_DATETIME_FORMAT)


class AnalyticsRow(BaseModel):
    """Outgoing boundary: one row as actually persisted to
    pipeline_analytics.spend_by_tenant_gl_month (postgres_sink.py).

    Field set matches that table's DDL
    (db/migrations/0001_pipeline_analytics_schema.sql) and
    postgres_sink.py's _INSERT_COLUMNS exactly -- tenant_id,
    gl_account_code, month, spend_cents, line_item_count, run_id.
    loaded_at is excluded: it is a database-assigned default
    (`timestamptz not null default now()`), never a value the pipeline
    itself constructs or writes.

    Unlike ExpenseRow, this model describes fully-aggregated, trusted
    pipeline output (not raw external input), so it is frozen and
    strict-checked: nothing downstream of aggregate.py should be able to
    mutate a validated analytics row, and no implicit type coercion should
    paper over an aggregation bug.
    """

    model_config = ConfigDict(frozen=True, extra="forbid", strict=True, str_strip_whitespace=True)

    tenant_id: str
    gl_account_code: str
    month: str
    spend_cents: int
    line_item_count: int
    run_id: str

    @field_validator("line_item_count")
    @classmethod
    def reject_negative_line_item_count(cls, value: int) -> int:
        # Matches the analytics table's own
        # spend_by_tenant_gl_month_line_item_count_check constraint
        # (line_item_count >= 0) -- a row that fails this in Python should
        # fail before the INSERT is even attempted, not rely on Postgres
        # to reject it.
        if value < 0:
            raise ValueError("line_item_count must not be negative")
        return value
