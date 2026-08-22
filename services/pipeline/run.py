"""Composes the five ExpenseFlow ingest pipeline stages in a fixed order:

    extract -> validate -> transform -> load -> publish_event

Each stage is a separate module (extract.py, validate.py, transform.py,
load.py, publish_event.py) with its own StageMetrics record (metrics.py).
run_pipeline() does not implement any stage's domain logic itself -- it
only sequences the five stage calls and collects their metrics, so this
file stays the one place a caller looks to see the pipeline's shape without
needing to read every stage's implementation.

validate.py raises metrics.ConservationError itself (not caught here) when
count_in != count_out + count_bad, so a conservation violation stops the
run at that point with a clear, typed exception rather than continuing on
an inconsistent row count.

Immediately after validate(), the run's quarantine rate (rejected_rows /
total_input_rows, see quarantine_rate.py) is computed from that same
StageMetrics, emitted to CloudWatch, and enforced against the threshold
configured in pipeline.toml. A rate exceeding that threshold raises
QuarantineRateExceededError here, before transform/load/publish_event
ever run -- the pipeline itself fails the run; a downstream CloudWatch
alarm on the emitted metric is not the enforcement mechanism.

publish_event only runs once load has fully succeeded (load_result.metrics
.count_bad == 0): a load that only partially wrote its rows is not a
successful load, and this composition must not tell downstream consumers
a dataset was refreshed when it was not.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path

from config import PipelineQualityConfig, load_pipeline_quality_config
from extract import extract
from load import LoadSink, load
from metrics import StageMetrics
from publish_event import EventPublisher, publish_event
from quarantine import QuarantineSink
from quarantine_rate import MetricPublisher, emit_quarantine_rate_metric
from quarantine_rate import enforce_quarantine_rate as _enforce_quarantine_rate
from quarantine_rate import quarantine_rate as _compute_quarantine_rate
from transform import transform
from validate import validate


@dataclass(frozen=True)
class PipelineRunResult:
    run_id: str
    stage_metrics: list[StageMetrics]
    rows_loaded: int
    event_published: bool
    quarantine_rate: float


def run_pipeline(
    export_path: Path | str,
    run_id: str | None = None,
    load_sink: LoadSink | None = None,
    event_publisher: EventPublisher | None = None,
    quarantine_sink: QuarantineSink | None = None,
    metric_publisher: MetricPublisher | None = None,
    quality_config: PipelineQualityConfig | None = None,
) -> PipelineRunResult:
    run_id = run_id if run_id is not None else str(uuid.uuid4())
    if quality_config is None:
        quality_config = load_pipeline_quality_config()
    stage_metrics: list[StageMetrics] = []

    extract_result = extract(export_path, run_id)
    stage_metrics.append(extract_result.metrics)

    validate_result = validate(extract_result.rows, run_id, quarantine_sink=quarantine_sink)
    stage_metrics.append(validate_result.metrics)

    observed_quarantine_rate = _compute_quarantine_rate(validate_result.metrics)
    emit_quarantine_rate_metric(observed_quarantine_rate, run_id, publisher=metric_publisher)
    _enforce_quarantine_rate(observed_quarantine_rate, quality_config.max_quarantine_rate, run_id)

    transform_result = transform(validate_result.good_rows, run_id)
    stage_metrics.append(transform_result.metrics)

    load_result = load(
        transform_result.aggregate.spend_by_tenant_gl_month,
        run_id,
        sink=load_sink,
    )
    stage_metrics.append(load_result.metrics)

    load_succeeded = load_result.metrics.count_bad == 0
    event_published = False

    if load_succeeded:
        publish_result = publish_event(
            load_result.accepted_count,
            run_id,
            publisher=event_publisher,
        )
        stage_metrics.append(publish_result.metrics)
        event_published = publish_result.published

    return PipelineRunResult(
        run_id=run_id,
        stage_metrics=stage_metrics,
        rows_loaded=load_result.accepted_count,
        event_published=event_published,
        quarantine_rate=observed_quarantine_rate,
    )


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Run the ExpenseFlow ingest pipeline.")
    parser.add_argument("export_path", type=Path)
    parser.add_argument("--run-id", default=None)
    parser.add_argument(
        "--sink",
        choices=["memory", "postgres"],
        default="memory",
        help=(
            "Where the load stage writes the spend roll-up. 'postgres' writes to the "
            "pipeline's own analytics schema (see config.py/PIPELINE_ANALYTICS_SCHEMA), "
            "never to an operational ExpenseFlow table. 'memory' (default) keeps output "
            "in-process only."
        ),
    )
    parser.add_argument(
        "--publisher",
        choices=["memory", "sns"],
        default="memory",
        help=(
            "Where the publish_event stage sends the dataset-refreshed event. 'sns' "
            "publishes onto the pipeline's own Module 6 SNS topic (see "
            "config.py/SNS_PIPELINE_DATASET_EVENTS_TOPIC). 'memory' (default) keeps the "
            "event in-process only."
        ),
    )
    parser.add_argument(
        "--quarantine",
        choices=["memory", "s3"],
        default="memory",
        help=(
            "Where the validate stage writes rows that fail semantic quality checks. "
            "'s3' writes to the pipeline's quarantine bucket on floci (see "
            "config.py/PIPELINE_QUARANTINE_BUCKET). 'memory' (default) keeps quarantined "
            "rows in-process only."
        ),
    )
    parser.add_argument(
        "--metric-publisher",
        choices=["memory", "cloudwatch"],
        default="memory",
        help=(
            "Where the quarantine-rate metric is published. 'cloudwatch' publishes to "
            "CloudWatch on floci (see config.py/PIPELINE_CLOUDWATCH_NAMESPACE). 'memory' "
            "(default) keeps the metric in-process only."
        ),
    )
    args = parser.parse_args()

    load_sink: LoadSink | None = None
    if args.sink == "postgres":
        from postgres_sink import PostgresLoadSink

        load_sink = PostgresLoadSink()

    event_publisher: EventPublisher | None = None
    if args.publisher == "sns":
        from sns_publisher import SnsEventPublisher

        event_publisher = SnsEventPublisher()

    quarantine_sink: QuarantineSink | None = None
    if args.quarantine == "s3":
        from quarantine import S3QuarantineSink

        quarantine_sink = S3QuarantineSink()

    metric_publisher: MetricPublisher | None = None
    if args.metric_publisher == "cloudwatch":
        from quarantine_rate import CloudWatchMetricPublisher

        metric_publisher = CloudWatchMetricPublisher()

    # QuarantineRateExceededError (see quarantine_rate.py) is deliberately
    # NOT caught here: letting it propagate is what makes the process exit
    # non-zero and prints the exception's own message (observed rate,
    # threshold, and the runbook path) to stderr -- the pipeline failing
    # the run, not a downstream alarm.
    result = run_pipeline(
        args.export_path,
        run_id=args.run_id,
        load_sink=load_sink,
        event_publisher=event_publisher,
        quarantine_sink=quarantine_sink,
        metric_publisher=metric_publisher,
    )

    for metrics in result.stage_metrics:
        print(
            f"[{metrics.stage}] run_id={metrics.run_id} "
            f"count_in={metrics.count_in} count_out={metrics.count_out} "
            f"count_bad={metrics.count_bad}"
        )
    print(
        f"rows_loaded={result.rows_loaded} event_published={result.event_published} "
        f"quarantine_rate={result.quarantine_rate:.4f}"
    )


if __name__ == "__main__":
    main()
