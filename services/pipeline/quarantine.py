"""Bad-row quarantine for rows that fail semantic data-quality validation
(see quality.py), written to S3 on the existing floci endpoint/config
convention -- the same AWS_ENDPOINT_URL/AWS_REGION every other pipeline
client already uses (config.py, sns_publisher.py), not a separate client
setup.

A quarantined row is never silently dropped and never proceeds to the
analytics load: validate.py routes any row with one or more
quality.QualityFailure entries into bad_rows (contributing to
StageMetrics.count_bad, never count_out) AND writes it here before
returning. Both things happen for the same reason from the same failure
list, so a row cannot become "bad" without also being quarantined.

Replayability: QuarantineSink.write() stores the row exactly as it
arrived at this stage -- the row already redacted by extract.py (see
extract.py, redaction.py) -- alongside the failing check's name and
reason and the run_id that produced it. After an upstream correction, the
same row (or the row's own fields, corrected) can be re-run through the
pipeline; nothing about the quarantine record's shape requires special
replay tooling. Receipt PII/payment identifiers are never written here in
unredacted form: this module writes exactly the dict it is given, and
every row reaching it has already passed through extract.py's redaction
before validate.py ever saw it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Protocol

from config import PipelineQuarantineConfig, load_pipeline_quarantine_config
from quality import QualityFailure


class QuarantineSink(Protocol):
    """Destination for a quarantined row plus the failure that sent it
    there. A real sink (S3, ...) implements this same interface;
    validate.py itself only depends on this protocol, never on a
    concrete transport.
    """

    def write(self, row: dict[str, Any], run_id: str, failure: QualityFailure) -> None:
        """Persist the quarantined row and its failing check/reason."""
        ...


@dataclass
class InMemoryQuarantineSink:
    """Default QuarantineSink: keeps quarantined records in memory.

    Stands in for a real destination when a caller does not need one
    (unit tests, or run_pipeline() callers who only want in-memory
    metrics). Every write() call's record is appended to .written, so a
    caller or test can assert on exactly what was quarantined.
    """

    written: list[dict[str, Any]] = field(default_factory=list)

    def write(self, row: dict[str, Any], run_id: str, failure: QualityFailure) -> None:
        self.written.append(_build_record(row, run_id, failure))


class S3QuarantineSink:
    """QuarantineSink implementation writing to the pipeline's quarantine
    bucket/prefix on floci S3.

    config is read once via config.load_pipeline_quarantine_config()
    unless an explicit PipelineQuarantineConfig is supplied (tests do
    this to avoid depending on process environment). One JSON object per
    (record_id, check) pair is written -- a row failing multiple checks
    produces multiple small objects, each embedding the identical
    redacted row, so any one object is independently sufficient to
    identify and replay that row.
    """

    def __init__(self, config: PipelineQuarantineConfig | None = None) -> None:
        self.config = config if config is not None else load_pipeline_quarantine_config()

    def _client(self):
        import boto3

        return boto3.client(
            "s3",
            endpoint_url=self.config.endpoint_url,
            region_name=self.config.region,
            aws_access_key_id="test",
            aws_secret_access_key="test",
        )

    def object_key(self, run_id: str, record_id: str, check: str) -> str:
        return f"{self.config.prefix}/{run_id}/{record_id}/{check}.json"

    def write(self, row: dict[str, Any], run_id: str, failure: QualityFailure) -> None:
        record = _build_record(row, run_id, failure)
        key = self.object_key(run_id, failure.record_id, failure.check)

        self._client().put_object(
            Bucket=self.config.bucket,
            Key=key,
            Body=json.dumps(record).encode("utf-8"),
            ContentType="application/json",
        )


def _build_record(row: dict[str, Any], run_id: str, failure: QualityFailure) -> dict[str, Any]:
    """The quarantine record shape written by every QuarantineSink:
    run_id preserved, the failing check/reason, non-sensitive identity
    (record_id, tenant_id, row_index), and the row exactly as received
    (already redacted upstream) for replay.
    """
    return {
        "run_id": run_id,
        "check": failure.check,
        "reason": failure.reason,
        "record_id": failure.record_id,
        "tenant_id": failure.tenant_id,
        "row_index": failure.row_index,
        "row": row,
    }
