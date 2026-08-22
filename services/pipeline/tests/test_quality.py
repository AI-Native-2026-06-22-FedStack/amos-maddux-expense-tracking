"""Tests for quality.py's five semantic/value-level data-quality checks.

Each check is tested with both a success case and a failure case. Where
the profile documents a real anomaly (non-positive amount, GL-code
formatting, receipt_number/receipt_date consistency, duplicate
record_id), the failure case matches that documented shape. tenant
presence has no documented profile failure (see quality.py's own
docstring for the mapping rationale), so its failure case is
synthetic -- there is no real anomaly to draw from.
"""

from __future__ import annotations

import sys
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))

from make_fixture import ROWS  # noqa: E402

from quality import (  # noqa: E402
    KNOWN_GL_ACCOUNT_CODES,
    QualityFailure,
    check_duplicate_record_id,
    check_known_gl_code,
    check_non_positive_amount,
    check_receipt_date_consistency,
    check_tenant_presence,
    run_all_quality_checks,
    run_row_level_checks,
)
from redaction import redact_row  # noqa: E402

VALID_LINE_ITEM = dict(ROWS[0])
VALID_MILEAGE = dict(ROWS[-1])


# ---------------------------------------------------------------------------
# Reference source
# ---------------------------------------------------------------------------


def test_known_gl_account_codes_are_derived_from_the_real_seed_file():
    # The reference set must come from the actual gl_code seed
    # (services/compute/db/seeds/0001_default_gl_mappings.sql), not an
    # independently maintained copy.
    assert KNOWN_GL_ACCOUNT_CODES == frozenset({"6100", "6200", "6300", "6400", "6900"})


# ---------------------------------------------------------------------------
# Check 1: non-positive amount (profile: 32,097 rows, "0 or negative")
# ---------------------------------------------------------------------------


def test_non_positive_amount_passes_a_genuinely_positive_amount():
    assert check_non_positive_amount(VALID_LINE_ITEM) is None


def test_non_positive_amount_fails_on_zero():
    row = dict(VALID_LINE_ITEM, amount_cents=0)

    failure = check_non_positive_amount(row)

    assert failure is not None
    assert failure.check == "non_positive_amount"
    assert failure.record_id == VALID_LINE_ITEM["record_id"]
    assert failure.tenant_id == VALID_LINE_ITEM["tenant_id"]
    assert "non-positive" in failure.reason
    assert "0" in failure.reason


def test_non_positive_amount_fails_on_negative():
    row = dict(VALID_LINE_ITEM, amount_cents=-100)

    failure = check_non_positive_amount(row)

    assert failure is not None
    assert failure.check == "non_positive_amount"
    assert "-100" in failure.reason


def test_non_positive_amount_ignores_structurally_null_mileage_rows():
    # amount_cents is null on every mileage row -- not a quality defect.
    assert VALID_MILEAGE["amount_cents"] is None
    assert check_non_positive_amount(VALID_MILEAGE) is None


# ---------------------------------------------------------------------------
# Check 2: known GL code (profile: leading-zero/whitespace, 39,908 rows,
# used here as realistic formatted-but-known test fixtures)
# ---------------------------------------------------------------------------


def test_known_gl_code_passes_an_exact_known_code():
    assert check_known_gl_code(VALID_LINE_ITEM) is None


def test_known_gl_code_passes_a_leading_zero_formatted_known_code():
    # Profile-documented defect shape ("06100"): a real, known account
    # code with a formatting quirk. Must PASS -- the code names a real
    # account, it is just written oddly.
    row = dict(VALID_LINE_ITEM, gl_account_code="06100")

    assert check_known_gl_code(row) is None


def test_known_gl_code_passes_a_whitespace_padded_known_code():
    # Profile-documented defect shape ("6400 ").
    row = dict(VALID_LINE_ITEM, gl_account_code="6400 ")

    assert check_known_gl_code(row) is None


def test_known_gl_code_fails_a_code_matching_no_known_account():
    row = dict(VALID_LINE_ITEM, gl_account_code="9999")

    failure = check_known_gl_code(row)

    assert failure is not None
    assert failure.check == "known_gl_code"
    assert "9999" in failure.reason
    assert failure.record_id == VALID_LINE_ITEM["record_id"]


# ---------------------------------------------------------------------------
# Check 3: tenant presence (defensive; no profile failure evidence)
# ---------------------------------------------------------------------------


def test_tenant_presence_passes_a_real_tenant_id():
    assert check_tenant_presence(VALID_LINE_ITEM) is None


def test_tenant_presence_fails_on_missing_tenant_id():
    row = dict(VALID_LINE_ITEM, tenant_id=None)

    failure = check_tenant_presence(row)

    assert failure is not None
    assert failure.check == "tenant_presence"
    assert "missing" in failure.reason or "blank" in failure.reason


def test_tenant_presence_fails_on_blank_tenant_id():
    row = dict(VALID_LINE_ITEM, tenant_id="   ")

    failure = check_tenant_presence(row)

    assert failure is not None
    assert failure.check == "tenant_presence"


# ---------------------------------------------------------------------------
# Check 4: receipt_number/receipt_date consistency (profile: 31,743 rows)
# ---------------------------------------------------------------------------


def test_receipt_date_consistency_passes_when_both_are_populated():
    assert check_receipt_date_consistency(VALID_LINE_ITEM) is None


def test_receipt_date_consistency_passes_when_neither_is_populated():
    # Mileage rows have both null structurally -- not a defect.
    assert check_receipt_date_consistency(VALID_MILEAGE) is None


def test_receipt_date_consistency_fails_when_receipt_number_set_but_date_null():
    row = dict(VALID_LINE_ITEM, receipt_date=None)

    failure = check_receipt_date_consistency(row)

    assert failure is not None
    assert failure.check == "receipt_date_consistency"
    assert failure.record_id == VALID_LINE_ITEM["record_id"]


def test_receipt_date_consistency_ignores_mileage_rows():
    # record_type != "line_item" is out of this check's scope entirely,
    # even if receipt fields were somehow populated.
    row = dict(VALID_MILEAGE, receipt_number="RCT-000999", receipt_date=None)

    assert check_receipt_date_consistency(row) is None


def test_receipt_date_consistency_reason_never_echoes_the_receipt_number_value():
    row = dict(VALID_LINE_ITEM, receipt_number="RCT-SUPER-SECRET-999", receipt_date=None)

    failure = check_receipt_date_consistency(row)

    assert failure is not None
    assert "RCT-SUPER-SECRET-999" not in failure.reason


def test_receipt_date_consistency_works_on_an_already_redacted_row():
    # Rows reaching quality checks have already passed through
    # extract.py's redaction -- receipt_number arrives as the literal
    # censor token, not real content. The check must still fire correctly
    # (redaction censors the value, it does not remove the field).
    row = dict(VALID_LINE_ITEM, receipt_date=None)
    redacted = redact_row(row)

    assert redacted["receipt_number"] == "[REDACTED]"
    failure = check_receipt_date_consistency(redacted)

    assert failure is not None
    assert "[REDACTED]" not in failure.reason


# ---------------------------------------------------------------------------
# Check 5: duplicate record_id (profile: 39,920 rows, "Defect 6",
# batch-level)
# ---------------------------------------------------------------------------


def test_duplicate_record_id_passes_a_batch_with_all_unique_ids():
    rows = [dict(row) for row in ROWS]

    failures = check_duplicate_record_id(rows)

    assert failures == []


def test_duplicate_record_id_fails_when_a_later_row_reuses_an_earlier_id():
    first_row = dict(VALID_LINE_ITEM)
    duplicate_row = dict(VALID_LINE_ITEM)  # same record_id as first_row

    failures = check_duplicate_record_id([first_row, duplicate_row])

    assert len(failures) == 1
    assert failures[0].check == "duplicate_record_id"
    assert failures[0].record_id == VALID_LINE_ITEM["record_id"]
    assert failures[0].row_index == 1  # the repeat, not the first occurrence


def test_duplicate_record_id_only_flags_the_repeat_not_the_original():
    first_row = dict(VALID_LINE_ITEM)
    other_row = dict(VALID_LINE_ITEM, record_id="different-id")
    duplicate_row = dict(VALID_LINE_ITEM)  # duplicates first_row again

    failures = check_duplicate_record_id([first_row, other_row, duplicate_row])

    assert len(failures) == 1
    assert failures[0].row_index == 2


def test_duplicate_record_id_cannot_be_determined_from_a_single_row():
    # Documents the row-level vs. batch-level distinction directly: a
    # single-row "batch" can never contain a duplicate.
    assert check_duplicate_record_id([dict(VALID_LINE_ITEM)]) == []


# ---------------------------------------------------------------------------
# Aggregate helpers
# ---------------------------------------------------------------------------


def test_run_row_level_checks_returns_empty_for_a_fully_valid_row():
    assert run_row_level_checks(VALID_LINE_ITEM) == []


def test_run_row_level_checks_can_return_multiple_failures_for_one_row():
    row = dict(VALID_LINE_ITEM, amount_cents=-1, gl_account_code="9999", tenant_id=None)

    failures = run_row_level_checks(row)
    check_names = {f.check for f in failures}

    assert check_names == {"non_positive_amount", "known_gl_code", "tenant_presence"}


def test_run_all_quality_checks_passes_the_real_fixture_clean():
    rows = [dict(row) for row in ROWS]

    failures = run_all_quality_checks(rows)

    assert failures == []


def test_run_all_quality_checks_combines_row_level_and_batch_level_failures():
    duplicate_row = dict(VALID_LINE_ITEM)  # duplicates VALID_LINE_ITEM's record_id
    bad_amount_row = dict(VALID_LINE_ITEM, record_id="unique-id", amount_cents=0)

    failures = run_all_quality_checks([VALID_LINE_ITEM, duplicate_row, bad_amount_row])
    check_names = {f.check for f in failures}

    assert "duplicate_record_id" in check_names
    assert "non_positive_amount" in check_names


# ---------------------------------------------------------------------------
# QualityFailure shape
# ---------------------------------------------------------------------------


def test_quality_failure_is_a_typed_frozen_record():
    failure = QualityFailure(
        check="non_positive_amount", reason="test", record_id="r1", tenant_id="t1"
    )

    assert failure.check == "non_positive_amount"
    assert failure.row_index is None  # default for row-level checks
    with pytest.raises(FrozenInstanceError):
        failure.reason = "mutated"
