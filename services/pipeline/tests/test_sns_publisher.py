"""Integration test for sns_publisher.py against a live floci: proves a
published dataset-refreshed event actually reaches the subscribed SQS
queue on Module 6's SNS->SQS infrastructure, not just that publish()
returns True.

Opt-in, matching the pattern in test_equivalence_check.py and
test_postgres_sink.py: skipped unless RUN_SNS_PUBLISHER_TESTS=1, since it
needs `docker compose up -d floci` running locally with the pipeline's
topic/queue/DLQ already provisioned (scripts/compose-dev-init.mjs's
ensureSnsToSqsFanout call for SNS_PIPELINE_DATASET_EVENTS_TOPIC /
SQS_PIPELINE_DATASET_REFRESHED_QUEUE), and is not part of the default fast
suite.

This does not duplicate or re-test Module 6's own messaging abstractions
(SNS topic creation, SQS redrive policy, the subscription itself) -- those
already exist and are exercised by apps/api's own tests. This test only
proves the pipeline's publisher (a new, small client) correctly talks to
that already-provisioned infrastructure end to end.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import PipelineSnsConfig  # noqa: E402
from publish_event import EVENT_TYPE, build_dataset_refreshed_event  # noqa: E402
from run import run_pipeline  # noqa: E402
from sns_publisher import SnsEventPublisher  # noqa: E402

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_SNS_PUBLISHER_TESTS") != "1",
    reason=(
        "requires `docker compose up -d floci` with the pipeline's SNS topic/SQS queue "
        "already provisioned (scripts/compose-dev-init.mjs); set RUN_SNS_PUBLISHER_TESTS=1 to run"
    ),
)

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "tiny_export.jsonl.gz"

TEST_ENDPOINT_URL = "http://localhost:4566"
TEST_REGION = "us-east-1"
TEST_TOPIC_NAME = "expenseflow-pipeline-dataset-events"
TEST_QUEUE_NAME = "expenseflow-pipeline-dataset-refreshed"


def _sqs_client():
    import boto3

    return boto3.client(
        "sqs",
        endpoint_url=TEST_ENDPOINT_URL,
        region_name=TEST_REGION,
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )


def _queue_url() -> str:
    return _sqs_client().get_queue_url(QueueName=TEST_QUEUE_NAME)["QueueUrl"]


@pytest.fixture
def test_config() -> PipelineSnsConfig:
    return PipelineSnsConfig(
        endpoint_url=TEST_ENDPOINT_URL, region=TEST_REGION, topic_name=TEST_TOPIC_NAME
    )


@pytest.fixture(autouse=True)
def clean_queue():
    sqs = _sqs_client()
    queue_url = _queue_url()
    sqs.purge_queue(QueueUrl=queue_url)
    yield
    sqs.purge_queue(QueueUrl=queue_url)


def _receive_one(timeout_seconds: int = 5) -> dict:
    sqs = _sqs_client()
    response = sqs.receive_message(
        QueueUrl=_queue_url(),
        MaxNumberOfMessages=1,
        WaitTimeSeconds=timeout_seconds,
    )
    messages = response.get("Messages", [])
    assert len(messages) == 1, f"expected exactly one message, got {len(messages)}"
    return json.loads(messages[0]["Body"])


def test_published_event_reaches_the_subscribed_queue(test_config):
    publisher = SnsEventPublisher(config=test_config)
    event = build_dataset_refreshed_event(run_id="integration-run-1", rows_loaded=4)

    accepted = publisher.publish(event)

    assert accepted is True
    received = _receive_one()
    assert received == event


def test_full_pipeline_run_publishes_a_message_the_queue_receives(test_config):
    publisher = SnsEventPublisher(config=test_config)

    result = run_pipeline(FIXTURE_PATH, run_id="integration-run-2", event_publisher=publisher)

    assert result.event_published is True
    received = _receive_one()
    assert received["type"] == EVENT_TYPE
    assert received["run_id"] == "integration-run-2"
    assert received["rows_loaded"] == result.rows_loaded == 4
    assert set(received.keys()) == {"type", "run_id", "dataset", "rows_loaded", "refreshed_at"}


def test_resolve_topic_arn_is_idempotent_against_the_existing_topic(test_config):
    publisher = SnsEventPublisher(config=test_config)

    first_arn = publisher.resolve_topic_arn()
    second_arn = publisher.resolve_topic_arn()

    assert first_arn == second_arn
    assert first_arn.endswith(f":{TEST_TOPIC_NAME}")
