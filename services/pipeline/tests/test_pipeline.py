"""End-to-end / attack-style tests for the ExpenseFlow ingest pipeline
(run_pipeline(), the full extract -> validate -> transform -> load ->
publish_event composition).

Unlike test_run.py, test_validate.py, and test_quality.py -- which test
individual stages and functions in isolation -- these tests drive
run_pipeline() as a black box against constructed export files that plant
specific, deliberate failure shapes, and assert on outcomes only (row
counts, quarantine contents, analytics absence, failure messages,
redaction), the same way an operator or an attacker probing the ingest
boundary would observe it. No production check/validation logic is
reimplemented here -- every assertion reads a real result object
(ValidateResult, PipelineRunResult, a quarantine sink's .written list) or
a real raised exception's own fields.

Four planted-failure scenarios, matching this deliverable's required
cases:

  1. a structurally malformed row (fails models.ExpenseRow -- a missing
     required field);
  2. a semantically impossible row (passes ExpenseRow but fails a
     quality.py check -- non-positive amount_cents);
  3. a batch with enough failures to exceed pipeline.toml's configured
     quarantine-rate threshold;
  4. a clean batch (every row valid).

Reuses tests/fixtures/make_fixture.py's ROWS (the same shared fixture
test_run.py/test_validate.py/test_aggregate.py already use) as the base
for every planted row, so a "bad" row here differs from a known-good row
by exactly the one field the scenario is attacking, not by an
independently constructed row shape.
"""

from __future__ import annotations

import gzip
import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))

from make_fixture import ROWS  # noqa: E402

from config import PipelineQualityConfig, PipelineQuarantineConfig  # noqa: E402
from load import InMemoryLoadSink  # noqa: E402
from quarantine import InMemoryQuarantineSink  # noqa: E402
from quarantine_rate import InMemoryMetricPublisher, QuarantineRateExceededError  # noqa: E402
from run import run_pipeline  # noqa: E402

VALID_ROW: dict[str, object] = dict(ROWS[0])
ORIGINAL_RECEIPT_NUMBER = "RCT-000001"  # VALID_ROW's real, unredacted receipt_number


def _write_export(rows: list[dict[str, object]]) -> Path:
    with tempfile.NamedTemporaryFile(suffix=".jsonl.gz", delete=False) as tmp:
        path = Path(tmp.name)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row))
            f.write("\n")
    return path


def _run_against(
    rows: list[dict[str, object]],
    run_id: str,
    max_quarantine_rate: float = 1.0,
    quarantine_sink=None,
    load_sink=None,
    metric_publisher=None,
):
    """Write `rows` as a real gzip/JSONL export and run the full pipeline
    against it, cleaning the temp file up afterward. Every scenario below
    goes through this same real extract() read -- rows are not handed to
    validate()/run_pipeline() directly -- so redaction (extract.py) is
    exercised exactly as it would be for a real ingest.

    max_quarantine_rate defaults to 1.0 (never enforced) because most
    callers here are testing row-level rejection/quarantine behavior on
    small batches, not threshold enforcement itself -- scenario 3's tests
    pass an explicit, realistic threshold (0.05) precisely because
    threshold enforcement is what they are testing.
    """
    if quarantine_sink is None:
        quarantine_sink = InMemoryQuarantineSink()
    if load_sink is None:
        load_sink = InMemoryLoadSink()
    if metric_publisher is None:
        metric_publisher = InMemoryMetricPublisher()
    export_path = _write_export(rows)

    try:
        return run_pipeline(
            export_path,
            run_id=run_id,
            quarantine_sink=quarantine_sink,
            load_sink=load_sink,
            metric_publisher=metric_publisher,
            quality_config=PipelineQualityConfig(max_quarantine_rate=max_quarantine_rate),
        ), quarantine_sink, load_sink, metric_publisher
    finally:
        export_path.unlink()


# ---------------------------------------------------------------------------
# Scenario 1: a structurally malformed row (fails models.ExpenseRow)
# ---------------------------------------------------------------------------


def _structurally_malformed_row(**overrides: object) -> dict[str, object]:
    """A row missing expense_report_id -- a required ExpenseRow field
    that no quality.py check independently touches (unlike tenant_id,
    which check_tenant_presence also flags), so this row fails exactly
    one check: the ExpenseRow gate itself. That keeps this scenario
    cleanly isolated from scenario 2's semantic-check failures.
    """
    row = dict(VALID_ROW, **overrides)
    del row["expense_report_id"]
    return row


def test_structurally_malformed_row_is_counted_bad_and_conservation_holds():
    malformed_row = _structurally_malformed_row()
    good_row = dict(VALID_ROW, record_id="structurally-good-row")

    result, quarantine_sink, load_sink, _ = _run_against(
        [malformed_row, good_row], run_id="structural-malformed-test"
    )

    validate_metrics = next(m for m in result.stage_metrics if m.stage == "validate")
    assert validate_metrics.count_bad == 1
    assert validate_metrics.count_in == validate_metrics.count_out + validate_metrics.count_bad


def test_structurally_malformed_row_is_quarantined_with_its_reason():
    malformed_row = _structurally_malformed_row()

    _, quarantine_sink, _, _ = _run_against([malformed_row], run_id="structural-quarantine-test")

    assert len(quarantine_sink.written) == 1
    record = quarantine_sink.written[0]
    assert record["check"] == "expense_row"
    assert record["reason"] != ""
    assert record["record_id"] == malformed_row["record_id"]


def test_structurally_malformed_row_never_reaches_analytics_output():
    # A distinguishing GL code the malformed row alone carries: since the
    # analytics output is grouped by (tenant_id, gl_account_code, month)
    # -- never by record_id -- the meaningful check is that this group
    # never appears at all, not that some row-level identifier is absent.
    malformed_row = _structurally_malformed_row(gl_account_code="9001-malformed-marker")
    good_row = dict(VALID_ROW, record_id="structural-good-row-2")

    result, _, load_sink, _ = _run_against(
        [malformed_row, good_row], run_id="structural-no-load-test"
    )

    assert result.rows_loaded > 0  # the good row still made it through
    for written_frame in load_sink.written:
        assert "9001-malformed-marker" not in written_frame["gl_account_code"].tolist()


# ---------------------------------------------------------------------------
# Scenario 2: a semantically impossible row (passes ExpenseRow, fails
# quality.py)
# ---------------------------------------------------------------------------


def test_semantically_impossible_row_is_counted_bad_and_conservation_holds():
    # amount_cents == 0 is a fully valid *type* for ExpenseRow (int, not
    # negative) but a documented, semantically impossible value
    # (docs/data/expense-export-profile.md's non-positive-amount defect).
    impossible_row = dict(VALID_ROW, amount_cents=0)
    good_row = dict(VALID_ROW, record_id="semantic-good-row")

    result, _, _, _ = _run_against([impossible_row, good_row], run_id="semantic-impossible-test")

    validate_metrics = next(m for m in result.stage_metrics if m.stage == "validate")
    assert validate_metrics.count_bad == 1
    assert validate_metrics.count_in == validate_metrics.count_out + validate_metrics.count_bad


def test_semantically_impossible_row_is_quarantined_with_its_reason():
    impossible_row = dict(VALID_ROW, amount_cents=0)

    _, quarantine_sink, _, _ = _run_against(
        [impossible_row], run_id="semantic-quarantine-test"
    )

    assert len(quarantine_sink.written) == 1
    record = quarantine_sink.written[0]
    assert record["check"] == "non_positive_amount"
    assert "non-positive" in record["reason"]
    assert record["record_id"] == impossible_row["record_id"]
    assert record["tenant_id"] == impossible_row["tenant_id"]


def test_semantically_impossible_row_never_reaches_analytics_output():
    # A distinguishing GL code so the impossible row's own (tenant, GL,
    # month) group is unambiguous in the grouped analytics output: if it
    # wrongly survived to transform/load, this exact group would appear.
    impossible_row = dict(VALID_ROW, amount_cents=0, gl_account_code="9002-impossible-marker")
    good_row = dict(VALID_ROW, record_id="semantic-good-row-2")

    result, _, load_sink, _ = _run_against(
        [impossible_row, good_row], run_id="semantic-no-load-test"
    )

    assert result.rows_loaded > 0
    for written_frame in load_sink.written:
        assert "9002-impossible-marker" not in written_frame["gl_account_code"].tolist()


def test_quarantined_semantic_failure_row_retains_redacted_receipt_number():
    """The row embedded in the quarantine record must carry the same
    already-redacted receipt_number extract.py produced -- never the
    original synthetic value -- proving redaction survives all the way
    through validate()'s quarantine write in a full pipeline run, not
    just in an isolated unit test.
    """
    impossible_row = dict(VALID_ROW, amount_cents=0)
    assert impossible_row["receipt_number"] == ORIGINAL_RECEIPT_NUMBER  # sanity on the fixture

    _, quarantine_sink, _, _ = _run_against(
        [impossible_row], run_id="semantic-redaction-test"
    )

    record = quarantine_sink.written[0]
    assert record["row"]["receipt_number"] == "[REDACTED]"
    assert ORIGINAL_RECEIPT_NUMBER not in json.dumps(record)


# ---------------------------------------------------------------------------
# Scenario 3: a batch exceeding the configured quarantine threshold
# ---------------------------------------------------------------------------


def test_batch_exceeding_the_threshold_fails_the_run():
    # 10 of 20 rows semantically bad (50%) against a 5% threshold.
    rows = []
    for i in range(20):
        row = dict(VALID_ROW, record_id=f"over-threshold-row-{i}")
        if i < 10:
            row["amount_cents"] = 0
        rows.append(row)

    with pytest.raises(QuarantineRateExceededError):
        _run_against(rows, run_id="over-threshold-test", max_quarantine_rate=0.05)


def test_over_threshold_failure_output_links_to_the_runbook():
    rows = []
    for i in range(20):
        row = dict(VALID_ROW, record_id=f"over-threshold-runbook-row-{i}")
        if i < 10:
            row["amount_cents"] = 0
        rows.append(row)

    with pytest.raises(QuarantineRateExceededError) as exc_info:
        _run_against(rows, run_id="over-threshold-runbook-test", max_quarantine_rate=0.05)

    assert "docs/runbooks/quarantine-rate.md" in str(exc_info.value)


def test_over_threshold_failure_states_observed_rate_and_threshold():
    rows = []
    for i in range(20):
        row = dict(VALID_ROW, record_id=f"over-threshold-msg-row-{i}")
        if i < 10:
            row["amount_cents"] = 0
        rows.append(row)

    with pytest.raises(QuarantineRateExceededError) as exc_info:
        _run_against(rows, run_id="over-threshold-message-test", max_quarantine_rate=0.05)

    message = str(exc_info.value)
    assert "over-threshold-message-test" in message
    assert exc_info.value.observed_rate == pytest.approx(0.5)
    assert exc_info.value.threshold == pytest.approx(0.05)


def test_over_threshold_rows_are_still_all_individually_quarantined():
    """Even though the run as a whole fails, every bad row that was
    processed before the threshold check ran must still have been
    quarantined -- the threshold gate does not silently drop the
    per-row quarantine records it was built on top of.
    """
    quarantine_sink = InMemoryQuarantineSink()
    rows = []
    for i in range(20):
        row = dict(VALID_ROW, record_id=f"over-threshold-quarantine-row-{i}")
        if i < 10:
            row["amount_cents"] = 0
        rows.append(row)

    with pytest.raises(QuarantineRateExceededError):
        _run_against(
            rows,
            run_id="over-threshold-all-quarantined-test",
            max_quarantine_rate=0.05,
            quarantine_sink=quarantine_sink,
        )

    assert len(quarantine_sink.written) == 10
    assert all(record["check"] == "non_positive_amount" for record in quarantine_sink.written)


def test_over_threshold_batch_still_emits_the_metric_before_failing():
    # "always emit, then enforce" -- a downstream dashboard must see the
    # real observed rate even for a run the pipeline goes on to fail.
    metric_publisher = InMemoryMetricPublisher()
    rows = []
    for i in range(20):
        row = dict(VALID_ROW, record_id=f"over-threshold-metric-row-{i}")
        if i < 10:
            row["amount_cents"] = 0
        rows.append(row)

    with pytest.raises(QuarantineRateExceededError):
        _run_against(
            rows,
            run_id="over-threshold-metric-test",
            max_quarantine_rate=0.05,
            metric_publisher=metric_publisher,
        )

    assert metric_publisher.published == [(pytest.approx(0.5), "over-threshold-metric-test")]


def test_over_threshold_batch_never_reaches_the_analytics_load():
    load_sink = InMemoryLoadSink()
    rows = []
    for i in range(20):
        row = dict(VALID_ROW, record_id=f"over-threshold-no-load-row-{i}")
        if i < 10:
            row["amount_cents"] = 0
        rows.append(row)

    with pytest.raises(QuarantineRateExceededError):
        _run_against(
            rows,
            run_id="over-threshold-no-load-test",
            max_quarantine_rate=0.05,
            load_sink=load_sink,
        )

    assert load_sink.written == []


# ---------------------------------------------------------------------------
# Scenario 4: a clean batch
# ---------------------------------------------------------------------------


def test_clean_batch_succeeds_with_zero_quarantine_rate():
    rows = [dict(VALID_ROW, record_id=f"clean-row-{i}") for i in range(10)]

    result, quarantine_sink, load_sink, _ = _run_against(rows, run_id="clean-batch-test")

    assert result.quarantine_rate == 0.0
    assert result.event_published is True
    assert quarantine_sink.written == []
    validate_metrics = next(m for m in result.stage_metrics if m.stage == "validate")
    assert validate_metrics.count_bad == 0
    assert validate_metrics.count_in == validate_metrics.count_out


def test_clean_batch_conservation_holds():
    rows = [dict(VALID_ROW, record_id=f"clean-conservation-row-{i}") for i in range(10)]

    result, _, _, _ = _run_against(rows, run_id="clean-batch-conservation-test")

    validate_metrics = next(m for m in result.stage_metrics if m.stage == "validate")
    assert validate_metrics.count_in == validate_metrics.count_out + validate_metrics.count_bad


def test_clean_batch_data_reaches_the_analytics_load():
    rows = [dict(VALID_ROW, record_id=f"clean-load-row-{i}") for i in range(3)]

    result, _, load_sink, _ = _run_against(rows, run_id="clean-batch-load-test")

    assert result.rows_loaded > 0
    assert len(load_sink.written) == 1


def test_clean_batch_reflects_the_real_shared_fixture_end_to_end():
    """The existing shared fixture (tests/fixtures/tiny_export.jsonl.gz)
    is itself a clean batch -- proving the full pipeline still succeeds
    against the exact same fixture the rest of the suite already relies
    on, not only against rows constructed fresh in this file.
    """
    fixture_path = Path(__file__).parent / "fixtures" / "tiny_export.jsonl.gz"
    quarantine_sink = InMemoryQuarantineSink()

    result = run_pipeline(
        fixture_path,
        run_id="clean-shared-fixture-test",
        quarantine_sink=quarantine_sink,
        quality_config=PipelineQualityConfig(max_quarantine_rate=0.05),
    )

    assert result.quarantine_rate == 0.0
    assert quarantine_sink.written == []
    assert result.rows_loaded == 4  # matches test_aggregate.py's known grouping


# ---------------------------------------------------------------------------
# Sensitive-field redaction, checked across every scenario's own output
# ---------------------------------------------------------------------------


def test_no_scenario_ever_leaks_the_original_receipt_number_anywhere():
    """Across all four planted-failure shapes, the original synthetic
    receipt_number must never appear in any stage's own output --
    quarantine records (the load-bearing check: these embed the full raw
    row and are exactly where an unredacted leak would show up) or the
    analytics load output (defense-in-depth: the grouped analytics schema
    has no receipt_number column at all today, so this half can never
    fail on its own, but it documents the invariant in case that ever
    changes).
    """
    malformed_row = _structurally_malformed_row(record_id="leak-check-structural")
    impossible_row = dict(VALID_ROW, record_id="leak-check-semantic", amount_cents=0)
    good_row = dict(VALID_ROW, record_id="leak-check-good")

    result, quarantine_sink, load_sink, _ = _run_against(
        [malformed_row, impossible_row, good_row], run_id="leak-check-test"
    )

    serialized_quarantine = json.dumps(quarantine_sink.written)
    serialized_loaded = "".join(frame.to_string() for frame in load_sink.written)

    assert ORIGINAL_RECEIPT_NUMBER not in serialized_quarantine
    assert ORIGINAL_RECEIPT_NUMBER not in serialized_loaded
    assert "[REDACTED]" in serialized_quarantine


# ---------------------------------------------------------------------------
# Opt-in: the over-threshold scenario against real floci S3, reusing
# test_quarantine_s3.py's own bucket-provisioning fixture pattern.
# ---------------------------------------------------------------------------

pytestmark_real_floci = pytest.mark.skipif(
    os.environ.get("RUN_QUARANTINE_S3_TESTS") != "1",
    reason=(
        "requires `docker compose up -d floci` running locally; "
        "set RUN_QUARANTINE_S3_TESTS=1 to run"
    ),
)

_REAL_ENDPOINT_URL = "http://localhost:4566"
_REAL_REGION = "us-east-1"
_REAL_BUCKET = "expenseflow-pipeline-quarantine-test"
_REAL_PREFIX = "quarantine-e2e-test"


def _real_s3_client():
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=_REAL_ENDPOINT_URL,
        region_name=_REAL_REGION,
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )


@pytest.fixture
def real_quarantine_config() -> PipelineQuarantineConfig:
    return PipelineQuarantineConfig(
        endpoint_url=_REAL_ENDPOINT_URL,
        region=_REAL_REGION,
        bucket=_REAL_BUCKET,
        prefix=_REAL_PREFIX,
    )


@pytest.fixture
def real_quarantine_bucket():
    s3 = _real_s3_client()
    try:
        s3.create_bucket(Bucket=_REAL_BUCKET)
    except s3.exceptions.BucketAlreadyOwnedByYou:
        pass

    yield _REAL_BUCKET

    response = s3.list_objects_v2(Bucket=_REAL_BUCKET, Prefix=_REAL_PREFIX)
    for obj in response.get("Contents", []):
        s3.delete_object(Bucket=_REAL_BUCKET, Key=obj["Key"])


@pytestmark_real_floci
def test_over_threshold_batch_end_to_end_against_real_floci_s3(
    real_quarantine_config, real_quarantine_bucket
):
    """The over-threshold scenario driven through the full run_pipeline()
    against a real floci S3 bucket: the run fails, and every quarantined
    row genuinely exists in S3 with its reason and redacted content --
    closing the loop from CLI-level failure behavior to real S3 content
    in one test, reusing test_quarantine_s3.py's own bucket-fixture
    pattern rather than inventing a second one.
    """
    from quarantine import S3QuarantineSink

    sink = S3QuarantineSink(config=real_quarantine_config)
    rows = []
    for i in range(20):
        row = dict(VALID_ROW, record_id=f"real-s3-e2e-row-{i}")
        if i < 10:
            row["amount_cents"] = 0
        rows.append(row)
    export_path = _write_export(rows)

    try:
        with pytest.raises(QuarantineRateExceededError):
            run_pipeline(
                export_path,
                run_id="real-s3-e2e-test",
                quarantine_sink=sink,
                quality_config=PipelineQualityConfig(max_quarantine_rate=0.05),
            )
    finally:
        export_path.unlink()

    s3 = _real_s3_client()
    listing = s3.list_objects_v2(
        Bucket=_REAL_BUCKET, Prefix=f"{_REAL_PREFIX}/real-s3-e2e-test/"
    )
    keys = [obj["Key"] for obj in listing.get("Contents", [])]
    assert len(keys) == 10

    sample = s3.get_object(Bucket=_REAL_BUCKET, Key=keys[0])
    record = json.loads(sample["Body"].read())
    assert record["check"] == "non_positive_amount"
    assert record["row"]["receipt_number"] == "[REDACTED]"
    assert ORIGINAL_RECEIPT_NUMBER not in json.dumps(record)
