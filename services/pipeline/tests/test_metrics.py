"""Unit tests for services/pipeline/metrics.py's StageMetrics record and
the conservation invariant (count_in == count_out + count_bad).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from metrics import ConservationError, StageMetrics, check_conservation  # noqa: E402


def test_stage_metrics_holds_all_required_fields():
    metrics = StageMetrics(stage="extract", run_id="run-1", count_in=10, count_out=10, count_bad=0)

    assert metrics.stage == "extract"
    assert metrics.run_id == "run-1"
    assert metrics.count_in == 10
    assert metrics.count_out == 10
    assert metrics.count_bad == 0


def test_stage_metrics_rejects_negative_counts():
    with pytest.raises(ValueError):
        StageMetrics(stage="extract", run_id="run-1", count_in=-1, count_out=0, count_bad=0)


@pytest.mark.parametrize(
    ("count_in", "count_out", "count_bad"),
    [(10, 10, 0), (10, 7, 3), (0, 0, 0), (1, 0, 1)],
)
def test_check_conservation_accepts_reconciled_counts(count_in, count_out, count_bad):
    metrics = StageMetrics(
        stage="validate",
        run_id="run-1",
        count_in=count_in,
        count_out=count_out,
        count_bad=count_bad,
    )

    check_conservation(metrics)  # must not raise


@pytest.mark.parametrize(
    ("count_in", "count_out", "count_bad"),
    [(10, 8, 0), (10, 5, 3), (5, 5, 1)],
)
def test_check_conservation_rejects_unreconciled_counts(count_in, count_out, count_bad):
    metrics = StageMetrics(
        stage="validate",
        run_id="run-1",
        count_in=count_in,
        count_out=count_out,
        count_bad=count_bad,
    )

    with pytest.raises(ConservationError):
        check_conservation(metrics)


def test_conservation_error_message_identifies_the_offending_stage():
    metrics = StageMetrics(
        stage="transform", run_id="run-42", count_in=100, count_out=90, count_bad=5
    )

    with pytest.raises(ConservationError) as exc_info:
        check_conservation(metrics)

    message = str(exc_info.value)
    assert "transform" in message
    assert "run-42" in message
    assert "100" in message and "90" in message and "5" in message
    assert exc_info.value.metrics is metrics
