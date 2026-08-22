"""SNS-backed EventPublisher: publishes the pipeline's dataset-refreshed
event onto Module 6's existing SNS->SQS infrastructure (see
docs/adr/0014-event-taxonomy-and-cloudevents.md).

Targets floci/local AWS the same way every other ExpenseFlow client does
(AWS_ENDPOINT_URL/AWS_ENDPOINT + AWS_REGION, see config.py and
.env.example) -- not a parallel event system, not a different endpoint
convention.

This publishes on its OWN topic (SNS_PIPELINE_DATASET_EVENTS_TOPIC,
default "expenseflow-pipeline-dataset-events"), not the existing
SNS_STAGE_EVENTS_TOPIC ("expenseflow-stage-events"). The reason is
structural, not a design preference: apps/api/src/events/stage-transition-
consumer.ts's handleStageTransitionMessage() does
expenseReportStageTransitionedEventSchema.parse(...) -- a Zod .strict()
schema keyed to `type: "com.expenseflow.expense-report.stage-transitioned.v1"`
-- against every message it receives from that topic's queue. A
dataset-refreshed message published onto that topic would fail that parse
and eventually dead-letter; it would not be a case of "reusing" that
topic, it would silently break its existing consumer. The new topic
follows the identical Module 6 pattern (SNS topic -> SQS queue with a
redrive-policy DLQ, same KMS key) provisioned in
infra/terraform/modules/data/main.tf and scripts/compose-dev-init.mjs --
no new messaging abstraction, just a second instance of the one that
already exists, exactly as ADR-0014 anticipates ("The taxonomy starts with
one event, so new events must continue applying the fact-not-command
coupling test before they are added").

resolve_topic_arn() mirrors
apps/api/src/events/stage-transition-event-publisher.ts's
SnsStageTransitionEventPublisher.resolveTopicArn(): CreateTopic is
idempotent in both AWS and floci, so calling it here for an
already-existing topic just returns that topic's ARN rather than erroring
or creating a duplicate.
"""

from __future__ import annotations

import json

from config import PipelineSnsConfig, load_pipeline_sns_config
from publish_event import DatasetRefreshedEvent


class SnsEventPublisher:
    """EventPublisher implementation publishing to the pipeline's SNS topic.

    config is read once via config.load_pipeline_sns_config() unless an
    explicit PipelineSnsConfig is supplied (tests do this to avoid
    depending on process environment).
    """

    def __init__(self, config: PipelineSnsConfig | None = None) -> None:
        self.config = config if config is not None else load_pipeline_sns_config()
        self._topic_arn: str | None = None

    def _client(self):
        import boto3

        return boto3.client(
            "sns",
            endpoint_url=self.config.endpoint_url,
            region_name=self.config.region,
            aws_access_key_id="test",
            aws_secret_access_key="test",
        )

    def resolve_topic_arn(self) -> str:
        if self._topic_arn is not None:
            return self._topic_arn

        response = self._client().create_topic(Name=self.config.topic_name)
        topic_arn = response.get("TopicArn")
        if not isinstance(topic_arn, str):
            raise RuntimeError(f"SNS topic {self.config.topic_name} did not return an ARN.")

        self._topic_arn = topic_arn
        return topic_arn

    def publish(self, event: DatasetRefreshedEvent) -> bool:
        topic_arn = self.resolve_topic_arn()
        self._client().publish(TopicArn=topic_arn, Message=json.dumps(event))
        return True
