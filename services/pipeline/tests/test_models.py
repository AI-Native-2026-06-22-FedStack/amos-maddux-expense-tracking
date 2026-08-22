"""Tests for services/pipeline/models.py's two Pydantic v2 boundary models:

  - ExpenseRow: the incoming boundary (raw export row -> extract.py).
  - AnalyticsRow: the outgoing boundary (grouped aggregate row ->
    postgres_sink.py, immediately before the INSERT).

Uses model_validate() exclusively (never parse_obj), and only
field_validator/model_config for custom behavior (never @validator or a v1
class Config) per the Pydantic v2 conventions this codebase already
established in services/compute/app/gl_coding_contract.py.
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))

from make_fixture import ROWS  # noqa: E402

from models import AnalyticsRow, ExpenseRow  # noqa: E402

VALID_LINE_ITEM_ROW = copy.deepcopy(ROWS[0])
VALID_MILEAGE_ROW = copy.deepcopy(ROWS[-1])

VALID_ANALYTICS_ROW = {
    "tenant_id": "aaaaaaaa-0000-4000-8000-000000000001",
    "gl_account_code": "06200",
    "month": "2026-01",
    "spend_cents": 50000,
    "line_item_count": 1,
    "run_id": "run-1",
}


# ---------------------------------------------------------------------------
# ExpenseRow: valid input shapes (both record types, from the shared fixture)
# ---------------------------------------------------------------------------


def test_expense_row_accepts_a_valid_line_item_row():
    row = ExpenseRow.model_validate(VALID_LINE_ITEM_ROW)

    assert row.record_type == "line_item"
    assert row.tenant_id == VALID_LINE_ITEM_ROW["tenant_id"]
    assert row.amount_cents == 60000
    assert row.gl_account_code == "6100"


def test_expense_row_accepts_a_valid_mileage_row_with_structural_nulls():
    row = ExpenseRow.model_validate(VALID_MILEAGE_ROW)

    assert row.record_type == "mileage"
    # Structurally null on mileage rows per schema.py's NULLABLE_COLUMNS.
    assert row.amount_cents is None
    assert row.merchant is None
    assert row.currency is None
    assert row.receipt_number is None
    assert row.receipt_date is None
    # Populated only on mileage rows.
    assert row.miles == "42.00"
    assert row.trip_date is not None


def test_expense_row_preserves_leading_zero_gl_account_code_as_text():
    row = ExpenseRow.model_validate(copy.deepcopy(ROWS[2]))  # gl_account_code "06200"

    assert row.gl_account_code == "06200"


def test_expense_row_parses_the_seeded_us_format_trip_date_defect():
    # schema.py documents a seeded defect: trip_date written MM/DD/YYYY
    # instead of ISO. The boundary must parse it via the declared alternate
    # format, not reject it -- this is not a Task 3 quality rule, it is the
    # format schema.py already declares as expected.
    row = ExpenseRow.model_validate(dict(VALID_MILEAGE_ROW, trip_date="01/08/2026"))

    assert row.trip_date.isoformat() == "2026-01-08"


def test_expense_row_accepts_zero_amount_cents_as_a_preserved_defect():
    # Zero is a documented seeded defect (non-positive amount_cents) that
    # this boundary deliberately does NOT reject -- only a true negative is
    # rejected here (see models.py's ExpenseRow docstring). Rejecting the
    # full non-positive range is the later Task 3 quality suite's job.
    row = ExpenseRow.model_validate(dict(VALID_LINE_ITEM_ROW, amount_cents=0))

    assert row.amount_cents == 0


def test_expense_row_accepts_the_lowercase_currency_defect_unrepaired():
    # Another documented seeded defect (lowercase currency) that this
    # boundary preserves rather than rejects or repairs.
    row = ExpenseRow.model_validate(dict(VALID_LINE_ITEM_ROW, currency="usd"))

    assert row.currency == "usd"


# ---------------------------------------------------------------------------
# ExpenseRow: required failure scenarios
# ---------------------------------------------------------------------------


def test_expense_row_missing_required_field_identifies_the_field():
    incomplete = dict(VALID_LINE_ITEM_ROW)
    del incomplete["tenant_id"]

    with pytest.raises(ValidationError) as exc_info:
        ExpenseRow.model_validate(incomplete)

    errors = exc_info.value.errors()
    assert len(errors) == 1
    assert errors[0]["loc"] == ("tenant_id",)
    assert errors[0]["type"] == "missing"


def test_expense_row_wrong_type_identifies_the_field_and_preserves_the_bad_value():
    wrong_type = dict(VALID_LINE_ITEM_ROW, amount_cents="not-a-number")

    with pytest.raises(ValidationError) as exc_info:
        ExpenseRow.model_validate(wrong_type)

    errors = exc_info.value.errors()
    assert len(errors) == 1
    assert errors[0]["loc"] == ("amount_cents",)
    assert errors[0]["type"] == "int_parsing"
    # The invalid input value itself must be preserved in the error detail
    # so a caller/log can identify exactly what was rejected.
    assert errors[0]["input"] == "not-a-number"


def test_expense_row_negative_amount_identifies_the_field_and_preserves_the_value():
    negative = dict(VALID_LINE_ITEM_ROW, amount_cents=-500)

    with pytest.raises(ValidationError) as exc_info:
        ExpenseRow.model_validate(negative)

    errors = exc_info.value.errors()
    assert len(errors) == 1
    assert errors[0]["loc"] == ("amount_cents",)
    assert errors[0]["type"] == "value_error"
    assert errors[0]["input"] == -500
    assert "negative" in str(errors[0]["ctx"]["error"])


def test_expense_row_unexpected_extra_field_is_rejected():
    with_extra = dict(VALID_LINE_ITEM_ROW, unexpected_column="surprise")

    with pytest.raises(ValidationError) as exc_info:
        ExpenseRow.model_validate(with_extra)

    errors = exc_info.value.errors()
    assert any(error["type"] == "extra_forbidden" for error in errors)


def test_expense_row_rejects_a_date_matching_neither_declared_format():
    bad_date = dict(VALID_MILEAGE_ROW, trip_date="2026/01/08")  # neither ISO nor MM/DD/YYYY

    with pytest.raises(ValidationError) as exc_info:
        ExpenseRow.model_validate(bad_date)

    errors = exc_info.value.errors()
    assert errors[0]["loc"] == ("trip_date",)
    assert errors[0]["input"] == "2026/01/08"


@pytest.mark.parametrize(
    "field_name",
    [
        "record_type",
        "tenant_id",
        "expense_report_id",
        "record_id",
        "submitter_id",
        "current_stage",
        "category",
        "gl_account_code",
        "gl_account_name",
        "gl_normal_balance",
        "gl_coding_status",
        "flagged",
        "deductible",
        "manager_review_status",
        "created_at",
    ],
)
def test_expense_row_missing_any_non_nullable_field_fails(field_name):
    incomplete = dict(VALID_LINE_ITEM_ROW)
    del incomplete[field_name]

    with pytest.raises(ValidationError) as exc_info:
        ExpenseRow.model_validate(incomplete)

    errors = exc_info.value.errors()
    assert any(error["loc"] == (field_name,) and error["type"] == "missing" for error in errors)


# ---------------------------------------------------------------------------
# AnalyticsRow: valid shape, immutability, and negative line_item_count
# ---------------------------------------------------------------------------


def test_analytics_row_accepts_the_actual_persisted_shape():
    row = AnalyticsRow.model_validate(VALID_ANALYTICS_ROW)

    assert row.tenant_id == VALID_ANALYTICS_ROW["tenant_id"]
    assert row.gl_account_code == "06200"
    assert row.month == "2026-01"
    assert row.spend_cents == 50000
    assert row.line_item_count == 1
    assert row.run_id == "run-1"


def test_analytics_row_is_frozen_after_validation():
    row = AnalyticsRow.model_validate(VALID_ANALYTICS_ROW)

    with pytest.raises(ValidationError):
        row.spend_cents = 999


def test_analytics_row_rejects_negative_line_item_count():
    with pytest.raises(ValidationError) as exc_info:
        AnalyticsRow.model_validate(dict(VALID_ANALYTICS_ROW, line_item_count=-1))

    errors = exc_info.value.errors()
    assert errors[0]["loc"] == ("line_item_count",)
    assert errors[0]["type"] == "value_error"


def test_analytics_row_strict_mode_rejects_string_to_int_coercion():
    # strict=True: a stringly-typed spend_cents must not silently coerce,
    # since this model describes already-aggregated, trusted output --
    # coercion here would hide an upstream aggregation-type bug.
    with pytest.raises(ValidationError) as exc_info:
        AnalyticsRow.model_validate(dict(VALID_ANALYTICS_ROW, spend_cents="50000"))

    errors = exc_info.value.errors()
    assert errors[0]["loc"] == ("spend_cents",)
    assert errors[0]["type"] == "int_type"


def test_analytics_row_rejects_unexpected_extra_field():
    with pytest.raises(ValidationError) as exc_info:
        AnalyticsRow.model_validate(dict(VALID_ANALYTICS_ROW, loaded_at="2026-01-01T00:00:00Z"))

    errors = exc_info.value.errors()
    assert any(error["type"] == "extra_forbidden" for error in errors)


def test_analytics_row_missing_required_field_identifies_the_field():
    incomplete = dict(VALID_ANALYTICS_ROW)
    del incomplete["run_id"]

    with pytest.raises(ValidationError) as exc_info:
        AnalyticsRow.model_validate(incomplete)

    errors = exc_info.value.errors()
    assert errors[0]["loc"] == ("run_id",)
    assert errors[0]["type"] == "missing"
