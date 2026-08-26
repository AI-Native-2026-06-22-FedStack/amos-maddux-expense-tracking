# ExpenseFlow Pipeline Quarantine-Rate Runbook

Use this runbook when a `services/pipeline` ingest run fails with
`QuarantineRateExceededError` (see `services/pipeline/quarantine_rate.py`),
or when the `QuarantineRate` CloudWatch metric under the
`ExpenseFlow/Pipeline` namespace crosses an alarm threshold.

The pipeline enforces this threshold itself: a run whose quarantine rate
(`rejected_rows / total_input_rows` for that run, computed in
`services/pipeline/quarantine_rate.py`) exceeds the value configured in
`services/pipeline/pipeline.toml`'s `[quarantine].max_rate` fails outright
with a non-zero process exit, before the analytics load or the
dataset-refreshed event ever runs. A CloudWatch alarm on the emitted
metric is a downstream visibility signal, not the enforcement path — by
the time an alarm fires, the run that produced the bad rate has already
failed.

## 1. Read the Failure Output First

The failure message already states everything needed to start:

```text
quarantine rate 0.1200 (12.00%) for run 'a1b2c3d4-...' exceeds the
configured threshold 0.0500 (5.00%). See docs/runbooks/quarantine-rate.md
for how to investigate and respond to this failure.
```

Note the **observed rate**, the **configured threshold**, and the
**run_id** — you need all three for the next steps.

## 2. Confirm This Is a Real Data Problem, Not a Pipeline Regression

Before assuming the upstream export is bad, rule out a pipeline-side
regression that would inflate the rate independent of the data:

- Check whether `services/pipeline/quality.py` or `models.py` (the
  incoming-boundary `ExpenseRow` model) changed recently in a way that
  makes a previously-passing row now fail — a stricter check landing at
  the same time as a rate spike is a strong signal the check, not the
  data, is the problem.
- Re-run the same input file locally against the previous commit's
  `services/pipeline` code (`git stash` / `git checkout` the prior
  revision) and compare the rate. If the old code produces a normal
  rate on the same file, this is check #2's decision point (fix the
  code), not #3's (fix the data).

## 3. Inspect the Quarantined Rows for This Run

Every quarantined row for the failing run is in the pipeline's
quarantine bucket on floci S3
(`services/pipeline/quarantine.py`/`config.py`'s
`PIPELINE_QUARANTINE_BUCKET`/`PIPELINE_QUARANTINE_PREFIX`), keyed by
`{prefix}/{run_id}/{record_id}/{check}.json`:

```bash
RUN_ID="a1b2c3d4-..."   # from the failure message

aws --endpoint-url "${AWS_ENDPOINT_URL:-http://localhost:4566}" s3 \
  ls "s3://${PIPELINE_QUARANTINE_BUCKET:-expenseflow-pipeline-quarantine}/quarantine/${RUN_ID}/" \
  --recursive
```

Pull a handful of objects and look at the `check` and `reason` fields
(the redacted `row` field is safe to inspect — receipt/payment fields are
already censored, never the original value):

```bash
aws --endpoint-url "${AWS_ENDPOINT_URL:-http://localhost:4566}" s3 cp \
  "s3://${PIPELINE_QUARANTINE_BUCKET:-expenseflow-pipeline-quarantine}/quarantine/${RUN_ID}/<record_id>/<check>.json" -
```

Tally which `check` values dominate the failures for this run. A single
check accounting for most of the rejections points at one upstream data
problem (e.g. a vendor export change breaking GL-code formatting), while
a spread across several checks is more consistent with a broader
upstream data-quality regression.

## 4. Decide: Data Fix, Threshold Adjustment, or Escalation

- **Upstream data problem (most common)**: the source system or vendor
  export producing malformed rows needs a fix. Escalate to the data
  owner with the tally from step 3 and a few example `reason` strings.
  Do not raise `max_rate` in `pipeline.toml` to work around a real data
  regression — that only hides the problem from this gate.
- **Pipeline check regression (from step 2)**: fix or revert the
  check/model change, add a regression test that would have caught it
  (see `services/pipeline/tests/test_quality.py`,
  `tests/test_models.py`), and re-run.
- **Threshold genuinely needs to change** (e.g. a known, accepted
  seasonal spike in a specific documented defect rate): this is a
  deliberate policy decision, not an incident response — change
  `services/pipeline/pipeline.toml`'s `[quarantine].max_rate` through
  the normal PR review process, with the reasoning recorded in the PR
  description, not as a quick unblock.

## 5. Replay the Quarantined Rows After a Fix

There are two ways to re-run, depending on what was wrong.

**If the whole export needs regenerating from the corrected upstream
source** (the common case for a real vendor/data-owner fix), just re-run
the full corrected file under a new run_id:

```bash
cd services/pipeline
uv run python run.py <corrected_export_path> --run-id "${RUN_ID}-retry"
```

**If only the specific quarantined rows need replaying** (e.g. you hand-
corrected a handful of rows, or you want to confirm a fix against exactly
the rows that failed before touching the rest of the file), quarantine
records are built for this: every object's `"row"` field holds the full
row exactly as it entered `validate()` (already redacted — see
`services/pipeline/quarantine.py`'s own docstring on replayability), so no
special replay tooling is needed beyond reassembling those rows into the
gzip/JSONL shape `extract.py` already reads.

Pull every quarantined row's `"row"` field for the run, apply your
correction to the fields that were wrong, and write them back out as a
gzip/JSONL file:

```bash
RUN_ID="a1b2c3d4-..."
BUCKET="${PIPELINE_QUARANTINE_BUCKET:-expenseflow-pipeline-quarantine}"

aws --endpoint-url "${AWS_ENDPOINT_URL:-http://localhost:4566}" s3 \
  ls "s3://${BUCKET}/quarantine/${RUN_ID}/" --recursive \
  | awk '{print $4}' \
  | while read -r key; do
      aws --endpoint-url "${AWS_ENDPOINT_URL:-http://localhost:4566}" s3 cp \
        "s3://${BUCKET}/${key}" - \
        | python3 -c "import sys, json; print(json.dumps(json.load(sys.stdin)['row']))"
    done \
  | sort -u \
  | gzip > "${RUN_ID}-replay.jsonl.gz"
```

Edit the extracted rows to fix whatever the `reason` field said was wrong
(a malformed GL code, a bad amount, etc. — see step 3), then replay just
that corrected subset:

```bash
uv run python run.py "${RUN_ID}-replay.jsonl.gz" --run-id "${RUN_ID}-replay"
```

Either way, the retry succeeds when its own quarantine rate is at or
below `pipeline.toml`'s configured threshold — the pipeline recomputes
and re-enforces the rate on every run, so a successful retry is the
actual confirmation, not just the absence of an immediate error.

## 6. Verify Recovery

- The retry/replay run's log output shows no `QuarantineRateExceededError`
  and prints `quarantine_rate=0.0000` (or a value at/below the
  threshold) at the end.
- None of the record_ids that were quarantined for `RUN_ID` appear in the
  replay run's own quarantine objects: confirm the replay's prefix has no
  matching entries for the same reason/check that failed before —
  `s3 ls "s3://${BUCKET}/quarantine/${RUN_ID}-replay/" --recursive`
  should either be empty or list only genuinely new, unrelated failures.
- The `QuarantineRate` CloudWatch metric (`ExpenseFlow/Pipeline`
  namespace, `run_id` dimension) for the retry/replay run's `run_id` is
  at or below the configured threshold.
- If a row-level replay was used, confirm the replayed rows' corrected
  values now appear in the analytics output
  (`pipeline_analytics.spend_by_tenant_gl_month`, filtered by the
  replay's `run_id`) rather than only trusting the absence of an error.
- If this was an upstream data problem, confirm with the data owner that
  the fix is durable (not just that this one file happened to be
  corrected) before considering the incident closed.
