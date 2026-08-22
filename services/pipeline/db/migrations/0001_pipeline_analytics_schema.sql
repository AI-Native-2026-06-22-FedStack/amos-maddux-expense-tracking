-- Analytics schema owned by services/pipeline, dedicated to pipeline output
-- only. Per ADR-0006 (service boundaries and anti-shared-DB rule), the
-- pipeline must never read or write apps/api's or services/compute's
-- operational tables (expense_report, expense_line_item, gl_code, etc.) --
-- this schema exists so pipeline output has its own owned home instead of
-- being added as columns on those operational tables.
create schema if not exists pipeline_analytics;

-- Spend-by-tenant/GL-code/month roll-up produced by
-- services/pipeline/aggregate.py's aggregate_polars()/aggregate_pandas().
-- One row per (tenant_id, gl_account_code, month) group, matching that
-- module's SpendAggregate.spend_by_tenant_gl_month shape exactly:
-- tenant_id, gl_account_code, month (string, "YYYY-MM" grain, not a real
-- date -- see aggregate.py), spend_cents, line_item_count.
--
-- run_id and loaded_at record provenance (which pipeline run produced this
-- row and when), not part of the aggregate's own grouping key. The pipeline
-- load stage rebuilds this table in full on every run (see
-- services/pipeline/postgres_sink.py) rather than upserting incrementally,
-- since aggregate_polars() always recomputes the entire grouped table from
-- the full export -- the primary key below exists to keep one run's own
-- output free of duplicate groups, not to support cross-run upserts.
create table if not exists pipeline_analytics.spend_by_tenant_gl_month (
    tenant_id text not null,
    gl_account_code text not null,
    month text not null,
    spend_cents bigint not null,
    line_item_count bigint not null,
    run_id text not null,
    loaded_at timestamptz not null default now(),
    constraint spend_by_tenant_gl_month_pkey primary key (tenant_id, gl_account_code, month),
    constraint spend_by_tenant_gl_month_line_item_count_check check (line_item_count >= 0)
);

create index if not exists spend_by_tenant_gl_month_run_id_idx
    on pipeline_analytics.spend_by_tenant_gl_month (run_id);
