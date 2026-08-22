"""Tests for the five-stage pipeline (run.py) and its stage metrics.

Uses the same small fixture as test_aggregate.py
(tests/fixtures/tiny_export.jsonl.gz: 5 line items + 1 mileage row across 2
tenants). These tests are about the pipeline's shape and accounting, not
about re-proving aggregate.py's own grouping correctness (test_aggregate.py
already covers that).
"""

from __future__ import annotations

import gzip
import json
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))

from make_fixture import ROWS  # noqa: E402

from config import PipelineQualityConfig  # noqa: E402
from load import InMemoryLoadSink  # noqa: E402
from metrics import ConservationError, StageMetrics, check_conservation  # noqa: E402
from publish_event import InMemoryEventPublisher  # noqa: E402
from quarantine_rate import InMemoryMetricPublisher, QuarantineRateExceededError  # noqa: E402
from run import run_pipeline  # noqa: E402
from validate import validate  # noqa: E402

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "tiny_export.jsonl.gz"

EXPECTED_STAGE_ORDER = ["extract", "validate", "transform", "load", "publish_event"]

# A genuinely valid row per models.ExpenseRow -- the real incoming-boundary
# contract validate.py's is_row_valid() now enforces -- taken from the
# shared fixture rather than dict.fromkeys(SCHEMA, None), which satisfied
# only the old key-presence-only check and would fail ExpenseRow's
# required-field/type rules (most SCHEMA columns are not nullable).
_VALID_ROW: dict[str, object] = dict(ROWS[0])


def _write_export(rows: list[dict[str, object]]) -> Path:
    with tempfile.NamedTemporaryFile(suffix=".jsonl.gz", delete=False) as tmp:
        path = Path(tmp.name)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row))
            f.write("\n")
    return path


def _rows_with_bad_fraction(total: int, bad_count: int) -> list[dict[str, object]]:
    """`total` rows built from _VALID_ROW, the first `bad_count` of them
    with a distinct record_id and a semantic-quality failure
    (amount_cents == 0, a documented profile anomaly -- see quality.py)
    so quarantine_rate() == bad_count / total exactly.
    """
    rows = []
    for i in range(total):
        row = dict(_VALID_ROW, record_id=f"record-{i}")
        if i < bad_count:
            row["amount_cents"] = 0
        rows.append(row)
    return rows


def test_five_stages_execute_in_required_order():
    result = run_pipeline(FIXTURE_PATH, run_id="order-test")

    stage_names = [m.stage for m in result.stage_metrics]
    assert stage_names == EXPECTED_STAGE_ORDER


def test_stage_metrics_contain_required_counts():
    result = run_pipeline(FIXTURE_PATH, run_id="shape-test")

    assert len(result.stage_metrics) == 5
    for metrics in result.stage_metrics:
        assert isinstance(metrics, StageMetrics)
        assert metrics.run_id == "shape-test"
        assert isinstance(metrics.count_in, int)
        assert isinstance(metrics.count_out, int)
        assert isinstance(metrics.count_bad, int)


def test_all_stage_metrics_share_the_same_run_id():
    result = run_pipeline(FIXTURE_PATH, run_id="shared-run-id")

    assert all(m.run_id == "shared-run-id" for m in result.stage_metrics)
    assert result.run_id == "shared-run-id"


def test_pipeline_runs_end_to_end_with_in_memory_sinks():
    sink = InMemoryLoadSink()
    publisher = InMemoryEventPublisher()

    result = run_pipeline(
        FIXTURE_PATH, run_id="e2e-test", load_sink=sink, event_publisher=publisher
    )

    # 5 line items -> 4 (tenant, gl_account_code, month) groups, matching
    # test_aggregate.py's test_groups_by_tenant_gl_code_and_month.
    assert result.rows_loaded == 4
    assert result.event_published is True
    assert len(sink.written) == 1
    assert len(sink.written[0]) == 4
    assert len(publisher.published) == 1
    assert publisher.published[0]["rows_loaded"] == 4


def test_validate_conservation_succeeds_when_counts_reconcile():
    # None of these rows carry any schema.SCHEMA column, so all three land
    # in bad_rows -- but count_in must still equal count_out + count_bad
    # exactly, which is the invariant under test here, and validate() must
    # not raise when it holds.
    rows = [{"a": 1}, {"b": 2}, {"c": 3}]

    result = validate(rows, run_id="conservation-ok")

    assert result.metrics.count_in == 3
    assert result.metrics.count_in == result.metrics.count_out + result.metrics.count_bad
    check_conservation(result.metrics)  # must not raise


def test_check_conservation_passes_for_reconciled_counts():
    metrics = StageMetrics(stage="validate", run_id="r1", count_in=10, count_out=7, count_bad=3)

    check_conservation(metrics)  # must not raise


def test_check_conservation_raises_for_a_lossy_stage():
    # A stage that received 10 rows but can only account for 8 of them
    # (neither forwarded nor marked bad) violates the invariant.
    lossy_metrics = StageMetrics(
        stage="validate", run_id="r1", count_in=10, count_out=8, count_bad=0
    )

    with pytest.raises(ConservationError) as exc_info:
        check_conservation(lossy_metrics)

    # The failure must clearly identify which stage lost rows, not just
    # that "something" failed.
    assert "validate" in str(exc_info.value)
    assert exc_info.value.metrics.stage == "validate"


def test_validate_raises_instead_of_returning_when_invariant_is_violated(monkeypatch):
    """A deliberately lossy validate() must fail the pipeline at that
    stage, not merely log a warning and continue.

    Patches validate.py's own StageMetrics binding so the record it builds
    understates count_out by one, simulating a future bug where a row is
    classified as good but never actually reaches good_rows. validate()
    must raise ConservationError instead of returning a ValidateResult
    whose counts do not reconcile.
    """
    import validate as validate_module

    real_stage_metrics = StageMetrics

    def understated_stage_metrics(*, stage, run_id, count_in, count_out, count_bad):
        if stage == "validate" and count_out > 0:
            count_out -= 1  # a row silently vanishes, uncounted as bad
        return real_stage_metrics(
            stage=stage, run_id=run_id, count_in=count_in, count_out=count_out, count_bad=count_bad
        )

    monkeypatch.setattr(validate_module, "StageMetrics", understated_stage_metrics)

    rows = [_VALID_ROW, _VALID_ROW, {"missing": "columns"}]  # 2 good, 1 bad
    with pytest.raises(ConservationError):
        validate_module.validate(rows, run_id="lossy-test")


def test_lossy_validate_stage_fails_the_full_pipeline_run(monkeypatch):
    """End-to-end: if validate's row accounting goes wrong, run_pipeline
    must fail loudly at validate rather than silently completing with a
    smaller row count than it started with, and the failure must clearly
    identify validate as the stage where rows disappeared.
    """
    import validate as validate_module

    real_stage_metrics = StageMetrics

    def understated_stage_metrics(*, stage, run_id, count_in, count_out, count_bad):
        if stage == "validate" and count_out > 0:
            count_out -= 1
        return real_stage_metrics(
            stage=stage, run_id=run_id, count_in=count_in, count_out=count_out, count_bad=count_bad
        )

    monkeypatch.setattr(validate_module, "StageMetrics", understated_stage_metrics)

    with pytest.raises(ConservationError) as exc_info:
        run_pipeline(FIXTURE_PATH, run_id="pipeline-lossy-test")

    assert exc_info.value.metrics.stage == "validate"


def test_conservation_failure_actually_halts_downstream_stages(monkeypatch):
    """A conservation violation must stop the run, not just raise past a
    caller who could ignore it: transform, load, and publish_event must
    never execute once validate's counts fail to reconcile.

    This is the stronger claim behind
    test_lossy_validate_stage_fails_the_full_pipeline_run: it is not enough
    for run_pipeline() to eventually raise ConservationError if downstream
    stages already ran (e.g. a caller wrapping run_pipeline in a broad
    try/except could otherwise observe partial loads or a published event
    for a run that never actually reconciled). Spies on all three
    downstream stage functions prove none of them were even called.
    """
    import run as run_module
    import validate as validate_module

    real_stage_metrics = StageMetrics

    def understated_stage_metrics(*, stage, run_id, count_in, count_out, count_bad):
        if stage == "validate" and count_out > 0:
            count_out -= 1  # a row silently vanishes, uncounted as bad
        return real_stage_metrics(
            stage=stage, run_id=run_id, count_in=count_in, count_out=count_out, count_bad=count_bad
        )

    monkeypatch.setattr(validate_module, "StageMetrics", understated_stage_metrics)

    transform_calls: list[object] = []
    load_calls: list[object] = []
    publish_calls: list[object] = []

    monkeypatch.setattr(
        run_module, "transform", lambda *a, **kw: transform_calls.append((a, kw))
    )
    monkeypatch.setattr(run_module, "load", lambda *a, **kw: load_calls.append((a, kw)))
    monkeypatch.setattr(
        run_module, "publish_event", lambda *a, **kw: publish_calls.append((a, kw))
    )

    with pytest.raises(ConservationError) as exc_info:
        run_pipeline(FIXTURE_PATH, run_id="halt-test")

    assert exc_info.value.metrics.stage == "validate"
    assert transform_calls == []
    assert load_calls == []
    assert publish_calls == []


# ---------------------------------------------------------------------------
# Quarantine-rate measurement and enforcement
# ---------------------------------------------------------------------------


def test_clean_batch_completes_successfully_with_zero_quarantine_rate():
    export_path = _write_export(_rows_with_bad_fraction(total=20, bad_count=0))

    try:
        result = run_pipeline(
            export_path,
            run_id="clean-batch-test",
            quality_config=PipelineQualityConfig(max_quarantine_rate=0.05),
        )
    finally:
        export_path.unlink()

    assert result.quarantine_rate == 0.0
    assert result.rows_loaded > 0
    assert result.event_published is True


def test_batch_below_threshold_continues_and_completes():
    # 2 bad out of 20 = 10% quarantine rate, at/below a 15% threshold ->
    # the run continues per policy ("at or below the threshold may
    # continue") rather than failing.
    export_path = _write_export(_rows_with_bad_fraction(total=20, bad_count=2))

    try:
        result = run_pipeline(
            export_path,
            run_id="below-threshold-test",
            quality_config=PipelineQualityConfig(max_quarantine_rate=0.15),
        )
    finally:
        export_path.unlink()

    assert result.quarantine_rate == pytest.approx(0.10)
    assert result.event_published is True


def test_batch_exactly_at_threshold_continues():
    export_path = _write_export(_rows_with_bad_fraction(total=20, bad_count=2))

    try:
        result = run_pipeline(
            export_path,
            run_id="at-threshold-test",
            quality_config=PipelineQualityConfig(max_quarantine_rate=0.10),
        )
    finally:
        export_path.unlink()

    assert result.quarantine_rate == pytest.approx(0.10)


def test_batch_above_threshold_fails_with_non_zero_signal():
    # 10 bad out of 20 = 50% quarantine rate, well above a 5% threshold.
    export_path = _write_export(_rows_with_bad_fraction(total=20, bad_count=10))

    try:
        with pytest.raises(QuarantineRateExceededError):
            run_pipeline(
                export_path,
                run_id="above-threshold-test",
                quality_config=PipelineQualityConfig(max_quarantine_rate=0.05),
            )
    finally:
        export_path.unlink()


def test_batch_above_threshold_never_reaches_load_or_publish(monkeypatch):
    """A rate above the threshold must stop the run before
    transform/load/publish_event -- not just eventually raise after
    already loading a dataset the threshold says should have been
    rejected outright.
    """
    import run as run_module

    load_calls: list[object] = []
    publish_calls: list[object] = []
    monkeypatch.setattr(run_module, "load", lambda *a, **kw: load_calls.append((a, kw)))
    monkeypatch.setattr(
        run_module, "publish_event", lambda *a, **kw: publish_calls.append((a, kw))
    )

    export_path = _write_export(_rows_with_bad_fraction(total=20, bad_count=10))

    try:
        with pytest.raises(QuarantineRateExceededError):
            run_pipeline(
                export_path,
                run_id="above-threshold-halt-test",
                quality_config=PipelineQualityConfig(max_quarantine_rate=0.05),
            )
    finally:
        export_path.unlink()

    assert load_calls == []
    assert publish_calls == []


def test_above_threshold_failure_states_observed_rate_and_threshold():
    export_path = _write_export(_rows_with_bad_fraction(total=20, bad_count=10))

    try:
        with pytest.raises(QuarantineRateExceededError) as exc_info:
            run_pipeline(
                export_path,
                run_id="failure-message-test",
                quality_config=PipelineQualityConfig(max_quarantine_rate=0.05),
            )
    finally:
        export_path.unlink()

    message = str(exc_info.value)
    assert "0.5" in message or "50.00%" in message
    assert "0.05" in message or "5.00%" in message
    assert "failure-message-test" in message


def test_above_threshold_failure_output_contains_the_runbook_link():
    export_path = _write_export(_rows_with_bad_fraction(total=20, bad_count=10))

    try:
        with pytest.raises(QuarantineRateExceededError) as exc_info:
            run_pipeline(
                export_path,
                run_id="runbook-link-test",
                quality_config=PipelineQualityConfig(max_quarantine_rate=0.05),
            )
    finally:
        export_path.unlink()

    assert "docs/runbooks/quarantine-rate.md" in str(exc_info.value)


def test_quarantine_rate_metric_is_emitted_with_the_calculated_rate_for_every_run():
    """CloudWatch emission must happen for both a passing and a failing
    run -- the task's own policy is "always emit, then enforce" -- so a
    downstream dashboard sees the real observed rate even for a run the
    pipeline itself goes on to fail.
    """
    publisher = InMemoryMetricPublisher()
    export_path = _write_export(_rows_with_bad_fraction(total=20, bad_count=2))

    try:
        run_pipeline(
            export_path,
            run_id="metric-emission-test",
            quality_config=PipelineQualityConfig(max_quarantine_rate=0.15),
            metric_publisher=publisher,
        )
    finally:
        export_path.unlink()

    assert publisher.published == [(pytest.approx(0.10), "metric-emission-test")]


def test_quarantine_rate_metric_is_emitted_even_when_the_run_then_fails():
    publisher = InMemoryMetricPublisher()
    export_path = _write_export(_rows_with_bad_fraction(total=20, bad_count=10))

    try:
        with pytest.raises(QuarantineRateExceededError):
            run_pipeline(
                export_path,
                run_id="metric-emission-failure-test",
                quality_config=PipelineQualityConfig(max_quarantine_rate=0.05),
                metric_publisher=publisher,
            )
    finally:
        export_path.unlink()

    assert publisher.published == [(pytest.approx(0.5), "metric-emission-failure-test")]
