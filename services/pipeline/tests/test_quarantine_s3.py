"""Integration test for the bad-row quarantine (quarantine.py +
validate.py's wiring) against a live floci S3, proving the five
end-to-end requirements this deliverable specifies:

  1. a semantic-quality failure never appears in the loaded/accepted
     output (test_quarantined_row_is_absent_from_the_accepted_output);
  2. the same row appears in the quarantine bucket on floci S3
     (test_quarantined_row_appears_in_s3);
  3. its failure reason is present in the quarantine object
     (test_quarantined_row_appears_in_s3);
  4. the raw synthetic sensitive values are absent from the quarantine
     object (test_quarantine_object_never_contains_the_raw_receipt_number);
  5. validate()'s counts still satisfy
     count_in == count_out + count_bad with quarantine active
     (test_validate_counts_reconcile_with_a_real_s3_quarantine_write).

Opt-in, matching the pattern in test_sns_publisher.py and
test_postgres_sink.py: skipped unless RUN_QUARANTINE_S3_TESTS=1, since it
needs `docker compose up -d floci` running locally, and is not part of
the default fast suite. The quarantine bucket is created by this test's
own fixture (create_bucket, idempotent), matching how
test_postgres_sink.py/test_equivalence_check.py already provision their
own test buckets rather than requiring a separate provisioning step.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))

from make_fixture import ROWS  # noqa: E402

from config import PipelineQuarantineConfig  # noqa: E402
from quarantine import S3QuarantineSink  # noqa: E402
from validate import validate  # noqa: E402

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_QUARANTINE_S3_TESTS") != "1",
    reason=(
        "requires `docker compose up -d floci` running locally; "
        "set RUN_QUARANTINE_S3_TESTS=1 to run"
    ),
)

TEST_ENDPOINT_URL = "http://localhost:4566"
TEST_REGION = "us-east-1"
TEST_BUCKET = "expenseflow-pipeline-quarantine-test"
TEST_PREFIX = "quarantine-test"

VALID_ROW = dict(ROWS[0])
ORIGINAL_RECEIPT_NUMBER = "RCT-SUPER-SECRET-999"


def _s3_client():
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=TEST_ENDPOINT_URL,
        region_name=TEST_REGION,
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )


@pytest.fixture
def test_config() -> PipelineQuarantineConfig:
    return PipelineQuarantineConfig(
        endpoint_url=TEST_ENDPOINT_URL, region=TEST_REGION, bucket=TEST_BUCKET, prefix=TEST_PREFIX
    )


@pytest.fixture(autouse=True)
def quarantine_bucket():
    s3 = _s3_client()
    try:
        s3.create_bucket(Bucket=TEST_BUCKET)
    except s3.exceptions.BucketAlreadyOwnedByYou:
        pass

    yield TEST_BUCKET

    response = s3.list_objects_v2(Bucket=TEST_BUCKET, Prefix=TEST_PREFIX)
    for obj in response.get("Contents", []):
        s3.delete_object(Bucket=TEST_BUCKET, Key=obj["Key"])


def _quarantined_row_with_receipt_already_redacted() -> dict[str, object]:
    # Rows reaching validate() have already passed through extract.py's
    # redaction (see extract.py, redaction.py) -- receipt_number arrives
    # as the literal censor token, never the original synthetic value.
    # ORIGINAL_RECEIPT_NUMBER is used only to assert its absence below,
    # simulating what the raw pre-redaction value would have been.
    return dict(
        VALID_ROW,
        amount_cents=0,  # forces a real, documented quality-check failure
        receipt_number="[REDACTED]",
    )


def _fetch_quarantine_object(key: str) -> dict:
    s3 = _s3_client()
    response = s3.get_object(Bucket=TEST_BUCKET, Key=key)
    return json.loads(response["Body"].read())


def test_quarantined_row_is_absent_from_the_accepted_output(test_config):
    sink = S3QuarantineSink(config=test_config)
    bad_row = _quarantined_row_with_receipt_already_redacted()
    good_row = dict(VALID_ROW, record_id="a-different-record-id")

    result = validate([bad_row, good_row], run_id="s3-quarantine-absent-test", quarantine_sink=sink)

    assert bad_row not in result.good_rows
    assert bad_row["record_id"] not in {row["record_id"] for row in result.good_rows}
    assert good_row in result.good_rows


def test_quarantined_row_appears_in_s3_with_its_failure_reason(test_config):
    sink = S3QuarantineSink(config=test_config)
    bad_row = _quarantined_row_with_receipt_already_redacted()

    validate([bad_row], run_id="s3-quarantine-appears-test", quarantine_sink=sink)

    key = sink.object_key("s3-quarantine-appears-test", bad_row["record_id"], "non_positive_amount")
    record = _fetch_quarantine_object(key)

    assert record["run_id"] == "s3-quarantine-appears-test"
    assert record["check"] == "non_positive_amount"
    assert "non-positive" in record["reason"]
    assert record["record_id"] == bad_row["record_id"]
    assert record["tenant_id"] == bad_row["tenant_id"]
    assert record["row"]["record_id"] == bad_row["record_id"]


def test_quarantine_object_never_contains_the_raw_receipt_number(test_config):
    sink = S3QuarantineSink(config=test_config)
    bad_row = _quarantined_row_with_receipt_already_redacted()

    validate([bad_row], run_id="s3-quarantine-redaction-test", quarantine_sink=sink)

    key = sink.object_key(
        "s3-quarantine-redaction-test", bad_row["record_id"], "non_positive_amount"
    )
    record = _fetch_quarantine_object(key)
    serialized = json.dumps(record)

    assert record["row"]["receipt_number"] == "[REDACTED]"
    assert ORIGINAL_RECEIPT_NUMBER not in serialized


def test_validate_counts_reconcile_with_a_real_s3_quarantine_write(test_config):
    sink = S3QuarantineSink(config=test_config)
    bad_row = _quarantined_row_with_receipt_already_redacted()
    good_row = dict(VALID_ROW, record_id="another-record-id")

    result = validate(
        [good_row, bad_row], run_id="s3-quarantine-conservation-test", quarantine_sink=sink
    )

    assert result.metrics.count_in == result.metrics.count_out + result.metrics.count_bad
    assert result.metrics.count_in == 2
    assert result.metrics.count_out == 1
    assert result.metrics.count_bad == 1
