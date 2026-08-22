"""Unit tests for quarantine_rate.py: rate calculation, the zero-input
case, threshold enforcement, the runbook-link message content, and the
CloudWatch metric-publishing seam.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import PipelineCloudWatchConfig  # noqa: E402
from metrics import StageMetrics  # noqa: E402
from quarantine_rate import (  # noqa: E402
    METRIC_NAME,
    RUNBOOK_PATH,
    CloudWatchMetricPublisher,
    InMemoryMetricPublisher,
    QuarantineRateExceededError,
    emit_quarantine_rate_metric,
    enforce_quarantine_rate,
    quarantine_rate,
    runbook_path,
)


def _metrics(count_in: int, count_out: int, count_bad: int) -> StageMetrics:
    return StageMetrics(
        stage="validate",
        run_id="rate-test",
        count_in=count_in,
        count_out=count_out,
        count_bad=count_bad,
    )


# ---------------------------------------------------------------------------
# quarantine_rate()
# ---------------------------------------------------------------------------


def test_quarantine_rate_computes_rejected_over_total_input():
    metrics = _metrics(count_in=100, count_out=90, count_bad=10)

    assert quarantine_rate(metrics) == pytest.approx(0.10)


def test_quarantine_rate_is_zero_for_a_fully_clean_batch():
    metrics = _metrics(count_in=50, count_out=50, count_bad=0)

    assert quarantine_rate(metrics) == 0.0


def test_quarantine_rate_is_one_when_every_row_is_rejected():
    metrics = _metrics(count_in=10, count_out=0, count_bad=10)

    assert quarantine_rate(metrics) == 1.0


def test_quarantine_rate_handles_zero_input_rows_safely():
    # count_in == 0 must not raise ZeroDivisionError; a run over an empty
    # batch has no rejection signal to report.
    metrics = _metrics(count_in=0, count_out=0, count_bad=0)

    assert quarantine_rate(metrics) == 0.0


# ---------------------------------------------------------------------------
# enforce_quarantine_rate()
# ---------------------------------------------------------------------------


def test_enforce_quarantine_rate_allows_a_rate_below_the_threshold():
    enforce_quarantine_rate(observed_rate=0.03, threshold=0.05, run_id="run-1")  # must not raise


def test_enforce_quarantine_rate_allows_a_rate_exactly_at_the_threshold():
    # "at or below the threshold may continue" -- exactly-equal must pass.
    enforce_quarantine_rate(observed_rate=0.05, threshold=0.05, run_id="run-1")  # must not raise


def test_enforce_quarantine_rate_fails_a_rate_above_the_threshold():
    with pytest.raises(QuarantineRateExceededError):
        enforce_quarantine_rate(observed_rate=0.12, threshold=0.05, run_id="run-1")


def test_enforce_quarantine_rate_error_states_observed_rate_and_threshold():
    with pytest.raises(QuarantineRateExceededError) as exc_info:
        enforce_quarantine_rate(observed_rate=0.12, threshold=0.05, run_id="run-xyz")

    message = str(exc_info.value)
    assert "0.12" in message or "12.00%" in message
    assert "0.05" in message or "5.00%" in message
    assert "run-xyz" in message
    assert exc_info.value.observed_rate == 0.12
    assert exc_info.value.threshold == 0.05
    assert exc_info.value.run_id == "run-xyz"


def test_enforce_quarantine_rate_error_includes_the_runbook_link():
    with pytest.raises(QuarantineRateExceededError) as exc_info:
        enforce_quarantine_rate(observed_rate=0.5, threshold=0.05, run_id="run-1")

    assert RUNBOOK_PATH in str(exc_info.value)
    assert "docs/runbooks/quarantine-rate.md" in str(exc_info.value)


def test_runbook_path_resolves_to_a_file_that_actually_exists():
    # The failure message points at a real file, not a path that would
    # 404 for whoever reads the failure output.
    assert runbook_path().is_file()


# ---------------------------------------------------------------------------
# Metric emission
# ---------------------------------------------------------------------------


def test_emit_quarantine_rate_metric_invokes_the_publisher_with_the_calculated_rate():
    publisher = InMemoryMetricPublisher()

    emit_quarantine_rate_metric(0.075, "run-abc", publisher=publisher)

    assert publisher.published == [(0.075, "run-abc")]


def test_emit_quarantine_rate_metric_defaults_to_in_memory_publisher_when_none_given():
    # Must not attempt a real network call when no publisher is injected.
    emit_quarantine_rate_metric(0.0, "run-1")  # must not raise


def test_cloudwatch_metric_publisher_calls_put_metric_data_with_the_rate(monkeypatch):
    put_metric_data_calls = []

    class FakeCloudWatchClient:
        def put_metric_data(self, **kwargs):
            put_metric_data_calls.append(kwargs)

    config = PipelineCloudWatchConfig(
        endpoint_url="http://localhost:4566", region="us-east-1", namespace="Test/Namespace"
    )
    publisher = CloudWatchMetricPublisher(config=config)
    monkeypatch.setattr(publisher, "_client", lambda: FakeCloudWatchClient())

    publisher.put_rate(0.088, "run-cw-test")

    assert len(put_metric_data_calls) == 1
    call = put_metric_data_calls[0]
    assert call["Namespace"] == "Test/Namespace"
    assert call["MetricData"][0]["MetricName"] == METRIC_NAME
    assert call["MetricData"][0]["Value"] == 0.088
    assert {"Name": "run_id", "Value": "run-cw-test"} in call["MetricData"][0]["Dimensions"]
