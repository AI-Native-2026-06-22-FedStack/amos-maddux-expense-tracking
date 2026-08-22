# Expense export — profile

## Generator spec

- **Source shapes represented**: `expense_line_item` (with `receipt_*` fields
  folded onto line-item rows) and `mileage_entry`, per
  `services/pipeline/tools/generate_export.py`. Field names and GL codes are
  taken from `apps/api/src/db/schema.ts` and
  `services/compute/db/seeds/0001_default_gl_mappings.sql`, not invented.
- **Row count**: 2,000,000 (file: `expense_export_seed42_rows2000000.jsonl.gz`).
- **Seed**: `42` (fixed; `--seed 42 --rows 2000000`, all other args at their
  documented defaults).
- **Tenant spread**: 12 distinct tenants (`--tenants` default), each with its
  own GL account-name suffix.
- **Date/month spread**: 6 distinct calendar months (`--months` default),
  `2025-08` through `2026-01` inclusive, anchored at the generator's fixed
  `ANCHOR_DATE = 2026-01-01`.
- **Output format**: gzip-compressed, newline-delimited JSON (JSONL), one
  record per line, fixed column order, `mtime=0` in the gzip header for
  byte-for-byte reproducibility.
- **Intentional defect types** (each independently seeded at the `--defect-rate`
  default of 2% per check): lowercase currency code; `gl_account_code`
  leading-zero or whitespace padding; non-positive (`0` or negative)
  `amount_cents`; `receipt_date` null despite a populated `receipt_number`;
  `trip_date` written in `MM/DD/YYYY` instead of ISO; `record_id` duplicated
  from the immediately preceding row.
- **SHA-256 reproducibility result**: regenerating with the same
  `--rows 2000000 --seed 42` produced a file whose SHA-256
  (`cf3183286031421cb16aa0d849e42db705a0eae3309a61bc8acb29ca5db55876`) is
  byte-identical to the committed export. Confirmed independently at
  `--rows 1000 --seed 42` as well
  (`0250a1e12a7db4d2126bb549259c26f49cc4fa2afb84770df3f68e64028e74a9`).

## Shape at full scale

- **Total row count**: 2,000,000
- **Column count**: 25
- **Eager in-memory footprint** (plain `pandas.read_json(lines=True)`,
  pandas 3.0.5): 2,244.2 MB (2.19 GB) deep memory usage, an 11.4x expansion
  over the 197.1 MB compressed file on disk.

| Column                  | Inferred dtype (plain read) | Null count | Null rate |
| ----------------------- | --------------------------- | ---------- | --------- |
| `record_type`           | str                         | 0          | 0.0%      |
| `tenant_id`             | str                         | 0          | 0.0%      |
| `expense_report_id`     | str                         | 0          | 0.0%      |
| `record_id`             | str                         | 0          | 0.0%      |
| `submitter_id`          | str                         | 0          | 0.0%      |
| `current_stage`         | str                         | 0          | 0.0%      |
| `merchant`              | str                         | 400,320    | 20.0%     |
| `category`              | str                         | 0          | 0.0%      |
| `amount_cents`          | float64                     | 400,320    | 20.0%     |
| `currency`              | str                         | 400,320    | 20.0%     |
| `miles`                 | float64                     | 1,599,680  | 80.0%     |
| `trip_date`             | str                         | 1,599,680  | 80.0%     |
| `origin`                | str                         | 1,599,680  | 80.0%     |
| `destination`           | str                         | 1,599,680  | 80.0%     |
| `business_purpose`      | str                         | 1,599,680  | 80.0%     |
| `gl_account_code`       | int64                       | 0          | 0.0%      |
| `gl_account_name`       | str                         | 0          | 0.0%      |
| `gl_normal_balance`     | str                         | 0          | 0.0%      |
| `gl_coding_status`      | str                         | 0          | 0.0%      |
| `receipt_number`        | str                         | 400,320    | 20.0%     |
| `receipt_date`          | str                         | 432,063    | 21.6%     |
| `flagged`               | bool                        | 0          | 0.0%      |
| `deductible`            | bool                        | 0          | 0.0%      |
| `manager_review_status` | str                         | 0          | 0.0%      |
| `created_at`            | datetime64[us, UTC]         | 0          | 0.0%      |

All null columns above are structural: `merchant`/`amount_cents`/`currency`/
`receipt_number` are null on every `mileage` row (400,320 of 2,000,000 rows);
`miles`/`trip_date`/`origin`/`destination`/`business_purpose` are null on
every `line_item` row (1,599,680 of 2,000,000 rows). `receipt_date`'s null
count (432,063) exceeds the mileage-row count because it also includes the
seeded "receipt present but no date" defect on `line_item` rows (see below).

## Data observations and anomalies

| Anomaly                                                                      | Affected column   | Exact row count |
| ---------------------------------------------------------------------------- | ----------------- | --------------- |
| Lowercase currency code (e.g. `"usd"` instead of `"USD"`)                    | `currency`        | 31,942          |
| `gl_account_code` leading zero (`"06100"`) or whitespace padding (`"6400 "`) | `gl_account_code` | 39,908          |
| Non-positive `amount_cents` (`0` or negative)                                | `amount_cents`    | 32,097          |
| `trip_date` in `MM/DD/YYYY` instead of ISO `YYYY-MM-DD`                      | `trip_date`       | 8,079           |
| `receipt_number` populated but `receipt_date` null, on `line_item` rows      | `receipt_date`    | 31,743          |
| `record_id` duplicated from the immediately preceding row                    | `record_id`       | 39,920          |

All six counts land within a few tenths of a percent of the generator's
documented 2%-per-check `--defect-rate` default, confirming these are the
seeded defects and not incidental data.

**Raw-vs-inferred mismatch (most significant finding)**: `gl_account_code`
is written as text in the export
(e.g. `"6100"`, `"06100"`, `"6400 "`) and the source table stores it as
`text` (`apps/api/src/db/schema.ts:207`, and the generator's own comment:
"kept as str; never cast to int"). Under plain `pandas.read_json`, this
column is inferred as `int64` — every leading zero is silently dropped
(`"06100"` → `6100`) and every whitespace-padding variant is coerced away,
destroying the exact seeded defect signal before it can even be measured.
This was confirmed directly against both the 1,000-row and 2,000,000-row
export files on this environment's pandas (3.0.5).

Two further mismatches were confirmed the same way:

- `amount_cents` is a bare JSON integer in the file but is inferred as
  `float64` because nulls (present on every mileage row) block pandas from
  using `int64`. The integer-minor-units contract is broken by inference,
  not by the data.
- `miles` is written as a quoted 2-decimal string (matching the source
  table's `numeric(10,2)` type) but is inferred as `float64`, which risks
  binary-float rounding drift on aggregation that the source's fixed-point
  representation was chosen to avoid.

No numeric misinference was observed on `tenant_id`, `expense_report_id`,
`record_id`, or `receipt_number`: UUID hyphens and the `RCT-` prefix
happen to block numeric inference on those columns, but this is
incidental to their content, not a guarantee.

## Declared schema

Declared in `services/pipeline/schema.py`, applied explicitly per column —
no column is left to inference.

| Column                  | Declared type     | Reason                                                                                                                          |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `record_type`           | string            | Two-value discriminator                                                                                                         |
| `tenant_id`             | string            | Identifier                                                                                                                      |
| `expense_report_id`     | string            | Identifier                                                                                                                      |
| `record_id`             | string            | Identifier                                                                                                                      |
| `submitter_id`          | string            | Identifier                                                                                                                      |
| `current_stage`         | string            | Categorical text                                                                                                                |
| `merchant`              | string (nullable) | Structurally null on mileage rows                                                                                               |
| `category`              | string            | Categorical text                                                                                                                |
| `amount_cents`          | int64 (nullable)  | Money must stay integer minor units; plain inference upcasts to float64                                                         |
| `currency`              | string (nullable) | Structurally null on mileage rows                                                                                               |
| `miles`                 | string (nullable) | Source is `numeric(10,2)`; kept as exact text to avoid float rounding drift until an explicit decimal cast is chosen downstream |
| `trip_date`             | date              | Must become a real date type; two formats (ISO and seeded `MM/DD/YYYY`) are parsed explicitly, not guessed                      |
| `origin`                | string (nullable) | Structurally null on line-item rows                                                                                             |
| `destination`           | string (nullable) | Structurally null on line-item rows                                                                                             |
| `business_purpose`      | string (nullable) | Structurally null on line-item rows                                                                                             |
| `gl_account_code`       | string            | GL code, including leading zeros; plain inference silently destroys this                                                        |
| `gl_account_name`       | string            | Descriptive text                                                                                                                |
| `gl_normal_balance`     | string            | Categorical text (`debit`/`credit` per source check constraint)                                                                 |
| `gl_coding_status`      | string            | Categorical text                                                                                                                |
| `receipt_number`        | string (nullable) | Identifier; structurally null on mileage rows                                                                                   |
| `receipt_date`          | date (nullable)   | Must become a real date type; ISO format only                                                                                   |
| `flagged`               | bool              | Unambiguous boolean                                                                                                             |
| `deductible`            | bool              | Unambiguous boolean                                                                                                             |
| `manager_review_status` | string            | Categorical text                                                                                                                |
| `created_at`            | datetime (UTC)    | Must become a real datetime type; format declared explicitly rather than relying on pandas-version-dependent auto-parsing       |

Every identifier column (`tenant_id`, `expense_report_id`, `record_id`,
`submitter_id`, `receipt_number`) is declared as a string. Every GL code
column is a string, leading zeros included. Every money column
(`amount_cents`) is declared as integer minor units — no monetary float
type appears anywhere in this schema. Every date/timestamp column
(`trip_date`, `receipt_date`, `created_at`) is declared as a real
date/datetime type, not generic text. Downstream readers must apply this
declared schema instead of relying on `pandas`/`polars` type inference,
which this profile shows is not safe on this data.

## Spend aggregate (Task 2)

`services/pipeline/aggregate.py` computes spend per tenant, GL code, and
month over `expense_line_item` rows only (mileage rows carry no
`amount_cents` and are excluded), plus the share of line items that trip
the GL-Coding Engine's $500 flag rule
(`services/compute/app/coding.py`: `flagged = line_item.amount >
FLAG_THRESHOLD`, `FLAG_THRESHOLD = Decimal("500.00")` — strictly greater
than, evaluated per line item, equivalent to `amount_cents > 50_000`).
Both engines read via the Task 1 declared schema; no column is left to
either engine's own type inference.

At full scale (2,000,000-row export):

| Metric                                | Value                                     |
| ------------------------------------- | ----------------------------------------- |
| Grouped (tenant, GL code, month) rows | 864                                       |
| Total spend                           | $1,942,523,897.03 (194,252,389,703 cents) |
| Line items evaluated                  | 1,599,680                                 |
| Line items flagged (> $500.00)        | 1,256,894                                 |
| Flagged share                         | 78.6%                                     |

These figures were cross-checked three ways: the eager pandas baseline, the
lazy Polars pipeline, and an independent raw-JSON scan of the file with no
dataframe engine involved at all. All three agree exactly.

### Baseline vs. lazy pipeline, measured at full scale

Both engines ran in isolated subprocesses so each one's OS-level peak
resident-set size (`resource.getrusage(RUSAGE_SELF).ru_maxrss`) could be
attributed cleanly, rather than measuring Python-heap allocations only
(which would understate both engines' real footprint — most of their memory
lives in native pandas/numpy or Polars/Arrow buffers, not the Python heap).

| Engine                                                        | Wall clock | Peak RSS |
| ------------------------------------------------------------- | ---------- | -------- |
| pandas (eager: read whole file, then filter/group/aggregate)  | 29.4 s     | 8,908 MB |
| polars (lazy: `scan_ndjson` → filter → select → `.collect()`) | 2.0 s      | 762 MB   |

Polars was **~14.7x faster** and used **~11.7x less peak memory** on this
2,000,000-row file (two full runs measured: 14.41–14.80x time, 11.53–11.69x
memory; both intervals reported rather than a single run, since the exact
figures vary slightly between runs).

### Confirming the optimizer is actually pushing down

Printing `LazyFrame.explain(optimized=False)` next to
`explain(optimized=True)` on the same lazy pipeline shows the difference
directly:

```text
=== UNOPTIMIZED PLAN (naive, before optimizer) ===
SELECT [col("tenant_id"), col("gl_account_code"), col("amount_cents"), col("created_at")]
  FILTER col("record_type") == "line_item"
  FROM
    NDJson SCAN [.../expense_export_seed42_rows2000000.jsonl.gz]
    PROJECT */25 COLUMNS

=== OPTIMIZED PLAN (predicate + projection pushed into scan) ===
simple π 4/4 ["tenant_id", "gl_account_code", ... 2 other columns]
  NDJson SCAN [.../expense_export_seed42_rows2000000.jsonl.gz]
  PROJECT 5/25 COLUMNS
  SELECTION: col("record_type") == "line_item"
```

In the optimized plan, `SELECTION:` and `PROJECT 5/25 COLUMNS` are
attributes of the `NDJson SCAN` node itself — the filter and column
selection happen _during_ the scan, not as separate steps discarding rows
and columns afterward. The unoptimized plan shows the naive shape for
comparison: a full `PROJECT */25 COLUMNS` scan feeding separate `FILTER`
and `SELECT` steps.

This distinction is why the pipeline starts from `pl.scan_ndjson(...)`, not
`pl.read_ndjson(...).lazy()`. The latter was checked directly: it produces
a plan rooted at `DF [...]` (an already-fully-materialized in-memory frame)
with `FILTER` sitting on top and no `SELECTION:`/reduced `PROJECT` on any
scan node at all, because there is no scan left to push into by the time
the lazy API sees it — confirming the task's warning that this pattern
looks interchangeable with `scan_ndjson` but defeats pushdown entirely.

### Engine justification

**Polars, for this workload, at this data size.** All three axes point the
same direction:

- **Memory**: pandas' eager read held 8.9 GB of peak RSS for a 197 MB
  compressed / ~2.2 GB decompressed-in-memory file — a footprint that would
  not comfortably fit alongside other work on a modest worker instance and
  that only grows linearly as more months/tenants of history accumulate.
  Polars' lazy scan held under 800 MB for the same file, because pushdown
  means the full 25-column, 2,000,000-row file is never materialized in
  memory at all — only the 4 needed columns, on the ~1.6M rows that survive
  the `record_type == "line_item"` filter, ever exist as a Polars frame.
- **Speed**: ~15x faster wall clock on this file. The gap is structural, not
  incidental: pandas reads and holds the entire file before doing anything
  else, while Polars' scan applies the filter and projection while reading.
  This gap will not shrink as the export grows — it should widen, since
  pandas' cost scales with total file size while Polars' scan cost scales
  with what the query actually needs.
- **SQL ergonomics**: Polars' lazy `.filter()` / `.select()` / `.group_by()`
  / `.agg()` chain reads like a query plan and _is_ one — `.explain()`
  exposes exactly what will run before it runs, which is what let this
  profile prove pushdown instead of asserting it. pandas' eager
  `groupby().agg()` is equally readable for a single aggregate like this
  one, but offers no equivalent plan-inspection story, and nothing stops a
  future edit from accidentally re-introducing a full-file read upstream of
  a filter.

pandas remains the right choice for small, already-in-memory, exploratory
work (it is what `notebooks/expense-export-eda.ipynb` correctly uses, since
that notebook's entire point is to observe naive eager inference). For a
production aggregate over an export at this scale — and one expected to
grow — Polars' lazy pipeline is the one to run.

### Parquet archive on floci

The aggregate output was written as Hive-partitioned Parquet
(`tenant_id=<uuid>/month=<YYYY-MM>/*.parquet`, 72 files: 12 tenants × 6
months) and uploaded to `s3://expenseflow-spend-aggregate-m9d1/spend-aggregate/`
on floci. Partitioning by `tenant_id` first matches this codebase's
existing tenant-isolation pattern (every other query in this system scopes
to one tenant first); partitioning by `month` second supports the other
common finance query shape (a tenant's spend over a date range) without
requiring a scan of that tenant's full history.

A round-trip read directly from floci S3 (`pl.scan_parquet("s3://...",
hive_partitioning=True, ...).collect()`) reproduced the aggregate exactly:
864 rows, $1,942,523,897.03 total spend, 1,599,680 line items, 12 distinct
tenants — matching the in-memory result and the independent raw-JSON scan.
`tenant_id` and `gl_account_code` round-tripped as `String`
(leading-zero GL codes such as `"06100"` intact), and `spend_cents`
round-tripped as exact `Int64`, not a float.

This grouped archive has no date/datetime column (`month` is a `YYYY-MM`
string), so the date-round-trip half of the schema's claims is checked
against the second, row-level archive instead (`s3://expenseflow-valid-line-items-m9d1/valid-line-items/`,
see the equivalence-check section below): its `created_at` column is
written to Parquet as an explicit `TIMESTAMPTZ` cast
(`services/pipeline/tools/archive_valid_line_items.py`) and round-trips
as a real `Datetime(time_unit='us', time_zone='UTC')` in Polars, not a
string — confirmed by reading it back from floci S3 directly. Between the
two archives, all three of the schema's type guarantees (identifiers as
strings with leading zeros intact, money as exact integer cents, dates as
a real datetime type) are demonstrated surviving an actual Parquet
write/upload/read round trip, not merely declared.

### Testing

`services/pipeline/tests/test_aggregate.py` exercises both
`aggregate_pandas()` and `aggregate_polars()` against a small, hand-authored
6-row fixture (`tests/fixtures/tiny_export.jsonl.gz`) covering: a flagged
line item, an item at exactly the $500.00 threshold (must not flag, per the
source rule's strict `>`), a leading-zero GL code that must survive as a
distinct string key, two tenants, two months, and one mileage row that must
be excluded from both spend and the flag denominator. 11 tests, all passing.

## DuckDB equivalence check: Parquet vs. Postgres

`services/pipeline/tools/equivalence_check.py` proves the spend total
computed over the Parquet archive matches the spend total in live
Postgres, using one DuckDB session for both: `read_parquet(...,
hive_partitioning=true)` directly over the archive on floci S3 (no
intermediate load step), and `ATTACH ... (TYPE postgres)` querying
`expense_line_item` directly. The comparison is an exact integer-cents
equality assertion — no tolerance — and the script exits non-zero and
prints the reason if the totals differ by even one cent.

**Result:**

| Source                                                                           | Rows      | Total spend       |
| -------------------------------------------------------------------------------- | --------- | ----------------- |
| Parquet (`s3://expenseflow-valid-line-items-m9d1/valid-line-items/`, via DuckDB) | 1,512,518 | $1,893,541,463.08 |
| Postgres (`expense_line_item`, via DuckDB `ATTACH`)                              | 1,512,518 | $1,893,541,463.08 |

Exact match, confirmed a third way by an independent Python scan of the
raw export with no SQL engine involved at all (same row count, same
sum-in-cents). The check was also verified to actually fail: a deliberate
1-cent `UPDATE` against a single Postgres row was caught immediately
(`SPEND TOTAL MISMATCH: ... difference: -1 cents`) and reverted — this
confirms the assertion is live, not trivially passing.

### The real finding: what "the same data" actually means here

The row count above (1,512,518) is smaller than the full line-item count
in the export (1,599,680) and smaller than the Task 2 aggregate's scope
(which sums every line item, defects included). This is not a bug in the
equivalence check — it is the direct, structural consequence of
`expense_line_item`'s own constraints, discovered while building the
Postgres side of this comparison:

- **`expense_line_item_amount_cents_check` (`amount_cents > 0`) and
  `expense_line_item_currency_check` (`currency ~ '^[A-Z]{3}$'`)**
  (`apps/api/src/db/schema.ts`) reject the export's seeded non-positive-amount
  and lowercase-currency defect rows outright — 63,408 rows (31,466 amount-only
  - 31,311 currency-only + 631 both) cannot be inserted into a real
    `expense_line_item` table as-is.
- **The primary key on `expense_line_item.id`** rejects the export's seeded
  duplicate-`record_id` defect (a small fraction of rows reuse the
  immediately preceding row's id): once the first occurrence of a
  `record_id` is inserted, every later row with that same id collides with
  the primary key. A further 23,754 rows are excluded for this reason.

Attempting to load the full, unfiltered export into Postgres fails
immediately with a real constraint violation
(`duplicate key value violates unique constraint "expense_line_item_pkey"`
was the first error hit). The fix was not to relax the schema or to widen
a tolerance on the comparison — it was to make both sides of the
equivalence check agree on the same row-selection rule up front
(`services/pipeline/valid_line_items.py`, shared by the Postgres loader and
the row-level Parquet archive writer) before comparing anything. With that
shared filter in place on both sides, the totals matched exactly on the
first real run.

This is also why the equivalence check reads from a _second_,
row-level Parquet archive (`s3://expenseflow-valid-line-items-m9d1/valid-line-items/`,
partitioned by `tenant_id`) rather than the pre-grouped spend-by-tenant-GL-month
archive from the prior section: the grouped archive's total is deliberately
computed over _every_ line item (defects included, matching the finance
question as originally asked), so comparing it directly to Postgres would
fail for a row-scope reason, not a data-correctness one. The two archives
answer two different, both-legitimate questions — "total spend across
everything the export contains" vs. "does our SQL-shaped read of the
archive agree with the system of record for the rows both can actually
hold" — and conflating them would have produced a mismatch that looked
like a bug but wasn't.

### A second finding: DuckDB's postgres extension's `TRUNCATE` is not O(1) at scale

While building the pytest integration test for this check
(`services/pipeline/tests/test_equivalence_check.py`), a test fixture that
truncated `expense_line_item`/`expense_report` through a DuckDB
`ATTACH ... (TYPE postgres)` connection hung repeatedly. It first looked
like a `CASCADE`-specific issue (a small, empty-table test passed quickly),
but timing it directly against the fully-loaded, 1,512,518-row tables
isolated the real cause: `TRUNCATE pg.public.expense_line_item;` through
DuckDB's postgres extension took **27.4 seconds** at that row count, and
the following `TRUNCATE pg.public.expense_report;` had not finished after
a further 60+ seconds. The same statements issued directly against
Postgres via `psql` — bypassing DuckDB entirely — completed in ~0.1s
regardless of row count, which is the expected behavior for `TRUNCATE`
(a metadata-only operation in real Postgres, not proportional to table
size). DuckDB's postgres extension does not appear to pass `TRUNCATE`
straight through as that same metadata-only operation.

This is a tooling quirk to route around, not a data defect, so the fix was
to stop using DuckDB for truncation: the test fixture now shells out to
`psql` directly for cleanup, which is instant at any scale. DuckDB itself
is still doing the real analytical work in this task (the `SELECT
count(*), sum(amount_cents)` in `tools/equivalence_check.py`), which was
never slow — only `TRUNCATE` through the postgres extension was.
