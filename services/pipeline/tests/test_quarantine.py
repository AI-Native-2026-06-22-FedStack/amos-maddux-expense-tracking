"""Unit tests for quarantine.py's record shape and sink implementations
that do not require a live floci S3 endpoint (InMemoryQuarantineSink,
S3QuarantineSink.object_key()). The real S3 write path is covered by the
opt-in integration test in test_quarantine_s3.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import PipelineQuarantineConfig  # noqa: E402
from quality import QualityFailure  # noqa: E402
from quarantine import InMemoryQuarantineSink, S3QuarantineSink, _build_record  # noqa: E402

ROW = {
    "record_type": "line_item",
    "tenant_id": "t1",
    "record_id": "r1",
    "amount_cents": 0,
    "receipt_number": "[REDACTED]",
}

FAILURE = QualityFailure(
    check="non_positive_amount",
    reason="amount_cents is non-positive (0)",
    record_id="r1",
    tenant_id="t1",
)


def test_build_record_preserves_run_id_check_reason_and_identity():
    record = _build_record(ROW, "run-abc", FAILURE)

    assert record["run_id"] == "run-abc"
    assert record["check"] == "non_positive_amount"
    assert record["reason"] == "amount_cents is non-positive (0)"
    assert record["record_id"] == "r1"
    assert record["tenant_id"] == "t1"
    assert record["row_index"] is None


def test_build_record_embeds_the_row_exactly_as_given_for_replay():
    record = _build_record(ROW, "run-abc", FAILURE)

    assert record["row"] == ROW


def test_build_record_never_contains_an_unredacted_receipt_number():
    record = _build_record(ROW, "run-abc", FAILURE)

    assert record["row"]["receipt_number"] == "[REDACTED]"


def test_in_memory_quarantine_sink_stores_every_write():
    sink = InMemoryQuarantineSink()

    sink.write(ROW, "run-1", FAILURE)
    sink.write(ROW, "run-2", FAILURE)

    assert len(sink.written) == 2
    assert sink.written[0]["run_id"] == "run-1"
    assert sink.written[1]["run_id"] == "run-2"


def test_s3_quarantine_sink_object_key_layout():
    config = PipelineQuarantineConfig(
        endpoint_url="http://localhost:4566",
        region="us-east-1",
        bucket="test-bucket",
        prefix="quarantine",
    )
    sink = S3QuarantineSink(config=config)

    key = sink.object_key("run-abc", "record-123", "non_positive_amount")

    assert key == "quarantine/run-abc/record-123/non_positive_amount.json"
