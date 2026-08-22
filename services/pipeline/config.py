"""Pipeline configuration: the one place environment-derived settings for
the persistence and event-publishing boundaries are read from, so schema
names, connection strings, and AWS/floci endpoint details are not scattered
as string literals across extract/validate/transform/load/publish_event or
their tests.

Follows the same convention as services/compute/app/db.py: a plain
os.getenv() read, no config framework, no Pydantic settings model (that is
a separate, later concern -- see this module's callers for how a missing
required value is surfaced).

Policy/threshold values that are not per-environment connection details
(e.g. the quarantine-rate failure threshold) are read from pipeline.toml
instead of an environment variable -- see load_pipeline_quality_config()
-- using the standard-library tomllib (no new dependency; Python >=3.13
per pyproject.toml).
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

DEFAULT_ANALYTICS_SCHEMA = "pipeline_analytics"
DEFAULT_AWS_REGION = "us-east-1"
DEFAULT_PIPELINE_DATASET_EVENTS_TOPIC = "expenseflow-pipeline-dataset-events"
DEFAULT_QUARANTINE_BUCKET = "expenseflow-pipeline-quarantine"
DEFAULT_QUARANTINE_PREFIX = "quarantine"
DEFAULT_CLOUDWATCH_NAMESPACE = "ExpenseFlow/Pipeline"

PIPELINE_TOML_PATH = Path(__file__).resolve().parent / "pipeline.toml"


@dataclass(frozen=True)
class PipelineDbConfig:
    """Connection string plus the analytics schema name pipeline output
    belongs in. This schema is owned exclusively by services/pipeline (see
    db/migrations/0001_pipeline_analytics_schema.sql) and must never be an
    operational schema/table owned by apps/api or services/compute.
    """

    database_uri: str
    analytics_schema: str


def load_pipeline_db_config() -> PipelineDbConfig:
    """Read DATABASE_URI and PIPELINE_ANALYTICS_SCHEMA from the environment.

    DATABASE_URI matches the env var name every other ExpenseFlow service
    already uses (.env.example, services/compute/app/db.py,
    services/pipeline/valid_line_items.py's DEFAULT_POSTGRES_DSN) --
    services share one physical Postgres instance, split by schema/table
    ownership per ADR-0006, not by a separate connection string per service.

    PIPELINE_ANALYTICS_SCHEMA defaults to DEFAULT_ANALYTICS_SCHEMA so local
    development and tests work without extra setup, but is overridable so a
    deployment can point pipeline output at a differently named schema
    without editing code.
    """
    database_uri = os.getenv("DATABASE_URI")
    if database_uri is None or database_uri.strip() == "":
        raise RuntimeError("DATABASE_URI is required to connect the pipeline's analytics sink.")

    analytics_schema = os.getenv("PIPELINE_ANALYTICS_SCHEMA", DEFAULT_ANALYTICS_SCHEMA).strip()
    if analytics_schema == "":
        raise RuntimeError("PIPELINE_ANALYTICS_SCHEMA must not be blank.")

    return PipelineDbConfig(database_uri=database_uri, analytics_schema=analytics_schema)


@dataclass(frozen=True)
class PipelineSnsConfig:
    """Endpoint, region, and topic name for publishing the pipeline's
    dataset-refreshed event onto Module 6's SNS->SQS infrastructure (see
    docs/adr/0014-event-taxonomy-and-cloudevents.md and
    sns_publisher.py). This is a separate topic from
    SNS_STAGE_EVENTS_TOPIC -- see sns_publisher.py's own docstring for why.
    """

    endpoint_url: str
    region: str
    topic_name: str


def load_pipeline_sns_config() -> PipelineSnsConfig:
    """Read the floci/AWS endpoint, region, and topic name from the
    environment, using the exact same env var names as every other
    ExpenseFlow service (.env.example: AWS_ENDPOINT_URL/AWS_ENDPOINT,
    AWS_REGION) rather than inventing pipeline-specific ones for the
    connection details. Only the topic name
    (SNS_PIPELINE_DATASET_EVENTS_TOPIC) is pipeline-specific, matching how
    SNS_STAGE_EVENTS_TOPIC is apps/api's own topic-name variable.
    """
    endpoint_url = os.getenv("AWS_ENDPOINT_URL") or os.getenv("AWS_ENDPOINT")
    if endpoint_url is None or endpoint_url.strip() == "":
        raise RuntimeError(
            "AWS_ENDPOINT_URL (or AWS_ENDPOINT) is required to reach the local floci "
            "SNS endpoint."
        )

    region = os.getenv("AWS_REGION", DEFAULT_AWS_REGION).strip()
    if region == "":
        raise RuntimeError("AWS_REGION must not be blank.")

    topic_name = os.getenv(
        "SNS_PIPELINE_DATASET_EVENTS_TOPIC", DEFAULT_PIPELINE_DATASET_EVENTS_TOPIC
    ).strip()
    if topic_name == "":
        raise RuntimeError("SNS_PIPELINE_DATASET_EVENTS_TOPIC must not be blank.")

    return PipelineSnsConfig(
        endpoint_url=endpoint_url.strip(), region=region, topic_name=topic_name
    )


@dataclass(frozen=True)
class PipelineQuarantineConfig:
    """Endpoint, region, bucket, and key prefix for writing quarantined
    (semantic-quality-failed) rows to S3 on the existing floci endpoint --
    see quarantine.py.
    """

    endpoint_url: str
    region: str
    bucket: str
    prefix: str


def load_pipeline_quarantine_config() -> PipelineQuarantineConfig:
    """Read the floci/AWS endpoint, region, quarantine bucket, and key
    prefix from the environment, reusing the exact same
    AWS_ENDPOINT_URL/AWS_ENDPOINT/AWS_REGION env vars every other
    ExpenseFlow client and load_pipeline_sns_config() already use, rather
    than inventing a separate client/endpoint convention for quarantine.
    Only the bucket/prefix names are pipeline-specific, matching how
    SNS_PIPELINE_DATASET_EVENTS_TOPIC is the one pipeline-specific value
    load_pipeline_sns_config() reads.
    """
    endpoint_url = os.getenv("AWS_ENDPOINT_URL") or os.getenv("AWS_ENDPOINT")
    if endpoint_url is None or endpoint_url.strip() == "":
        raise RuntimeError(
            "AWS_ENDPOINT_URL (or AWS_ENDPOINT) is required to reach the local floci "
            "S3 endpoint."
        )

    region = os.getenv("AWS_REGION", DEFAULT_AWS_REGION).strip()
    if region == "":
        raise RuntimeError("AWS_REGION must not be blank.")

    bucket = os.getenv("PIPELINE_QUARANTINE_BUCKET", DEFAULT_QUARANTINE_BUCKET).strip()
    if bucket == "":
        raise RuntimeError("PIPELINE_QUARANTINE_BUCKET must not be blank.")

    prefix = os.getenv("PIPELINE_QUARANTINE_PREFIX", DEFAULT_QUARANTINE_PREFIX).strip()
    if prefix == "":
        raise RuntimeError("PIPELINE_QUARANTINE_PREFIX must not be blank.")

    return PipelineQuarantineConfig(
        endpoint_url=endpoint_url.strip(), region=region, bucket=bucket, prefix=prefix
    )


@dataclass(frozen=True)
class PipelineQualityConfig:
    """Policy thresholds for the pipeline's own data-quality gates. See
    quarantine_rate.py for how max_quarantine_rate is enforced.
    """

    max_quarantine_rate: float


def load_pipeline_quality_config(toml_path: Path | None = None) -> PipelineQualityConfig:
    """Read [quarantine].max_rate from pipeline.toml -- a policy value,
    not a per-environment connection detail, so it lives in the
    repository-committed TOML config rather than an environment variable
    (see this module's own docstring).
    """
    path = toml_path if toml_path is not None else PIPELINE_TOML_PATH
    if not path.exists():
        raise RuntimeError(f"pipeline.toml not found at {path}.")

    with path.open("rb") as f:
        data = tomllib.load(f)

    try:
        max_rate = data["quarantine"]["max_rate"]
    except KeyError as exc:
        raise RuntimeError(
            f"{path} is missing the required [quarantine].max_rate setting."
        ) from exc

    if not isinstance(max_rate, int | float) or isinstance(max_rate, bool):
        raise RuntimeError(f"{path}'s [quarantine].max_rate must be a number, got {max_rate!r}.")
    if not (0.0 <= max_rate <= 1.0):
        raise RuntimeError(
            f"{path}'s [quarantine].max_rate must be between 0.0 and 1.0, got {max_rate!r}."
        )

    return PipelineQualityConfig(max_quarantine_rate=float(max_rate))


@dataclass(frozen=True)
class PipelineCloudWatchConfig:
    """Endpoint, region, and metric namespace for emitting the
    pipeline's own operational metrics (quarantine rate) to CloudWatch on
    the existing floci endpoint -- see quarantine_rate.py.
    """

    endpoint_url: str
    region: str
    namespace: str


def load_pipeline_cloudwatch_config() -> PipelineCloudWatchConfig:
    """Read the floci/AWS endpoint, region, and CloudWatch metric
    namespace from the environment, reusing the exact same
    AWS_ENDPOINT_URL/AWS_ENDPOINT/AWS_REGION env vars every other
    ExpenseFlow client already uses, rather than inventing a separate
    client/endpoint convention for CloudWatch. Only the namespace
    (PIPELINE_CLOUDWATCH_NAMESPACE) is pipeline-specific.
    """
    endpoint_url = os.getenv("AWS_ENDPOINT_URL") or os.getenv("AWS_ENDPOINT")
    if endpoint_url is None or endpoint_url.strip() == "":
        raise RuntimeError(
            "AWS_ENDPOINT_URL (or AWS_ENDPOINT) is required to reach the local floci "
            "CloudWatch endpoint."
        )

    region = os.getenv("AWS_REGION", DEFAULT_AWS_REGION).strip()
    if region == "":
        raise RuntimeError("AWS_REGION must not be blank.")

    namespace = os.getenv("PIPELINE_CLOUDWATCH_NAMESPACE", DEFAULT_CLOUDWATCH_NAMESPACE).strip()
    if namespace == "":
        raise RuntimeError("PIPELINE_CLOUDWATCH_NAMESPACE must not be blank.")

    return PipelineCloudWatchConfig(
        endpoint_url=endpoint_url.strip(), region=region, namespace=namespace
    )
