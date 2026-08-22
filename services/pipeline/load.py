"""Load stage: hand the transform stage's aggregate to a destination sink.

LoadSink is the seam a concrete destination implements. postgres_sink.py's
PostgresLoadSink is the real destination: it writes exclusively to the
pipeline-owned analytics schema created by
db/migrations/0001_pipeline_analytics_schema.sql (never to apps/api's or
services/compute's operational tables -- see config.py for how that schema
name is configured rather than hard-coded). InMemoryLoadSink below remains
the default for callers and tests that do not want a real database
dependency (e.g. run_pipeline() in run.py falls back to it when no sink is
given).

Row accounting: count_in is the number of grouped aggregate rows handed to
this stage (aggregate.SpendAggregate.spend_by_tenant_gl_month), count_out
is how many the sink actually accepted, count_bad is how many the sink
rejected. A sink that never rejects rows (the in-memory default) reports
count_bad == 0 and count_in == count_out.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import pandas as pd

from metrics import StageMetrics

STAGE_NAME = "load"


class LoadSink(Protocol):
    """Destination for the transform stage's grouped aggregate rows.

    A real sink (Postgres, Parquet/S3, ...) implements this same interface;
    load() itself only depends on this protocol, never on a concrete store.
    run_id is passed through so a sink can record provenance (which run
    produced these rows) alongside the data itself.
    """

    def write(self, rows: pd.DataFrame, run_id: str) -> int:
        """Persist rows, returning how many were actually accepted."""
        ...


@dataclass
class InMemoryLoadSink:
    """Default LoadSink: keeps written rows in memory for inspection.

    Stands in for a real destination when a caller does not need one (unit
    tests, or run_pipeline() callers who only want in-memory metrics). Every
    write() call's rows are appended to .written, so a caller or test can
    assert on exactly what the load stage persisted.
    """

    written: list[pd.DataFrame] = field(default_factory=list)
    run_ids: list[str] = field(default_factory=list)

    def write(self, rows: pd.DataFrame, run_id: str) -> int:
        self.written.append(rows)
        self.run_ids.append(run_id)
        return len(rows)


@dataclass(frozen=True)
class LoadResult:
    accepted_count: int
    metrics: StageMetrics


def load(
    spend_by_tenant_gl_month: pd.DataFrame,
    run_id: str,
    sink: LoadSink | None = None,
) -> LoadResult:
    sink = sink if sink is not None else InMemoryLoadSink()
    count_in = len(spend_by_tenant_gl_month)

    accepted_count = sink.write(spend_by_tenant_gl_month, run_id)
    count_bad = count_in - accepted_count

    metrics = StageMetrics(
        stage=STAGE_NAME,
        run_id=run_id,
        count_in=count_in,
        count_out=accepted_count,
        count_bad=count_bad,
    )

    return LoadResult(accepted_count=accepted_count, metrics=metrics)
