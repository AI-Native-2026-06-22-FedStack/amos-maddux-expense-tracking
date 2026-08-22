"""Validate stage: incoming-boundary Pydantic validation, semantic data-
quality checks, quarantine of rejected rows, and the conservation
invariant.

Every row goes through two gates, in order:

  1. models.ExpenseRow (the incoming-boundary contract derived from
     schema.py's SCHEMA/NULLABLE_COLUMNS -- see models.py's own
     docstring): a missing required field, a wrong-typed field, a
     negative amount_cents, an unexpected extra column, or a date not
     matching schema.py's declared formats.
  2. quality.run_row_level_checks() (semantic/value-level checks -- see
     quality.py's own docstring for the full mapping to
     docs/data/expense-export-profile.md's documented anomalies):
     non-positive amount, unknown GL code, missing tenant, and the
     receipt_number/receipt_date consistency defect.

A row failing either gate is routed to bad_rows (contributing to
StageMetrics.count_bad, never count_out) and quarantined via
quarantine.QuarantineSink -- both happen from the same failure list, so a
row cannot become "bad" without also being quarantined. Because
extract.py redacts every row before this stage ever sees it, both
bad_rows and the quarantine record only ever contain already-redacted
data -- an invalid row's receipt_number or other sensitive field cannot
reach either representation in its original form.

quality.check_duplicate_record_id() is batch-level (see quality.py) and
is run once over the whole incoming batch, after the row-level gates: a
row already rejected by ExpenseRow or a row-level quality check is still
included in the duplicate-record_id scan (record_id itself does not
depend on those other checks passing), but a row that fails only the
duplicate check and nothing else is quarantined and counted as bad here
for the first time.

good_rows/bad_rows still hold plain dicts, not ExpenseRow instances:
ExpenseRow validation is a pass/fail gate only, and the parsed instance is
discarded -- the original (already-redacted) dict is what continues
downstream or is quarantined. This matters because transform.py
re-serializes good_rows to JSON for aggregate_polars(), which expects the
export's own raw string/int shapes (e.g. created_at as
"%Y-%m-%dT%H:%M:%SZ" text) -- a parsed ExpenseRow's date/datetime fields
would change that shape and are not what aggregate.py's declared schema
reader expects.

The conservation invariant (count_in == count_out + count_bad) is checked
with metrics.check_conservation(), which raises ConservationError -- not a
log line -- so a violation stops the pipeline run at run.py rather than
continuing on an inconsistent row count.
"""

from __future__ import annotations

from dataclasses import dataclass

from pydantic import ValidationError

from metrics import StageMetrics, check_conservation
from models import ExpenseRow
from quality import QualityFailure, check_duplicate_record_id, run_row_level_checks
from quarantine import InMemoryQuarantineSink, QuarantineSink

STAGE_NAME = "validate"


@dataclass(frozen=True)
class ValidateResult:
    good_rows: list[dict[str, object]]
    bad_rows: list[dict[str, object]]
    metrics: StageMetrics


def is_row_valid(row: dict[str, object]) -> bool:
    """True iff `row` satisfies models.ExpenseRow -- the incoming-boundary
    contract: every required field present, correctly typed, amount_cents
    not negative, and any date field matching schema.py's declared
    formats. Semantic quality checks (quality.py) are a separate,
    additional gate applied in validate() below -- this function alone is
    not the full incoming-boundary decision.
    """
    try:
        ExpenseRow.model_validate(row)
    except ValidationError:
        return False
    return True


def row_failures(row: dict[str, object]) -> list[QualityFailure]:
    """All reasons a single row would be rejected: the ExpenseRow gate
    (reported as one synthetic QualityFailure with check="expense_row",
    so a Pydantic rejection and a quality-check rejection quarantine
    identically) plus every row-level quality.py check. Does not include
    the batch-level duplicate-record_id check -- see validate()'s own
    docstring for why that runs separately, over the whole batch.
    """
    failures: list[QualityFailure] = []

    if not is_row_valid(row):
        failures.append(
            QualityFailure(
                check="expense_row",
                reason="row failed incoming-boundary validation (models.ExpenseRow)",
                record_id=str(row.get("record_id", "")),
                tenant_id=str(row.get("tenant_id", "")),
            )
        )

    failures.extend(run_row_level_checks(row))
    return failures


def validate(
    rows: list[dict[str, object]],
    run_id: str,
    quarantine_sink: QuarantineSink | None = None,
) -> ValidateResult:
    sink = quarantine_sink if quarantine_sink is not None else InMemoryQuarantineSink()

    # One failure list per row index, gathering both the row-level gates
    # (ExpenseRow + quality.py's row-level checks) and the batch-level
    # duplicate-record_id check, before deciding good vs. bad -- so a row
    # failing only the batch-level check is still handled by the exact
    # same single pass as a row failing a row-level one.
    failures_by_index: list[list[QualityFailure]] = [row_failures(row) for row in rows]
    for duplicate_failure in check_duplicate_record_id(rows):
        index = duplicate_failure.row_index
        if index is not None:
            failures_by_index[index].append(duplicate_failure)

    good_rows: list[dict[str, object]] = []
    bad_rows: list[dict[str, object]] = []

    for row, failures in zip(rows, failures_by_index, strict=True):
        if failures:
            bad_rows.append(row)
            for failure in failures:
                sink.write(row, run_id, failure)
        else:
            good_rows.append(row)

    metrics = StageMetrics(
        stage=STAGE_NAME,
        run_id=run_id,
        count_in=len(rows),
        count_out=len(good_rows),
        count_bad=len(bad_rows),
    )

    # Executable invariant, not a warning: a mismatch here means rows were
    # lost or invented between count_in and (count_out + count_bad), and
    # the pipeline run must stop rather than continue on bad accounting.
    check_conservation(metrics)

    return ValidateResult(good_rows=good_rows, bad_rows=bad_rows, metrics=metrics)
