# PR description draft — m9d1-implementation → main

Copy everything below into the PR body when you open it. Fill in the two `<FIXME>` placeholders (Jira ticket, reviewer handle) before posting — I didn't have those.

---

## Summary

Implements the M9D1 analytical pipeline slice for ExpenseFlow: a deterministic multi-million-row export generator, a declared (not inferred) read schema, a pandas-vs-Polars spend aggregate with a proven lazy query plan, a Parquet archive on floci, and a DuckDB equivalence check that reconciles the archive against the live Postgres system of record.

File-level purpose:
- `services/pipeline/tools/generate_export.py`: deterministic, fixed-seed, gzip-JSONL export generator with six seeded data-quality defects (pre-existing on this branch; profiled and exercised by everything below).
- `services/pipeline/schema.py`: the declared read schema — every column of the export typed explicitly (identifiers as strings, `amount_cents` as integer minor units, dates/timestamps as real date/datetime types), never left to `pandas`/`polars` inference.
- `docs/data/expense-export-profile.md`: full-scale profiling (row counts, inferred dtypes, null rates, memory footprint), every seeded anomaly named with its column and exact row count, the pandas-vs-Polars benchmark and query-plan proof, the engine justification, the Parquet round-trip evidence, and the DuckDB/Postgres equivalence-check finding.
- `services/pipeline/aggregate.py`: `aggregate_pandas()` and `aggregate_polars()` — the same spend-per-tenant/GL-code/month aggregate plus the GL-Coding Engine's $500 flag-rate, implemented once eagerly (pandas) and once as a lazy Polars pipeline (`pl.scan_ndjson` → filter → select → `.collect()`).
- `services/pipeline/tools/benchmark_aggregate.py`: subprocess-isolated wall-clock and peak-RSS benchmark comparing the two engines at full scale.
- `services/pipeline/tools/archive_to_parquet.py`, `archive_valid_line_items.py`: write the aggregate (and a row-level, DB-loadable subset) to Hive-partitioned Parquet and upload to floci S3.
- `services/pipeline/valid_line_items.py`, `tools/load_line_items_to_postgres.py`: the shared row-selection rule (rows that satisfy `expense_line_item`'s real check constraints and primary key) used identically to load Postgres and to build the row-level archive, so the equivalence check compares the same row set on both sides.
- `services/pipeline/tools/equivalence_check.py`: DuckDB, one session, `read_parquet(...)` over the archive and `ATTACH ... (TYPE postgres)` over live Postgres — exact integer-cents assertion, no tolerance, fails loudly on mismatch.
- `services/pipeline/tests/test_aggregate.py`, `test_equivalence_check.py`: pytest coverage for both aggregate engines and the equivalence check (integration tests opt-in via `RUN_EQUIVALENCE_CHECK_TESTS=1`, matching the existing `apps/api` integration-test convention).

## Jira Ticket

<FIXME: link the Jira ticket, or state "N/A - course rubric task; no Jira ticket was provided" if this is coursework, matching the convention already used on this repo's other PRs>

## Related ADRs

N/A - no architectural decision changed.

## Testing and Validation

### 1. Lazy query plan — predicate and projection pushed into the scan

```text
$ python3 -c "
from aggregate import _polars_lazy_scan
lf = _polars_lazy_scan('data/exports/expense_export_seed42_rows2000000.jsonl.gz')
print(lf.explain(optimized=True))
"
simple π 4/4 ["tenant_id", "gl_account_code", ... 2 other columns]
  NDJson SCAN [/home/.../data/exports/expense_export_seed42_rows2000000.jsonl.gz]
  PROJECT 5/25 COLUMNS
  SELECTION: col("record_type") == "line_item"
```

`SELECTION:` and `PROJECT 5/25 COLUMNS` are attributes of the `NDJson SCAN` node itself — the filter and column selection happen during the scan, not as separate steps after reading everything. (For contrast, the unoptimized plan and the `read_ndjson(...).lazy()` anti-pattern are both captured in `docs/data/expense-export-profile.md`'s "Confirming the optimizer is actually pushing down" section — the latter produces a `DF [...]`-rooted plan with no scan-level pushdown at all.)

### 2. Full-scale benchmark — pandas baseline vs. lazy Polars pipeline

```text
$ python3 tools/benchmark_aggregate.py data/exports/expense_export_seed42_rows2000000.jsonl.gz
running pandas...
running polars...

engine      wall_clock_s   peak_rss_mb
pandas            28.298        8891.6
polars             1.910         751.0

polars is 14.82x faster (wall clock)
polars uses 11.84x less peak RSS

both engines agree: 864 grouped rows, 194,252,389,703 total spend cents, 1,256,894/1,599,680 flagged
```

Both figures measured via subprocess-isolated `resource.getrusage(RUSAGE_SELF).ru_maxrss`, at the full 2,000,000-row export (not a sample — see the AI-tool reflection below).

### 3. DuckDB equivalence check — Parquet archive vs. live Postgres

```text
$ python3 tools/equivalence_check.py
Parquet  (s3://expenseflow-valid-line-items-m9d1/valid-line-items): 1,512,518 rows, 189,354,146,308 cents ($1,893,541,463.08)
Postgres (expense_line_item):       1,512,518 rows, 189,354,146,308 cents ($1,893,541,463.08)

MATCH: both sides sum to exactly 189,354,146,308 cents ($1,893,541,463.08) over 1,512,518 rows.
```

Exact integer-cents equality, no tolerance. Row count is smaller than the full export's line-item count because `expense_line_item`'s real check constraints and primary key structurally reject some of the export's seeded defect rows (non-positive `amount_cents`, non-`[A-Z]{3}` currency, duplicate `record_id`) — both sides of the comparison apply the identical row-selection rule (`services/pipeline/valid_line_items.py`) before summing, so the match is apples-to-apples. Full finding recorded in `docs/data/expense-export-profile.md`.

### 4. Test suite

```text
$ python3 -m pytest tests/ -v
tests/test_aggregate.py::test_excludes_mileage_rows_from_line_item_count[pandas] PASSED
tests/test_aggregate.py::test_excludes_mileage_rows_from_line_item_count[polars] PASSED
tests/test_aggregate.py::test_flag_rule_is_strictly_greater_than_threshold[pandas] PASSED
tests/test_aggregate.py::test_flag_rule_is_strictly_greater_than_threshold[polars] PASSED
tests/test_aggregate.py::test_flag_threshold_constant_matches_gl_coding_engine PASSED
tests/test_aggregate.py::test_groups_by_tenant_gl_code_and_month[pandas] PASSED
tests/test_aggregate.py::test_groups_by_tenant_gl_code_and_month[polars] PASSED
tests/test_aggregate.py::test_leading_zero_gl_code_survives_as_distinct_string_key[pandas] PASSED
tests/test_aggregate.py::test_leading_zero_gl_code_survives_as_distinct_string_key[polars] PASSED
tests/test_aggregate.py::test_total_spend_matches_sum_of_flagged_and_unflagged PASSED
tests/test_aggregate.py::test_pandas_and_polars_agree_exactly PASSED
tests/test_equivalence_check.py::test_equivalence_check_matches_on_fixture SKIPPED
tests/test_equivalence_check.py::test_equivalence_check_fails_loudly_on_a_real_mismatch SKIPPED

11 passed, 2 skipped in 0.39s

$ RUN_EQUIVALENCE_CHECK_TESTS=1 python3 -m pytest tests/ -v
tests/test_aggregate.py::test_excludes_mileage_rows_from_line_item_count[pandas] PASSED
tests/test_aggregate.py::test_excludes_mileage_rows_from_line_item_count[polars] PASSED
tests/test_aggregate.py::test_flag_rule_is_strictly_greater_than_threshold[pandas] PASSED
tests/test_aggregate.py::test_flag_rule_is_strictly_greater_than_threshold[polars] PASSED
tests/test_aggregate.py::test_flag_threshold_constant_matches_gl_coding_engine PASSED
tests/test_aggregate.py::test_groups_by_tenant_gl_code_and_month[pandas] PASSED
tests/test_aggregate.py::test_groups_by_tenant_gl_code_and_month[polars] PASSED
tests/test_aggregate.py::test_leading_zero_gl_code_survives_as_distinct_string_key[pandas] PASSED
tests/test_aggregate.py::test_leading_zero_gl_code_survives_as_distinct_string_key[polars] PASSED
tests/test_aggregate.py::test_total_spend_matches_sum_of_flagged_and_unflagged PASSED
tests/test_aggregate.py::test_pandas_and_polars_agree_exactly PASSED
tests/test_equivalence_check.py::test_equivalence_check_matches_on_fixture PASSED
tests/test_equivalence_check.py::test_equivalence_check_fails_loudly_on_a_real_mismatch PASSED

13 passed in 2.24s
```

The two integration tests are opt-in (need `docker compose up -d postgres floci`); the second one deliberately injects a 1-cent Postgres mismatch and asserts `equivalence_check.py` raises `SPEND TOTAL MISMATCH` — proof the exact-equality assertion is live, not trivially passing.

### 5. Reproducibility

```text
$ python3 tools/generate_export.py --rows 2000000 --seed 42 --out-dir /tmp/verify
wrote 2000000 rows to /tmp/verify/expense_export_seed42_rows2000000.jsonl.gz

$ sha256sum data/exports/expense_export_seed42_rows2000000.jsonl.gz /tmp/verify/expense_export_seed42_rows2000000.jsonl.gz
cf3183286031421cb16aa0d849e42db705a0eae3309a61bc8acb29ca5db55876  data/exports/expense_export_seed42_rows2000000.jsonl.gz
cf3183286031421cb16aa0d849e42db705a0eae3309a61bc8acb29ca5db55876  /tmp/verify/expense_export_seed42_rows2000000.jsonl.gz
```

Byte-identical regeneration confirmed at both `--rows 1000` and `--rows 2000000`, same `--seed 42`.

## AI-tool reflection

I accepted Claude's suggestion to measure peak memory via subprocess-isolated `resource.getrusage(RUSAGE_SELF).ru_maxrss` rather than in-process `tracemalloc`: `tracemalloc` only tracks Python-heap allocations and would have understated both engines badly, since most of their memory lives in native pandas/numpy or Polars/Arrow buffers — and running both engines in the same process would have let one engine's leftover allocations pollute the other's measurement. I rejected the shortcut of proving Polars' pushdown by asserting it from the plan-builder code alone; instead I made Claude print both the unoptimized and optimized `explain()` output side by side, and separately demonstrated the `read_ndjson(...).lazy()` trap directly (it produces a `DF [...]`-rooted plan with no scan-level pushdown at all) — an assertion without that side-by-side comparison would have been exactly the kind of "trust me, it's pushing down" claim the task asked us not to make. Similarly, when the DuckDB/Postgres totals first diverged because ~87K of the export's seeded-defect rows structurally cannot exist in a real `expense_line_item` table, the obvious shortcut would have been a tolerance or a rounded comparison — that was rejected outright (a tolerance on a money comparison is exactly the failure mode the task warned about), and the actual fix was a shared row-selection rule applied identically on both sides before summing.

## Deliverables Checklist

- [x] Export profiled at full scale: `services/pipeline/tools/generate_export.py` is a fixed-seed generator (`--seed 42 --rows 2000000`), confirmed byte-identical on regeneration (SHA-256 `cf318328...`); `docs/data/expense-export-profile.md` reports row count (2,000,000), column count (25), per-column inferred dtypes and null rates, memory footprint (2,244.2 MB / 11.4x expansion), and names all six seeded anomalies with column and exact row count (e.g. `gl_account_code` leading-zero/padding: 39,908 rows).
- [x] Schema declared rather than inferred: `services/pipeline/schema.py` types all 25 export columns explicitly. Verified live: identifiers (`tenant_id`, `gl_account_code`) round-trip through Parquet as `String` with leading zeros intact (`"06100"`), `amount_cents`/`spend_cents` round-trip as exact `Int64`, and `created_at` round-trips as a real `Datetime(time_unit='us', time_zone='UTC')` (cast explicitly in `tools/archive_valid_line_items.py`, not left to any reader's inference).
- [x] Lazy read proven by its query plan: `aggregate_polars()` starts from `pl.scan_ndjson(...)`, not `.lazy()` after an eager read. `explain(optimized=True)` shows `SELECTION:` and `PROJECT 5/25 COLUMNS` folded into the `NDJson SCAN` node. At full scale, Polars beats the pandas baseline on both wall-clock (14.82x) and peak RSS (11.84x). Engine justification in the profile doc covers memory, speed, and SQL ergonomics.
- [x] Aggregation lives in a tested module: `aggregate_pandas()` and `aggregate_polars()` are callables in `services/pipeline/aggregate.py`; `tests/test_aggregate.py` passes (11/11); the aggregate's output is archived as Hive-partitioned Parquet on floci (`s3://expenseflow-spend-aggregate-m9d1/spend-aggregate/`, 72 files).
- [x] Aggregate reconciles with the database: `services/pipeline/tools/equivalence_check.py` computes the spend total via DuckDB over the Parquet archive (`read_parquet`) and via DuckDB `ATTACH` over live Postgres, in one session, and asserts exact equality with no tolerance. Both sides currently match exactly: 1,512,518 rows, $1,893,541,463.08.
- [x] PR description: verification output pasted above (query plan, benchmark, equivalence check); AI-tool reflection paragraph above names one accepted and one rejected suggestion.
- [x] PR setup: branch is `m9d1-implementation`. <FIXME: self-assign this PR under Assignees, and request `<ES's GitHub handle>` under Reviewers before publishing — I don't have write access to do either from here>
