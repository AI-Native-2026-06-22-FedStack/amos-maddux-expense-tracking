# ADR-0027: Batch over Streaming for the Analytical Ingest

## Status

Accepted.

## Context

`services/pipeline` produces the spend-by-tenant/GL-code/month roll-up
(`pipeline_analytics.spend_by_tenant_gl_month`, see
`docs/data/expense-export-profile.md`'s Task 2 section) from an
`expense_line_item`/`mileage_entry` export. The roll-up is a finance
reporting artifact: it is read by the `Finance Admin` role (see
`docs/adr/0009-storage-per-bounded-context.md`'s container map) for spend
review and month-end reconciliation, not by any interactive, per-request
code path in the Core Case Service or GL-Coding Engine. Nothing in the
Expense Report stage machine, the Case Queue dashboard, or the GL-coding
decision path reads this roll-up synchronously.

**Architectural assumption — the concrete freshness requirement this
decision is built on**: spend roll-ups must reflect expense activity from
no more than **24 hours prior** at any time a Finance Admin reviews them.
This repository does not yet have a written finance-reporting SLA, so this
number is stated here explicitly as the assumption the rest of this
decision depends on, not as an already-agreed contract. It is chosen
because every real consumer of this data described so far (spend review,
month-end reconciliation) operates on a daily-or-slower human review
cadence, and the roll-up's own grain is monthly (`tenant_id`,
`gl_account_code`, `month`) — a dimension that by construction cannot
change meaning within a single day. If that assumption is wrong, this
decision needs to be revisited (see "Reconsideration Trigger" below), not
patched around.

`services/pipeline/aggregate.py`'s Polars engine (see
`docs/data/expense-export-profile.md`) processes the full 2,000,000-row
reference export — 12 tenants, 6 months, 864 grouped output rows — in 2.0
seconds wall clock and under 800 MB peak RSS. That is the actual per-run
cost this decision has to justify running repeatedly against a
requirement measured in hours, not seconds.

## Decision

Run the ExpenseFlow analytical ingest (`services/pipeline/run.py`) as a
scheduled batch job once per day, not as a continuously running stream
consumer.

A single daily run at a fixed off-peak time (e.g. 02:00 UTC, after the
prior day's expense activity has settled and before Finance Admin users
are typically active) is sufficient to satisfy the 24-hour freshness
assumption above with wide margin: the roll-up is never more than one
run-interval plus one run-duration stale, and the run itself completes in
low single-digit seconds at the full 2,000,000-row reference scale (see
Context). A once-daily cadence gives roughly a 24-hour safety margin
between the freshness requirement and the actual staleness the schedule
produces, rather than scheduling at the requirement's own boundary.

Scheduled batch is sufficient specifically because:

- The consuming workflows (spend review, month-end reconciliation) are
  human-paced and daily-or-slower by nature; there is no code path in this
  system that blocks on the roll-up being fresher than a business day.
- The roll-up's own grain is monthly. A batch cadence far shorter than the
  grain it computes (daily vs. monthly) cannot itself be the source of a
  meaningfully wrong number — the risk that matters is total staleness in
  hours, not intra-day drift within one grouping.
- The full-scale run cost (2.0 s, <800 MB peak RSS) is small enough that
  running it once daily is not a capacity-planning problem; it does not
  need to run more often to stay within any resource budget.

## Operational/Cost Tradeoff versus an Always-Running Stream Consumer

A streaming consumer (e.g. subscribing to expense/line-item change events
as they occur, maintaining a continuously updated roll-up) would require:

- A continuously running compute process with the same baseline-cost shape
  ADR-0021 accepted for the Core Case Service (a reserved, always-on task)
  rather than the scheduled batch's pay-only-for-the-run-duration shape.
- New infrastructure this repository does not have today: a change-data-
  capture or event-sourcing path out of `expense_line_item`, a stream
  processing runtime with its own state store for incremental
  aggregation, and operational ownership (monitoring, backpressure
  handling, replay-on-failure) for a long-lived process, none of which
  exist for this workload now.
- Correctness work a batch run gets for free: `aggregate.py`'s roll-up
  recomputes cleanly from the full export on every run (see
  `docs/data/expense-export-profile.md`), so there is no incremental-state
  drift to reconcile. A streaming consumer would need its own mechanism to
  detect and correct drift between its running total and a full
  recomputation — a class of bug that a from-scratch daily batch cannot
  have, because it has no persistent incremental state to drift from.

Against a 24-hour freshness requirement, an always-on stream consumer pays
continuous compute and new operational surface to deliver freshness the
business does not need, in exchange for a benefit (near-real-time roll-up
updates) that no described consumer currently uses.

## Disadvantages Accepted

- **Up to ~24 hours of staleness by design.** A Finance Admin reviewing
  spend immediately after new activity posts will not see it reflected
  until the next scheduled run. This is the explicit cost of the decision,
  not an incidental gap.
- **A missed or delayed run degrades freshness directly**, with no
  self-healing between scheduled runs. Batch has no mechanism to
  "catch up" faster than its own cadence if a run is skipped; the next
  scheduled run is the only recovery path.
- **Every run reprocesses the full export** rather than an incremental
  delta (matching `aggregate.py`'s existing recompute-from-scratch design,
  see `docs/data/expense-export-profile.md`). This is deliberate — it is
  what keeps the pipeline free of incremental-state drift (see Tradeoff
  above) — but it means run cost scales with total data volume, not with
  what changed since the last run, and will need revisiting if data
  volume grows enough that a 2-second run no longer holds.
- **No sub-daily visibility into anomalies.** A data-quality problem in a
  day's export (see `docs/runbooks/quarantine-rate.md`) is only surfaced
  when that day's scheduled run executes, not as activity streams in.

## Alternatives Considered

- **Always-on streaming consumer** (continuous change-data-capture into a
  live-updated roll-up): Rejected for the reason stated throughout this
  ADR — no described consumer requires sub-24-hour freshness, and the
  operational/cost surface of a long-lived stateful stream process is not
  justified against a requirement a daily batch already satisfies with
  margin.
- **More frequent batch (hourly)**: Rejected as unnecessary given the
  24-hour freshness assumption; it would multiply run count without
  changing what any consumer can observe, since the roll-up's own grain
  (month) cannot meaningfully change within a day regardless of how often
  the batch runs.
- **On-demand/manual trigger only, no schedule**: Rejected because it
  makes freshness depend on someone remembering to run it, which cannot
  reliably satisfy a stated freshness requirement; a schedule is required
  precision, not an operational convenience.

## Reconsideration Trigger

Revisit this decision if the business freshness requirement itself
changes to something a daily batch cannot satisfy with reasonable
margin — concretely: **if any consumer needs spend roll-up data reflecting
activity from less than roughly 1 hour prior** (for example, an
interactive dashboard that must reflect the same day's submitted expenses
within the hour, or a control that blocks an in-workflow decision on the
current roll-up rather than a day-old one). At that point, a schedule
tightened toward that same short interval starts to look and cost like a
continuously running process without offering its benefits, and moving to
a genuine streaming/event-driven update path becomes the better-justified
choice.

This is a latency-requirement trigger, not a technology-preference one:
the decision to move to streaming should be made because a stated business
requirement can no longer be met by batch, not because streaming is a
newer or more sophisticated architecture in the abstract.

## Consequences

POSITIVE: Spend roll-ups satisfy the 24-hour freshness assumption with
wide margin, using infrastructure and cost proportional to the actual
consumer need (daily human review), not to a freshness bound nothing in
the system currently requires.

POSITIVE: No new continuously running process, change-data-capture path,
or stream-processing state store is needed; the pipeline stays the
already-built extract/validate/transform/load/publish_event batch job
(see `services/pipeline/run.py`).

POSITIVE: Full recompute-from-scratch on every run (see
`docs/data/expense-export-profile.md`) means there is no incremental
aggregation state that can drift from the source data between runs.

NEGATIVE: The roll-up can be up to ~24 hours stale by design, and a missed
run extends that staleness with no automatic catch-up faster than the
next scheduled run.

NEGATIVE: Every run's cost scales with total export volume rather than
with the size of the change since the last run, which will need
revisiting if data volume grows past the point where a single daily run
comfortably fits its scheduling window.

NEGATIVE: Data-quality problems (see `docs/runbooks/quarantine-rate.md`)
are only visible once a day, at run time, not as they occur.
