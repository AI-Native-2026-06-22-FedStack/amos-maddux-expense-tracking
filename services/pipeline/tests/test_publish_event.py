"""Unit tests for publish_event.py: the dataset-refreshed event's shape,
and run.py's "publish only after a successful load" gating.
"""

from __future__ import annotations

import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from load import InMemoryLoadSink  # noqa: E402
from publish_event import (  # noqa: E402
    EVENT_TYPE,
    SPEND_BY_TENANT_GL_MONTH_DATASET,
    InMemoryEventPublisher,
    build_dataset_refreshed_event,
    publish_event,
)
from run import run_pipeline  # noqa: E402

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "tiny_export.jsonl.gz"

FORBIDDEN_PAYLOAD_KEYS = {
    "receipt_number",
    "receipt_date",
    "merchant",
    "payment_id",
    "amount_cents",
    "tenant_id",
    "gl_account_code",
    "spend_cents",
    "spend_by_tenant_gl_month",
}


def test_event_type_is_a_completed_fact_not_a_command():
    # Fact-not-command naming per ADR-0014: past-tense, describes something
    # that already happened, does not instruct a consumer to act.
    assert EVENT_TYPE == "com.expenseflow.pipeline.dataset-refreshed.v1"
    assert "refreshed" in EVENT_TYPE


def test_build_dataset_refreshed_event_shape():
    moment = datetime(2026, 8, 22, 12, 30, 0, tzinfo=UTC)

    event = build_dataset_refreshed_event(run_id="run-abc", rows_loaded=864, now=moment)

    assert event == {
        "type": EVENT_TYPE,
        "run_id": "run-abc",
        "dataset": SPEND_BY_TENANT_GL_MONTH_DATASET,
        "rows_loaded": 864,
        "refreshed_at": "2026-08-22T12:30:00Z",
    }


def test_event_contains_no_receipt_pii_payment_identifiers_or_row_level_data():
    event = build_dataset_refreshed_event(run_id="run-abc", rows_loaded=864)

    assert set(event.keys()) == {"type", "run_id", "dataset", "rows_loaded", "refreshed_at"}
    assert FORBIDDEN_PAYLOAD_KEYS.isdisjoint(event.keys())


def test_publish_event_preserves_the_given_run_id():
    publisher = InMemoryEventPublisher()

    result = publish_event(rows_loaded=4, run_id="preserve-me", publisher=publisher)

    assert result.published is True
    assert publisher.published[0]["run_id"] == "preserve-me"


def test_publish_event_reports_rejection_in_metrics():
    class RejectingPublisher:
        def publish(self, event):
            return False

    result = publish_event(rows_loaded=4, run_id="rejected-run", publisher=RejectingPublisher())

    assert result.published is False
    assert result.metrics.count_out == 0
    assert result.metrics.count_bad == 1


def test_run_pipeline_publishes_after_a_successful_load():
    publisher = InMemoryEventPublisher()

    result = run_pipeline(FIXTURE_PATH, run_id="publish-after-success", event_publisher=publisher)

    assert result.event_published is True
    assert len(publisher.published) == 1
    assert publisher.published[0]["run_id"] == "publish-after-success"
    assert publisher.published[0]["rows_loaded"] == result.rows_loaded


def test_run_pipeline_does_not_publish_when_load_is_not_fully_successful():
    """A load that only partially accepts rows (count_bad > 0) must not be
    treated as a successful load -- publish_event must not run, and no
    event should be recorded by the publisher.
    """

    class PartiallyRejectingSink:
        def write(self, rows, run_id):
            return max(len(rows) - 1, 0)  # reject exactly one row, no exception raised

    publisher = InMemoryEventPublisher()

    result = run_pipeline(
        FIXTURE_PATH,
        run_id="partial-load-run",
        load_sink=PartiallyRejectingSink(),
        event_publisher=publisher,
    )

    assert result.event_published is False
    assert publisher.published == []
    stage_names = [m.stage for m in result.stage_metrics]
    assert "publish_event" not in stage_names


def test_run_pipeline_publishes_when_load_sink_accepts_every_row():
    sink = InMemoryLoadSink()
    publisher = InMemoryEventPublisher()

    result = run_pipeline(
        FIXTURE_PATH, run_id="full-accept-run", load_sink=sink, event_publisher=publisher
    )

    assert result.event_published is True
    assert len(publisher.published) == 1


@pytest.mark.parametrize("rows_loaded", [0, 4, 864])
def test_build_dataset_refreshed_event_carries_the_actual_row_count(rows_loaded):
    event = build_dataset_refreshed_event(run_id="run-x", rows_loaded=rows_loaded)

    assert event["rows_loaded"] == rows_loaded
