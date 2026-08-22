"""Quarantine-rate measurement and enforcement for the ExpenseFlow
pipeline.

quarantine_rate() computes, for one run:

    quarantine_rate = rejected_rows / total_input_rows

reusing validate.py's own StageMetrics (count_bad = rejected_rows,
count_in = total_input_rows for that stage) as the single source of truth
-- the same counts already used for the conservation invariant, not a
second, independently maintained tally. The zero-input case (count_in ==
0) returns 0.0 rather than raising a ZeroDivisionError: no rows means no
observed rejection signal at all, which is a defined, safe result rather
than an error condition.

emit_quarantine_rate_metric() publishes the observed rate to CloudWatch on
the existing floci endpoint/config convention (config.py's
PipelineCloudWatchConfig -- the same AWS_ENDPOINT_URL/AWS_REGION every
other floci client in this pipeline already uses), via a MetricPublisher
seam so tests can inject a fake without a live floci dependency, matching
the LoadSink/EventPublisher/QuarantineSink pattern already established in
load.py/publish_event.py/quarantine.py.

enforce_quarantine_rate() is the actual gate: given the observed rate and
the configured threshold (config.py's PipelineQualityConfig, read from
pipeline.toml -- see that file's own comments for why a policy threshold
lives there rather than in an environment variable), it raises
QuarantineRateExceededError when the rate exceeds the threshold. A
downstream CloudWatch alarm on the emitted metric is not sufficient on its
own: this exception is what actually fails the pipeline run, propagating
out of run_pipeline() uncaught so the process exits non-zero (see run.py).
The exception's message states the observed rate, the configured
threshold, and points at docs/runbooks/quarantine-rate.md, so a human
reading the failure output (a CI log, a terminal) has everything needed to
act without having to already know where the runbook lives.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

from config import PipelineCloudWatchConfig, load_pipeline_cloudwatch_config
from metrics import StageMetrics

METRIC_NAME = "QuarantineRate"
RUNBOOK_PATH = "docs/runbooks/quarantine-rate.md"


def quarantine_rate(metrics: StageMetrics) -> float:
    """rejected_rows / total_input_rows for the validate stage's own
    StageMetrics. Returns 0.0 when count_in == 0 (no input rows) rather
    than raising -- a run over an empty batch has no rejection signal to
    report, which is a defined, safe result, not an error.
    """
    if metrics.count_in == 0:
        return 0.0
    return metrics.count_bad / metrics.count_in


class QuarantineRateExceededError(RuntimeError):
    """Raised when a run's quarantine rate exceeds the configured
    threshold. This is what actually fails the pipeline run (see
    run.py) -- a CloudWatch alarm on the emitted metric is a downstream
    signal, not the enforcement mechanism itself.
    """

    def __init__(self, observed_rate: float, threshold: float, run_id: str) -> None:
        self.observed_rate = observed_rate
        self.threshold = threshold
        self.run_id = run_id
        super().__init__(
            f"quarantine rate {observed_rate:.4f} ({observed_rate:.2%}) for run "
            f"{run_id!r} exceeds the configured threshold {threshold:.4f} "
            f"({threshold:.2%}). See {RUNBOOK_PATH} for how to investigate and "
            f"respond to this failure."
        )


def enforce_quarantine_rate(observed_rate: float, threshold: float, run_id: str) -> None:
    """Raise QuarantineRateExceededError if observed_rate > threshold. A
    rate exactly at the threshold is allowed to continue -- the task's own
    policy is "at or below the threshold may continue," strict `>` is the
    failure condition, not `>=`.
    """
    if observed_rate > threshold:
        raise QuarantineRateExceededError(observed_rate, threshold, run_id)


class MetricPublisher(Protocol):
    """Destination for the quarantine-rate CloudWatch metric. A real
    publisher (a CloudWatch client) implements this same interface;
    emit_quarantine_rate_metric() itself only depends on this protocol,
    never on a concrete transport -- matching the LoadSink/EventPublisher/
    QuarantineSink pattern already used elsewhere in this pipeline.
    """

    def put_rate(self, rate: float, run_id: str) -> None:
        """Publish one quarantine-rate data point for this run."""
        ...


class InMemoryMetricPublisher:
    """Default MetricPublisher: keeps published rates in memory.

    Stands in for a real CloudWatch client when a caller does not need
    one (unit tests, or run_pipeline() callers who only want in-memory
    metrics).
    """

    def __init__(self) -> None:
        self.published: list[tuple[float, str]] = []

    def put_rate(self, rate: float, run_id: str) -> None:
        self.published.append((rate, run_id))


class CloudWatchMetricPublisher:
    """MetricPublisher implementation publishing to CloudWatch on the
    pipeline's existing floci endpoint/config convention.

    config is read once via config.load_pipeline_cloudwatch_config()
    unless an explicit PipelineCloudWatchConfig is supplied (tests do
    this to avoid depending on process environment).
    """

    def __init__(self, config: PipelineCloudWatchConfig | None = None) -> None:
        self.config = config if config is not None else load_pipeline_cloudwatch_config()

    def _client(self):
        import boto3

        return boto3.client(
            "cloudwatch",
            endpoint_url=self.config.endpoint_url,
            region_name=self.config.region,
            aws_access_key_id="test",
            aws_secret_access_key="test",
        )

    def put_rate(self, rate: float, run_id: str) -> None:
        self._client().put_metric_data(
            Namespace=self.config.namespace,
            MetricData=[
                {
                    "MetricName": METRIC_NAME,
                    "Value": rate,
                    "Unit": "None",
                    "Dimensions": [{"Name": "run_id", "Value": run_id}],
                }
            ],
        )


def emit_quarantine_rate_metric(
    rate: float, run_id: str, publisher: MetricPublisher | None = None
) -> None:
    publisher = publisher if publisher is not None else InMemoryMetricPublisher()
    publisher.put_rate(rate, run_id)


def runbook_path() -> Path:
    """Absolute path to the quarantine-rate runbook, for callers (e.g.
    run.py's CLI) that want to print or check for the file directly
    rather than just embedding the relative path string in a message.
    """
    return Path(__file__).resolve().parents[2] / RUNBOOK_PATH
