"""Extract stage: read raw rows from the gzip/JSONL export, redacting each
row before it leaves this stage.

Every row is redacted via redaction.redact_row() (the shared Module 3
boundary redactor -- see that module's docstring) immediately after JSON
decoding and before anything else happens to it: no schema check, no type
coercion, no downstream stage ever sees a row this function has not
already redacted. This ordering is deliberate and load-bearing --
validate.py's ExpenseRow validation, transform.py's aggregation, and any
quarantine/bad_rows representation all operate on this function's output,
so redacting here is what keeps receipt_number and any other sensitive
field out of every one of those downstream representations.

If redact_row() itself raises (RedactionError), that row's unredacted
data is not appended to `rows` and the exception propagates out of
extract() uncaught -- the pipeline run stops rather than letting an
unredacted row continue to validate/transform/load. This mirrors the rest
of this codebase's boundary-failure convention (validate.py's
ConservationError, postgres_sink.py's AnalyticsRowValidationError): a
failure at this boundary halts the run, it does not fall back to a lesser
guarantee.

count_in has no meaning for a file-reading stage (there is no upstream row
count to compare against), so count_in == count_out here by definition --
extract cannot itself lose or reject a row, it can only fail outright on a
malformed file or a redaction failure.
"""

from __future__ import annotations

import gzip
import json
from dataclasses import dataclass
from pathlib import Path

from metrics import StageMetrics
from redaction import redact_row

STAGE_NAME = "extract"


@dataclass(frozen=True)
class ExtractResult:
    """Redacted rows plus the source path, so later stages (transform.py in
    particular, which reuses aggregate.py's own file-level readers) can
    re-read the same file rather than needing rows re-serialized to disk.
    """

    export_path: Path
    rows: list[dict[str, object]]
    metrics: StageMetrics


def extract(export_path: Path | str, run_id: str) -> ExtractResult:
    path = Path(export_path)
    rows: list[dict[str, object]] = []

    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line == "":
                continue
            raw_row = json.loads(line)
            rows.append(redact_row(raw_row))

    metrics = StageMetrics(
        stage=STAGE_NAME,
        run_id=run_id,
        count_in=len(rows),
        count_out=len(rows),
        count_bad=0,
    )

    return ExtractResult(export_path=path, rows=rows, metrics=metrics)
