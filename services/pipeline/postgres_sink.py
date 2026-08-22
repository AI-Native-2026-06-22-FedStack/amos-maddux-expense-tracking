"""Postgres-backed LoadSink: the pipeline's real persistence boundary.

Writes exclusively to the pipeline-owned analytics schema created by
db/migrations/0001_pipeline_analytics_schema.sql (pipeline_analytics by
default, overridable via PIPELINE_ANALYTICS_SCHEMA -- see config.py). This
sink never touches apps/api's or services/compute's operational tables
(expense_report, expense_line_item, gl_code, gl_mapping, ...): it opens one
connection, writes to exactly one table
(<schema>.spend_by_tenant_gl_month), and does nothing else.

Outgoing boundary validation: every row is validated against
models.AnalyticsRow *before* any database connection is opened (see
_validate_rows()). This is the boundary that catches a broken transform
before it corrupts the analytics table -- if aggregate.py or transform.py
ever produced a malformed row (wrong type, a negative line_item_count, an
unexpected extra column), that row fails AnalyticsRowValidationError here,
with no DELETE and no INSERT having touched Postgres at all. Only the
validated AnalyticsRow representation (via model_dump()) is ever passed to
executemany() -- the raw DataFrame values are not written directly.

Rebuild semantics: aggregate.py's aggregate_polars()/aggregate_pandas()
always recompute the full grouped table from the whole export, not an
incremental delta, so this sink's write() replaces the table's entire
contents on every call (DELETE, then INSERT, in one transaction) rather
than upserting row-by-row. A later rerun -- with the same or a different
run_id -- safely rebuilds the table from scratch; there is no partial or
stale state left behind by an earlier run, and a failure mid-write rolls
back to the previous contents rather than leaving a half-loaded table.
DELETE is used rather than TRUNCATE so the operation participates in the
same transaction as the following INSERT without Postgres's
implicit-commit-adjacent TRUNCATE-locking behavior; the table's expected
size (one row per tenant/GL-code/month grouping) makes DELETE's lack of
TRUNCATE's O(1) metadata-only cost irrelevant here.
"""

from __future__ import annotations

import pandas as pd
from pydantic import ValidationError

from config import PipelineDbConfig, load_pipeline_db_config
from models import AnalyticsRow

ANALYTICS_TABLE = "spend_by_tenant_gl_month"

_INSERT_COLUMNS = (
    "tenant_id",
    "gl_account_code",
    "month",
    "spend_cents",
    "line_item_count",
    "run_id",
)


class AnalyticsRowValidationError(ValueError):
    """Raised when a transformed row fails AnalyticsRow validation before
    any database write is attempted.

    Wraps the underlying Pydantic ValidationError with the row's position
    in the batch and its raw (pre-validation) contents, so the failure
    message identifies which row was malformed and why, not just that
    "a row" failed somewhere in the batch.
    """

    def __init__(self, row_index: int, raw_row: dict[str, object], cause: ValidationError) -> None:
        self.row_index = row_index
        self.raw_row = raw_row
        self.cause = cause
        super().__init__(
            f"analytics row {row_index} failed AnalyticsRow validation "
            f"and was not written: {cause}. Raw row: {raw_row!r}"
        )


class PostgresLoadSink:
    """LoadSink implementation writing to the pipeline's analytics schema.

    config is read once via config.load_pipeline_db_config() unless an
    explicit PipelineDbConfig is supplied (tests do this to avoid depending
    on process environment). qualified_table() is the only place the
    schema-qualified table name is assembled, so the analytics schema name
    is never duplicated as a string literal elsewhere in this module.
    """

    def __init__(self, config: PipelineDbConfig | None = None) -> None:
        self.config = config if config is not None else load_pipeline_db_config()

    def qualified_table(self) -> str:
        return f"{self.config.analytics_schema}.{ANALYTICS_TABLE}"

    def write(self, rows: pd.DataFrame, run_id: str) -> int:
        import psycopg

        validated_rows = _validate_rows(rows, run_id)
        table = self.qualified_table()

        with psycopg.connect(self.config.database_uri) as connection:
            with connection.cursor() as cursor:
                cursor.execute(f"delete from {table}")  # noqa: S608 (schema/table from config, not user input)

                if validated_rows:
                    columns_sql = ", ".join(_INSERT_COLUMNS)
                    placeholders = ", ".join(["%s"] * len(_INSERT_COLUMNS))
                    insert_sql = f"insert into {table} ({columns_sql}) values ({placeholders})"  # noqa: S608

                    cursor.executemany(
                        insert_sql,
                        [_as_insert_tuple(row) for row in validated_rows],
                    )
            connection.commit()

        return len(validated_rows)


def _validate_rows(rows: pd.DataFrame, run_id: str) -> list[AnalyticsRow]:
    """Validate every row against AnalyticsRow before any database call.

    Raises AnalyticsRowValidationError on the first invalid row, with no
    connection opened and nothing written -- a broken transform must stop
    the load stage here, not load a partial or malformed dataset.
    """
    validated: list[AnalyticsRow] = []

    for row_index, record in enumerate(rows.to_dict(orient="records")):
        raw_row = {**record, "run_id": run_id}
        try:
            validated.append(AnalyticsRow.model_validate(raw_row))
        except ValidationError as exc:
            raise AnalyticsRowValidationError(row_index, raw_row, exc) from exc

    return validated


def _as_insert_tuple(row: AnalyticsRow) -> tuple[object, ...]:
    dumped = row.model_dump()
    return tuple(dumped[column] for column in _INSERT_COLUMNS)
