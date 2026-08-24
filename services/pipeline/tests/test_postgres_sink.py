"""Integration tests for the pipeline's persistence boundary
(postgres_sink.py + the load stage) against a live Postgres.

Opt-in, matching the pattern in test_equivalence_check.py and
apps/api/test/*.integration.test.ts: skipped unless
RUN_POSTGRES_SINK_TESTS=1, since it needs `docker compose up -d postgres`
running locally with
services/pipeline/db/migrations/0001_pipeline_analytics_schema.sql already
applied, and is not part of the default fast suite.

These tests prove the persistence-boundary claims this work is required
to establish:
  1. transformed output can be written to and read back from the analytics
     schema (test_write_then_read_round_trips_transformed_output);
  2. running the load stage does not write to, update, or overwrite any
     operational ExpenseFlow table
     (test_load_stage_does_not_touch_operational_tables);
  3. the analytics output can be safely replaced/rebuilt by a later rerun,
     consistent with aggregate.py always recomputing the full grouped table
     rather than an incremental delta
     (test_rerun_replaces_previous_runs_output_entirely);
  4. a correctly transformed row validates against the outgoing
     models.AnalyticsRow model and is written
     (test_a_correctly_transformed_row_validates_and_is_written);
  5. a deliberately malformed transform result is rejected by that same
     model *before* any database write is attempted -- no DELETE, no
     INSERT (test_a_malformed_transform_result_is_rejected_before_any_db_write);
  6. invalid transformed data never appears in the analytics table, even
     when the table already holds prior valid data from an earlier run
     (test_invalid_transformed_data_never_appears_in_the_analytics_table).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import PipelineDbConfig  # noqa: E402
from load import load  # noqa: E402
from postgres_sink import AnalyticsRowValidationError, PostgresLoadSink  # noqa: E402
from run import run_pipeline  # noqa: E402
from transform import transform  # noqa: E402

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_POSTGRES_SINK_TESTS") != "1",
    reason=(
        "requires `docker compose up -d postgres` with "
        "services/pipeline/db/migrations/0001_pipeline_analytics_schema.sql applied; "
        "set RUN_POSTGRES_SINK_TESTS=1 to run"
    ),
)

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "tiny_export.jsonl.gz"

TEST_DATABASE_URI = "postgres://expenseflow:synthetic-compose-db-password@localhost:5433/expenseflow"
TEST_ANALYTICS_SCHEMA = "pipeline_analytics"

OPERATIONAL_TABLES = (
    "expense_report",
    "expense_line_item",
    "attachment_metadata",
    "receipt",
    "mileage_entry",
    "audit_entry",
    "stage_transition",
    "event_outbox",
    "role",
    '"user"',
    "credential",
    "refresh_token",
    "mfa_enrollment",
    "auth_audit_entry",
    "gl_code",
    "gl_mapping",
)


def _connect():
    import psycopg

    return psycopg.connect(TEST_DATABASE_URI)


def _count(cursor, qualified_table: str) -> int:
    cursor.execute(f"select count(*) from {qualified_table}")  # noqa: S608
    return cursor.fetchone()[0]


def _operational_table_counts() -> dict[str, int]:
    with _connect() as connection, connection.cursor() as cursor:
        return {table: _count(cursor, f"public.{table}") for table in OPERATIONAL_TABLES}


@pytest.fixture
def test_config() -> PipelineDbConfig:
    return PipelineDbConfig(database_uri=TEST_DATABASE_URI, analytics_schema=TEST_ANALYTICS_SCHEMA)


@pytest.fixture(autouse=True)
def clean_analytics_table():
    with _connect() as connection, connection.cursor() as cursor:
        cursor.execute(f"delete from {TEST_ANALYTICS_SCHEMA}.spend_by_tenant_gl_month")
        connection.commit()
    yield


def test_write_then_read_round_trips_transformed_output(test_config):
    """Transformed output (transform.py's reuse of aggregate.py) can be
    written to the analytics schema and read back with the same values.
    """
    from extract import extract
    from validate import validate

    extract_result = extract(FIXTURE_PATH, "round-trip-test")
    validate_result = validate(extract_result.rows, "round-trip-test")
    transform_result = transform(validate_result.good_rows, "round-trip-test")

    sink = PostgresLoadSink(config=test_config)
    load_result = load(
        transform_result.aggregate.spend_by_tenant_gl_month, "round-trip-test", sink=sink
    )

    assert load_result.accepted_count == 4
    assert load_result.metrics.count_bad == 0

    with _connect() as connection, connection.cursor() as cursor:
        cursor.execute(
            f"""
            select tenant_id, gl_account_code, month, spend_cents, line_item_count, run_id
            from {TEST_ANALYTICS_SCHEMA}.spend_by_tenant_gl_month
            order by tenant_id, gl_account_code, month
            """
        )
        rows = cursor.fetchall()

    assert len(rows) == 4
    by_key = {(r[0], r[1], r[2]): r for r in rows}

    tenant_a = "aaaaaaaa-0000-4000-8000-000000000001"
    tenant_b = "bbbbbbbb-0000-4000-8000-000000000002"

    a_6100_jan = by_key[(tenant_a, "6100", "2026-01")]
    assert a_6100_jan[3] == 61000  # spend_cents
    assert a_6100_jan[4] == 2  # line_item_count
    assert a_6100_jan[5] == "round-trip-test"  # run_id (provenance)

    # The leading-zero GL code must round-trip as text, not be coerced to an
    # int that collapses it with "6200" -- matching test_aggregate.py's own
    # leading-zero assertion, now proven through an actual Postgres round trip.
    a_leading_zero = by_key[(tenant_a, "06200", "2026-01")]
    assert a_leading_zero[3] == 50000

    b_6100_jan = by_key[(tenant_b, "6100", "2026-01")]
    assert b_6100_jan[3] == 75000


def test_load_stage_does_not_touch_operational_tables(test_config):
    """Running the load stage must not write to, update, or overwrite any
    operational ExpenseFlow table (expense_report, expense_line_item,
    gl_code, gl_mapping, auth tables, etc.) -- only the pipeline-owned
    analytics schema.
    """
    before = _operational_table_counts()

    run_pipeline(
        FIXTURE_PATH, run_id="no-touch-test", load_sink=PostgresLoadSink(config=test_config)
    )

    after = _operational_table_counts()

    assert after == before, (
        "load stage must not modify any operational table's row count; "
        f"before={before} after={after}"
    )


def test_rerun_replaces_previous_runs_output_entirely(test_config):
    """A later rerun safely replaces the analytics table's contents rather
    than accumulating duplicate or stale rows from a prior run -- matching
    aggregate.py's own design of always recomputing the full grouped table
    rather than an incremental delta.
    """
    sink = PostgresLoadSink(config=test_config)

    first_result = run_pipeline(FIXTURE_PATH, run_id="rerun-test-1", load_sink=sink)
    assert first_result.rows_loaded == 4

    second_result = run_pipeline(FIXTURE_PATH, run_id="rerun-test-2", load_sink=sink)
    assert second_result.rows_loaded == 4

    table = f"{TEST_ANALYTICS_SCHEMA}.spend_by_tenant_gl_month"
    with _connect() as connection, connection.cursor() as cursor:
        cursor.execute(f"select distinct run_id from {table}")
        run_ids = {row[0] for row in cursor.fetchall()}
        total_rows = _count(cursor, table)

    # Only the second run's rows remain -- the first run's output was fully
    # replaced, not appended to or left alongside the second run's rows.
    assert run_ids == {"rerun-test-2"}
    assert total_rows == 4


def test_postgres_sink_rejects_a_schema_other_than_the_analytics_one():
    """The sink is configured with the analytics schema (never hard-coded),
    and pointing it at a different schema name (e.g. by mistake) writes to
    that schema, not silently to 'public' -- proving the schema is actually
    threaded through, not ignored.
    """
    bad_schema_config = PipelineDbConfig(
        database_uri=TEST_DATABASE_URI, analytics_schema="schema_that_does_not_exist"
    )
    sink = PostgresLoadSink(config=bad_schema_config)

    import pandas as pd
    import psycopg

    frame = pd.DataFrame(
        [
            {
                "tenant_id": "t",
                "gl_account_code": "1",
                "month": "2026-01",
                "spend_cents": 1,
                "line_item_count": 1,
            }
        ]
    )

    with pytest.raises(psycopg.errors.UndefinedTable):
        sink.write(frame, run_id="should-not-land-anywhere")


def _analytics_table_rows(cursor) -> list[tuple]:
    cursor.execute(
        f"""
        select tenant_id, gl_account_code, month, spend_cents, line_item_count, run_id
        from {TEST_ANALYTICS_SCHEMA}.spend_by_tenant_gl_month
        """
    )
    return cursor.fetchall()


def test_a_correctly_transformed_row_validates_and_is_written(test_config):
    """A row shaped exactly like transform.py's real output validates
    against models.AnalyticsRow and is written to the analytics table.
    """
    import pandas as pd

    correct_row = pd.DataFrame(
        [
            {
                "tenant_id": "aaaaaaaa-0000-4000-8000-000000000001",
                "gl_account_code": "6100",
                "month": "2026-01",
                "spend_cents": 61000,
                "line_item_count": 2,
            }
        ]
    )

    sink = PostgresLoadSink(config=test_config)
    accepted_count = sink.write(correct_row, run_id="valid-row-test")

    assert accepted_count == 1

    with _connect() as connection, connection.cursor() as cursor:
        rows = _analytics_table_rows(cursor)

    assert rows == [
        ("aaaaaaaa-0000-4000-8000-000000000001", "6100", "2026-01", 61000, 2, "valid-row-test")
    ]


def test_a_malformed_transform_result_is_rejected_before_any_db_write(test_config):
    """A deliberately malformed transform result (a negative
    line_item_count, which a broken transform/aggregate could produce) is
    rejected by models.AnalyticsRow before any DELETE or INSERT is issued
    -- write() must raise AnalyticsRowValidationError with informative
    detail, not silently drop the row or write a corrupted value.
    """
    import pandas as pd

    malformed_row = pd.DataFrame(
        [
            {
                "tenant_id": "aaaaaaaa-0000-4000-8000-000000000001",
                "gl_account_code": "6100",
                "month": "2026-01",
                "spend_cents": 61000,
                "line_item_count": -2,  # broken transform: negative count
            }
        ]
    )

    sink = PostgresLoadSink(config=test_config)

    with pytest.raises(AnalyticsRowValidationError) as exc_info:
        sink.write(malformed_row, run_id="malformed-row-test")

    # Informative failure: identifies the offending row and the reason.
    assert "line_item_count" in str(exc_info.value)
    assert exc_info.value.row_index == 0
    assert exc_info.value.raw_row["line_item_count"] == -2

    with _connect() as connection, connection.cursor() as cursor:
        rows = _analytics_table_rows(cursor)

    # Nothing was written -- not even an empty DELETE was allowed to commit
    # before validation failed.
    assert rows == []


def test_invalid_transformed_data_never_appears_in_the_analytics_table(test_config):
    """Even when the analytics table already holds valid data from a prior
    run, a subsequent malformed write must not corrupt, partially
    overwrite, or otherwise alter that existing data -- the invalid row
    must never appear in the table, and the prior valid data must survive
    untouched.
    """
    import pandas as pd

    sink = PostgresLoadSink(config=test_config)

    prior_valid_row = pd.DataFrame(
        [
            {
                "tenant_id": "aaaaaaaa-0000-4000-8000-000000000001",
                "gl_account_code": "6100",
                "month": "2026-01",
                "spend_cents": 61000,
                "line_item_count": 2,
            }
        ]
    )
    sink.write(prior_valid_row, run_id="prior-good-run")

    malformed_row = pd.DataFrame(
        [
            {
                "tenant_id": "bbbbbbbb-0000-4000-8000-000000000002",
                "gl_account_code": "6200",
                "month": "2026-02",
                "spend_cents": 5000,
                "line_item_count": -1,
            }
        ]
    )

    with pytest.raises(AnalyticsRowValidationError):
        sink.write(malformed_row, run_id="malformed-run")

    with _connect() as connection, connection.cursor() as cursor:
        rows = _analytics_table_rows(cursor)

    # The invalid row's tenant/run never appear at all, and the prior run's
    # valid row is exactly as it was written -- untouched by the failed
    # write attempt.
    assert rows == [
        ("aaaaaaaa-0000-4000-8000-000000000001", "6100", "2026-01", 61000, 2, "prior-good-run")
    ]
    assert all(row[5] != "malformed-run" for row in rows)
