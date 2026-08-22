"""Transform stage: produce the spend-by-tenant/GL-code/month aggregate.

This stage reuses services/pipeline/aggregate.py's aggregate_polars()
outright rather than reimplementing any grouping/filtering logic -- that
module is the single source of truth for the GL roll-up (see its own
docstring and docs/data/expense-export-profile.md's Task 2 section).

aggregate_polars() takes a file path, not an in-memory row list, so this
stage re-serializes validate.py's surviving rows to a temporary gzip/JSONL
file in the export's own shape and hands that path to aggregate_polars()
unchanged. This is a format bridge, not a reimplementation: no filter,
group, or aggregation decision is made here.

Row accounting here is deliberately not a row-for-row conservation claim:
aggregate_polars() both drops rows outside its scope (mileage rows, which
carry no amount_cents and are excluded from spend by the source flag rule's
own scope, not by any defect) and collapses many input rows into fewer
grouped output rows. count_out reports the grouped aggregate's own row
count -- the size of what this stage actually produces -- rather than a
count intended to reconcile against count_in via
metrics.check_conservation(), which is validate.py's contract, not this
one's.
"""

from __future__ import annotations

import gzip
import json
import tempfile
from dataclasses import dataclass
from pathlib import Path

from aggregate import SpendAggregate, aggregate_polars
from metrics import StageMetrics

STAGE_NAME = "transform"


@dataclass(frozen=True)
class TransformResult:
    aggregate: SpendAggregate
    metrics: StageMetrics


def transform(rows: list[dict[str, object]], run_id: str) -> TransformResult:
    with tempfile.NamedTemporaryFile(suffix=".jsonl.gz", delete=False) as tmp:
        tmp_path = Path(tmp.name)

    try:
        _write_rows_as_export(rows, tmp_path)
        aggregate = aggregate_polars(tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)

    metrics = StageMetrics(
        stage=STAGE_NAME,
        run_id=run_id,
        count_in=len(rows),
        count_out=len(aggregate.spend_by_tenant_gl_month),
        count_bad=0,
    )

    return TransformResult(aggregate=aggregate, metrics=metrics)


def _write_rows_as_export(rows: list[dict[str, object]], path: Path) -> None:
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row))
            f.write("\n")
