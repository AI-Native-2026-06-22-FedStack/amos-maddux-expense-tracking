#!/usr/bin/env python3
"""Benchmark aggregate_pandas() vs aggregate_polars() at full scale.

Each engine runs in its own subprocess so its peak RSS is measured in
isolation — an in-process comparison would double-count whichever engine
runs second (it inherits the first engine's still-resident allocations) and
would let neither engine's peak be attributed cleanly. Each subprocess
reports its OWN `resource.getrusage(RUSAGE_SELF).ru_maxrss` just before
exiting: RUSAGE_SELF.ru_maxrss is the resident-set high-water mark of that
process alone (including native pandas/numpy and polars/arrow buffers, not
just Python-heap allocations), and reading it from inside each child avoids
the trap of using the parent's RUSAGE_CHILDREN, whose ru_maxrss is a
running maximum across every child ever reaped — it would keep reporting
the first (larger) child's peak even while measuring the second, smaller one.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent.parent

_RUNNER_TEMPLATE = """
import resource
import sys
sys.path.insert(0, {pipeline_dir!r})
from aggregate import aggregate_{engine}
result = aggregate_{engine}({export_path!r})
print(len(result.spend_by_tenant_gl_month))
print(result.spend_by_tenant_gl_month["spend_cents"].sum())
print(result.flagged_line_item_count)
print(result.total_line_item_count)
print(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
"""


def run_engine(engine: str, export_path: Path) -> dict[str, object]:
    script = _RUNNER_TEMPLATE.format(
        pipeline_dir=str(PIPELINE_DIR), engine=engine, export_path=str(export_path)
    )

    start = time.perf_counter()
    completed = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        check=True,
        cwd=PIPELINE_DIR,
    )
    elapsed = time.perf_counter() - start

    lines = completed.stdout.strip().splitlines()
    row_count, total_spend_cents, flagged_count, total_line_items, peak_rss_kb_str = lines
    # ru_maxrss is in KB on Linux (bytes on macOS; this benchmark targets the
    # Linux CI/dev environment this repo runs in).
    peak_rss_kb = int(peak_rss_kb_str)

    return {
        "engine": engine,
        "wall_clock_seconds": elapsed,
        "peak_rss_mb": peak_rss_kb / 1024,
        "grouped_row_count": int(row_count),
        "total_spend_cents": int(total_spend_cents),
        "flagged_line_item_count": int(flagged_count),
        "total_line_item_count": int(total_line_items),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export_path", type=Path)
    args = parser.parse_args()

    results = {}
    for engine in ("pandas", "polars"):
        print(f"running {engine}...", file=sys.stderr)
        results[engine] = run_engine(engine, args.export_path)

    pandas_result = results["pandas"]
    polars_result = results["polars"]

    assert pandas_result["grouped_row_count"] == polars_result["grouped_row_count"], (
        "engines disagree on grouped row count: "
        f"{pandas_result['grouped_row_count']} vs {polars_result['grouped_row_count']}"
    )
    assert pandas_result["total_spend_cents"] == polars_result["total_spend_cents"], (
        "engines disagree on total spend: "
        f"{pandas_result['total_spend_cents']} vs {polars_result['total_spend_cents']}"
    )
    assert (
        pandas_result["flagged_line_item_count"] == polars_result["flagged_line_item_count"]
    ), "engines disagree on flagged line item count"

    print(f"\n{'engine':<10}{'wall_clock_s':>14}{'peak_rss_mb':>14}")
    for engine, r in results.items():
        print(f"{engine:<10}{r['wall_clock_seconds']:>14.3f}{r['peak_rss_mb']:>14.1f}")

    time_ratio = pandas_result["wall_clock_seconds"] / polars_result["wall_clock_seconds"]
    mem_ratio = pandas_result["peak_rss_mb"] / polars_result["peak_rss_mb"]
    print(f"\npolars is {time_ratio:.2f}x faster (wall clock)")
    print(f"polars uses {mem_ratio:.2f}x less peak RSS")
    print(
        f"\nboth engines agree: {pandas_result['grouped_row_count']} grouped rows, "
        f"{pandas_result['total_spend_cents']:,} total spend cents, "
        f"{pandas_result['flagged_line_item_count']:,}/"
        f"{pandas_result['total_line_item_count']:,} flagged"
    )


if __name__ == "__main__":
    main()
