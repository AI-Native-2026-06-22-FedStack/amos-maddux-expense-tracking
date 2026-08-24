"""Tests for validate.py's incoming-boundary enforcement: is_row_valid()
gates every row through models.ExpenseRow, so a missing required field, a
wrong-typed field, or a negative amount is genuinely rejected by the real
pipeline stage -- not only by the model in isolation (see test_models.py).

Also covers validate()'s quarantine wiring (quality.py's semantic checks
plus the QuarantineSink each rejected row is written to) using
InMemoryQuarantineSink -- the real S3-backed path is covered separately in
test_quarantine.py and its opt-in floci integration test.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))

from make_fixture import ROWS  # noqa: E402

from quarantine import InMemoryQuarantineSink  # noqa: E402
from validate import is_row_valid, validate  # noqa: E402

VALID_ROW = dict(ROWS[0])


def test_is_row_valid_accepts_a_genuinely_valid_row():
    assert is_row_valid(VALID_ROW) is True


def test_validate_stage_accepts_every_row_in_the_shared_fixture():
    result = validate([dict(row) for row in ROWS], run_id="all-valid-test")

    assert result.metrics.count_out == len(ROWS)
    assert result.metrics.count_bad == 0
    assert result.bad_rows == []


def test_validate_stage_rejects_a_row_missing_a_required_field():
    incomplete = dict(VALID_ROW)
    del incomplete["tenant_id"]

    result = validate([incomplete], run_id="missing-field-test")

    assert result.metrics.count_out == 0
    assert result.metrics.count_bad == 1
    assert result.bad_rows == [incomplete]


def test_validate_stage_rejects_a_wrong_typed_field():
    wrong_type = dict(VALID_ROW, amount_cents="not-a-number")

    result = validate([wrong_type], run_id="wrong-type-test")

    assert result.metrics.count_out == 0
    assert result.metrics.count_bad == 1


def test_validate_stage_rejects_a_negative_amount():
    negative = dict(VALID_ROW, amount_cents=-500)

    result = validate([negative], run_id="negative-amount-test")

    assert result.metrics.count_out == 0
    assert result.metrics.count_bad == 1
    assert result.bad_rows[0]["amount_cents"] == -500


def test_validate_stage_bad_rows_never_contain_an_unredacted_receipt_number():
    """A row rejected by validate() still lands in bad_rows (this stage's
    quarantine representation) -- but since extract.py redacts every row
    before validate() ever sees it, a rejected row's receipt_number must
    already be censored, never the original synthetic value.
    """
    invalid_row_with_receipt = dict(
        VALID_ROW,
        amount_cents=-500,  # forces rejection
        receipt_number="[REDACTED]",  # as extract.py would have left it
    )

    result = validate([invalid_row_with_receipt], run_id="quarantine-redaction-test")

    assert result.bad_rows[0]["receipt_number"] == "[REDACTED]"


# ---------------------------------------------------------------------------
# Semantic quality-check rejection + quarantine wiring
# ---------------------------------------------------------------------------


def test_validate_rejects_a_semantic_quality_failure_not_caught_by_expense_row():
    # amount_cents == 0 passes ExpenseRow (Pydantic only rejects < 0) but
    # must fail quality.py's non_positive_amount check.
    zero_amount = dict(VALID_ROW, amount_cents=0)

    result = validate([zero_amount], run_id="semantic-only-failure-test")

    assert result.metrics.count_out == 0
    assert result.metrics.count_bad == 1
    assert result.good_rows == []


def test_validate_writes_a_rejected_row_to_the_quarantine_sink():
    sink = InMemoryQuarantineSink()
    zero_amount = dict(VALID_ROW, amount_cents=0)

    validate([zero_amount], run_id="quarantine-write-test", quarantine_sink=sink)

    assert len(sink.written) == 1
    record = sink.written[0]
    assert record["check"] == "non_positive_amount"
    assert record["run_id"] == "quarantine-write-test"
    assert record["record_id"] == VALID_ROW["record_id"]
    assert record["tenant_id"] == VALID_ROW["tenant_id"]
    assert record["row"] == zero_amount


def test_validate_never_writes_a_valid_row_to_the_quarantine_sink():
    sink = InMemoryQuarantineSink()

    validate([dict(VALID_ROW)], run_id="no-quarantine-test", quarantine_sink=sink)

    assert sink.written == []


def test_validate_quarantines_a_row_that_fails_only_the_batch_level_duplicate_check():
    sink = InMemoryQuarantineSink()
    first_row = dict(VALID_ROW)
    duplicate_row = dict(VALID_ROW)  # same record_id, otherwise fully valid

    result = validate(
        [first_row, duplicate_row], run_id="duplicate-quarantine-test", quarantine_sink=sink
    )

    assert result.metrics.count_out == 1  # only the first occurrence survives
    assert result.metrics.count_bad == 1
    assert len(sink.written) == 1
    assert sink.written[0]["check"] == "duplicate_record_id"
    assert sink.written[0]["row_index"] == 1


def test_validate_writes_one_quarantine_record_per_failed_check_on_a_multi_failure_row():
    sink = InMemoryQuarantineSink()
    multi_failure_row = dict(VALID_ROW, amount_cents=0, gl_account_code="9999")

    validate([multi_failure_row], run_id="multi-failure-test", quarantine_sink=sink)

    checks_written = {record["check"] for record in sink.written}
    assert checks_written == {"non_positive_amount", "known_gl_code"}


def test_validate_counts_still_satisfy_conservation_with_quarantine_active():
    sink = InMemoryQuarantineSink()
    rows = [dict(VALID_ROW), dict(VALID_ROW, amount_cents=0), dict(VALID_ROW, tenant_id=None)]

    result = validate(rows, run_id="conservation-with-quarantine-test", quarantine_sink=sink)

    assert result.metrics.count_in == result.metrics.count_out + result.metrics.count_bad
    assert result.metrics.count_in == 3
