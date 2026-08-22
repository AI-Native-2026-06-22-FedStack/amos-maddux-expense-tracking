"""Integration test for tools/equivalence_check.py against a live floci +
Postgres, using the small fixture end-to-end: archive it, load it, then
assert the two totals match exactly.

Opt-in, matching the pattern in apps/api/test/*.integration.test.ts: skipped
unless RUN_EQUIVALENCE_CHECK_TESTS=1, since it needs `docker compose up
postgres floci` running locally and is not part of the default fast suite.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from valid_line_items import DEFAULT_POSTGRES_DSN  # noqa: E402

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_EQUIVALENCE_CHECK_TESTS") != "1",
    reason=(
        "requires `docker compose up -d postgres floci`; "
        "set RUN_EQUIVALENCE_CHECK_TESTS=1 to run"
    ),
)

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "tiny_export.jsonl.gz"
TEST_BUCKET = "expenseflow-equivalence-check-test"
TEST_PREFIX = "valid-line-items-test"
POSTGRES_DSN = DEFAULT_POSTGRES_DSN


@pytest.fixture
def clean_postgres_line_items():
    # Cleanup goes through psql directly, not a DuckDB `ATTACH ...
    # (TYPE postgres)` connection: TRUNCATE issued through that extension was
    # measured at ~27s for 1.5M rows (and did not finish within 90s for a
    # second, larger table) even though native Postgres TRUNCATE is a
    # metadata-only operation and completes in ~0.1s via psql regardless of
    # row count — see docs/data/expense-export-profile.md's "DuckDB
    # postgres extension TRUNCATE is not O(1)" finding. This fixture uses
    # the fast path.
    subprocess.run(
        [
            "psql",
            "-h", "localhost", "-p", "5433", "-U", "expenseflow", "-d", "expenseflow",
            "-c", "TRUNCATE expense_line_item, expense_report CASCADE;",
        ],
        env={**os.environ, "PGPASSWORD": "synthetic-compose-db-password"},
        check=True,
        capture_output=True,
    )
    yield


@pytest.fixture
def test_bucket():
    import boto3

    s3 = boto3.client(
        "s3",
        endpoint_url="http://localhost:4566",
        aws_access_key_id="test",
        aws_secret_access_key="test",
        region_name="us-east-1",
    )
    try:
        s3.create_bucket(Bucket=TEST_BUCKET)
    except s3.exceptions.BucketAlreadyOwnedByYou:
        pass
    yield TEST_BUCKET


def test_equivalence_check_matches_on_fixture(clean_postgres_line_items, test_bucket):
    import tempfile

    from archive_valid_line_items import upload_to_floci, write_partitioned_parquet
    from equivalence_check import run_equivalence_check
    from load_line_items_to_postgres import load

    load(FIXTURE_PATH, POSTGRES_DSN)

    with tempfile.TemporaryDirectory() as tmp:
        dataset_dir = write_partitioned_parquet(FIXTURE_PATH, Path(tmp))
        upload_to_floci(dataset_dir, test_bucket, TEST_PREFIX, "http://localhost:4566")

    # Must not raise: the fixture's valid, deduped line items should match
    # exactly between the Parquet archive and what was just loaded into
    # Postgres from the same row-selection rule.
    run_equivalence_check(
        bucket=test_bucket,
        prefix=TEST_PREFIX,
        postgres_dsn=POSTGRES_DSN,
        endpoint_url="http://localhost:4566",
    )


def test_equivalence_check_fails_loudly_on_a_real_mismatch(clean_postgres_line_items, test_bucket):
    import tempfile

    import duckdb
    from archive_valid_line_items import upload_to_floci, write_partitioned_parquet
    from equivalence_check import run_equivalence_check
    from load_line_items_to_postgres import load

    load(FIXTURE_PATH, POSTGRES_DSN)

    with tempfile.TemporaryDirectory() as tmp:
        dataset_dir = write_partitioned_parquet(FIXTURE_PATH, Path(tmp))
        upload_to_floci(dataset_dir, test_bucket, TEST_PREFIX, "http://localhost:4566")

    # Inject a 1-cent discrepancy directly into Postgres, matching the
    # docs/data/expense-export-profile.md finding-verification method.
    con = duckdb.connect()
    con.execute("INSTALL postgres;")
    con.execute("LOAD postgres;")
    con.execute(f"ATTACH '{POSTGRES_DSN}' AS pg (TYPE postgres);")
    con.execute(
        "UPDATE pg.public.expense_line_item SET amount_cents = amount_cents + 1 "
        "WHERE id = (SELECT id FROM pg.public.expense_line_item LIMIT 1)"
    )
    con.close()

    with pytest.raises(AssertionError, match="SPEND TOTAL MISMATCH"):
        run_equivalence_check(
            bucket=test_bucket,
            prefix=TEST_PREFIX,
            postgres_dsn=POSTGRES_DSN,
            endpoint_url="http://localhost:4566",
        )
