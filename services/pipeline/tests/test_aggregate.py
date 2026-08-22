"""Tests for services/pipeline/aggregate.py against a small, hand-authored fixture.

The fixture (tests/fixtures/tiny_export.jsonl.gz, built by
tests/fixtures/make_fixture.py) has 6 rows: 5 line items across 2 tenants,
2 GL codes (one written with a leading zero), 2 months, one flagged item
(> $500.00) and one at exactly $500.00 (must NOT be flagged, the rule is
strict >), plus 1 mileage row that must be excluded from spend and from the
flag denominator entirely.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aggregate import FLAG_THRESHOLD_CENTS, aggregate_pandas, aggregate_polars  # noqa: E402

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "tiny_export.jsonl.gz"

TENANT_A = "aaaaaaaa-0000-4000-8000-000000000001"
TENANT_B = "bbbbbbbb-0000-4000-8000-000000000002"


@pytest.fixture(params=[aggregate_pandas, aggregate_polars], ids=["pandas", "polars"])
def aggregate_fn(request):
    return request.param


def test_excludes_mileage_rows_from_line_item_count(aggregate_fn):
    result = aggregate_fn(FIXTURE_PATH)

    # 6 rows in the fixture, 1 is mileage -> 5 line items.
    assert result.total_line_item_count == 5


def test_flag_rule_is_strictly_greater_than_threshold(aggregate_fn):
    result = aggregate_fn(FIXTURE_PATH)

    # Two fixture rows exceed $500.00 (600.00 and 750.00); the $500.00-exact
    # row must NOT count, matching services/compute/app/coding.py's strict `>`.
    assert result.flagged_line_item_count == 2
    assert result.flagged_line_item_rate == pytest.approx(2 / 5)


def test_flag_threshold_constant_matches_gl_coding_engine():
    # services/compute/app/coding.py: FLAG_THRESHOLD = Decimal("500.00"),
    # compared against a dollar amount -> 50_000 cents.
    assert FLAG_THRESHOLD_CENTS == 50_000


def test_groups_by_tenant_gl_code_and_month(aggregate_fn):
    result = aggregate_fn(FIXTURE_PATH)
    grouped = result.spend_by_tenant_gl_month

    # 4 distinct (tenant, gl_account_code, month) groups expected:
    #   (A, 6100, 2026-01): rows 1+2  -> 60000 + 1000 = 61000 cents, count 2
    #   (A, 06200, 2026-01): row 3    -> 50000 cents, count 1
    #   (A, 6100, 2026-02): row 4     -> 2500 cents, count 1
    #   (B, 6100, 2026-01): row 5     -> 75000 cents, count 1
    assert len(grouped) == 4

    by_key = {
        (r.tenant_id, r.gl_account_code, r.month): r
        for r in grouped.itertuples(index=False)
    }

    a_6100_jan = by_key[(TENANT_A, "6100", "2026-01")]
    assert a_6100_jan.spend_cents == 61000
    assert a_6100_jan.line_item_count == 2

    a_leading_zero_gl_jan = by_key[(TENANT_A, "06200", "2026-01")]
    assert a_leading_zero_gl_jan.spend_cents == 50000
    assert a_leading_zero_gl_jan.line_item_count == 1

    a_6100_feb = by_key[(TENANT_A, "6100", "2026-02")]
    assert a_6100_feb.spend_cents == 2500

    b_6100_jan = by_key[(TENANT_B, "6100", "2026-01")]
    assert b_6100_jan.spend_cents == 75000


def test_leading_zero_gl_code_survives_as_distinct_string_key(aggregate_fn):
    result = aggregate_fn(FIXTURE_PATH)
    grouped = result.spend_by_tenant_gl_month

    gl_codes = set(grouped["gl_account_code"])
    # "06200" and "6100" must both appear as-is, distinct string values —
    # neither collapsed into the other nor coerced into an int that would
    # equate them.
    assert "06200" in gl_codes
    assert "6100" in gl_codes
    assert grouped["gl_account_code"].dtype in ("object", "string", "string[python]")


def test_total_spend_matches_sum_of_flagged_and_unflagged():
    pandas_result = aggregate_pandas(FIXTURE_PATH)
    polars_result = aggregate_polars(FIXTURE_PATH)

    expected_total = 60000 + 1000 + 50000 + 2500 + 75000
    assert pandas_result.spend_by_tenant_gl_month["spend_cents"].sum() == expected_total
    assert polars_result.spend_by_tenant_gl_month["spend_cents"].sum() == expected_total


def test_pandas_and_polars_agree_exactly():
    pandas_result = aggregate_pandas(FIXTURE_PATH)
    polars_result = aggregate_polars(FIXTURE_PATH)

    pandas_grouped = pandas_result.spend_by_tenant_gl_month.sort_values(
        ["tenant_id", "gl_account_code", "month"]
    ).reset_index(drop=True)
    polars_grouped = polars_result.spend_by_tenant_gl_month.sort_values(
        ["tenant_id", "gl_account_code", "month"]
    ).reset_index(drop=True)

    compare_cols = ["tenant_id", "gl_account_code", "month", "spend_cents", "line_item_count"]
    # Compare as plain Python values rather than via DataFrame.equals(): the
    # two engines' pandas-dtype conventions differ cosmetically (pandas's
    # own "string" extension dtype vs. polars-converted plain object/str,
    # int64 vs. a cast-from-uint32 int64), which .equals() treats as a
    # mismatch even when every value is identical. Values are what this
    # aggregate promises; exact pandas dtype provenance across two different
    # source engines is not part of that contract.
    for col in compare_cols:
        assert pandas_grouped[col].tolist() == polars_grouped[col].tolist(), f"mismatch in {col}"
    assert pandas_result.flagged_line_item_count == polars_result.flagged_line_item_count
    assert pandas_result.total_line_item_count == polars_result.total_line_item_count
