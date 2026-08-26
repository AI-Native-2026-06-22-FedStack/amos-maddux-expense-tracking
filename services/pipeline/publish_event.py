"""Publish-event stage: emit one dataset-refreshed fact for the pipeline run.

Publishes onto Module 6's SNS->SQS infrastructure (see
docs/adr/0014-event-taxonomy-and-cloudevents.md) via sns_publisher.py's
SnsEventPublisher, on the pipeline's own topic
(SNS_PIPELINE_DATASET_EVENTS_TOPIC, see config.py) -- not the existing
stage_events topic, whose consumer strictly parses only the
stage-transitioned event type (see sns_publisher.py's own docstring for
why a second topic is used rather than one shared topic).

The event is a small, factual "this dataset was refreshed" record, not the
dataset itself: run_id, a logical dataset name, how many rows were loaded,
and when. It deliberately carries no receipt PII, payment identifiers, or
other controlled payload data -- a downstream consumer that wants the
actual rows queries the analytics schema directly (see postgres_sink.py),
using run_id/dataset to know which refresh to look at.

This stage publishes exactly one event per run, so count_in == count_out
== 1 and count_bad == 0 whenever the event is accepted, and count_out == 0
/ count_bad == 1 if the publisher rejects it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol, TypedDict

from metrics import StageMetrics

STAGE_NAME = "publish_event"
EVENT_TYPE = "com.expenseflow.pipeline.dataset-refreshed.v1"
SPEND_BY_TENANT_GL_MONTH_DATASET = "spend_by_tenant_gl_month"


class DatasetRefreshedEvent(TypedDict):
    """Fact payload: this run refreshed this dataset with this many rows.

    Named and shaped like a completed fact, not a command, per this
    codebase's event-taxonomy convention (ADR-0014). Contains only
    metadata needed to identify the refreshed dataset/run -- no row-level
    data, no receipt PII, no payment identifiers.
    """

    type: str
    run_id: str
    dataset: str
    rows_loaded: int
    refreshed_at: str


class EventPublisher(Protocol):
    """Destination for the dataset-refreshed event.

    sns_publisher.py's SnsEventPublisher is the real destination; this
    stage itself only depends on this protocol, never on a concrete
    transport.
    """

    def publish(self, event: DatasetRefreshedEvent) -> bool:
        """Publish the event, returning whether it was accepted."""
        ...


@dataclass
class InMemoryEventPublisher:
    """Default EventPublisher: keeps published events in memory.

    Used by callers and tests that do not want a real SNS dependency (e.g.
    run_pipeline() in run.py falls back to it when no publisher is given).
    Every accepted publish() call's event is appended to .published, so a
    caller or test can assert on exactly what was published.
    """

    published: list[DatasetRefreshedEvent] = field(default_factory=list)

    def publish(self, event: DatasetRefreshedEvent) -> bool:
        self.published.append(event)
        return True


@dataclass(frozen=True)
class PublishEventResult:
    published: bool
    metrics: StageMetrics


def build_dataset_refreshed_event(
    run_id: str,
    rows_loaded: int,
    dataset: str = SPEND_BY_TENANT_GL_MONTH_DATASET,
    now: datetime | None = None,
) -> DatasetRefreshedEvent:
    moment = now if now is not None else datetime.now(UTC)
    return {
        "type": EVENT_TYPE,
        "run_id": run_id,
        "dataset": dataset,
        "rows_loaded": rows_loaded,
        "refreshed_at": moment.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def publish_event(
    rows_loaded: int,
    run_id: str,
    publisher: EventPublisher | None = None,
    dataset: str = SPEND_BY_TENANT_GL_MONTH_DATASET,
) -> PublishEventResult:
    publisher = publisher if publisher is not None else InMemoryEventPublisher()
    event = build_dataset_refreshed_event(run_id, rows_loaded, dataset=dataset)

    accepted = publisher.publish(event)

    metrics = StageMetrics(
        stage=STAGE_NAME,
        run_id=run_id,
        count_in=1,
        count_out=1 if accepted else 0,
        count_bad=0 if accepted else 1,
    )

    return PublishEventResult(published=accepted, metrics=metrics)
