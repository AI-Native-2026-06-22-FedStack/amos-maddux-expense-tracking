## Violating inserts

### 1. Out-of-set `current_stage`

Rejected by `expense_report_current_stage_check`.

```text
ERROR:  new row for relation "expense_report" violates check constraint "expense_report_current_stage_check"
```

### 2. Orphaned line item foreign key

Rejected by `expense_line_item_report_fk`.

```text
ERROR:  insert or update on table "expense_line_item" violates foreign key constraint "expense_line_item_report_fk"
DETAIL:  Key (tenant_id, expense_report_id)=(00000000-0000-0000-0000-000000000001, 99999999-9999-9999-9999-999999999999) is not present in table "expense_report".
```

### 3. Null `tenant_id`

Rejected by `tenant_id` NOT NULL constraint.

```text
ERROR:  null value in column "tenant_id" of relation "expense_report" violates not-null constraint
```

### 4. Duplicate attachment storage key within a tenant

Rejected by `attachment_metadata_storage_key_unique`.

```text
ERROR:  duplicate key value violates unique constraint "attachment_metadata_storage_key_unique"
DETAIL:  Key (tenant_id, storage_key)=(00000000-0000-4000-8000-000000000001, duplicate-test-storage-key) already exists.
```

The same synthetic `storage_key` value is allowed for a different `tenant_id`; attachment storage keys are tenant-scoped.

### 5. Deleting a report with audit history

Rejected by `audit_entry_report_fk`.

```text
ERROR:  update or delete on table "expense_report" violates foreign key constraint "audit_entry_report_fk" on table "audit_entry"
DETAIL:  Key (tenant_id, id)=(00000000-0000-4000-8000-000000000001, 10000000-0000-4000-8000-000000000001) is still referenced from table "audit_entry".
```

### 6. Deleting a report with stage transition history

Rejected by `stage_transition_report_fk`.

```text
ERROR:  update or delete on table "expense_report" violates foreign key constraint "stage_transition_report_fk" on table "stage_transition"
DETAIL:  Key (tenant_id, id)=(00000000-0000-4000-8000-000000000001, 10000000-0000-4000-8000-000000000001) is still referenced from table "stage_transition".
```

## Case Queue query plan

The Case Queue index exists:

```sql
CREATE INDEX expense_report_case_queue_idx ON public.expense_report USING btree (tenant_id, current_stage, due_date)
```

The Case Queue query was tested with:

```text
tenant_id: 00000000-0000-4000-8000-000000000001
current_stage: Drafted
```

The performance check used a synthetic workload large enough to make the index choice visible:

```sql
insert into expense_report (
    id,
    tenant_id,
    submitter_id,
    current_stage,
    priority,
    due_date
)
select
    gen_random_uuid(),
    '00000000-0000-4000-8000-000000000001'::uuid,
    'synthetic-employee-' || gs::text,
    case (gs % 6)
        when 0 then 'Drafted'
        when 1 then 'Submitted'
        when 2 then 'Manager Approval'
        when 3 then 'AP Review'
        when 4 then 'Paid'
        else 'Reconciled'
    end,
    case (gs % 4)
        when 0 then 'Low'
        when 1 then 'Normal'
        when 2 then 'High'
        else 'Urgent'
    end,
    date '2026-01-01' + (gs % 90)
from generate_series(1, 5000) as gs;

insert into expense_report (
    id,
    tenant_id,
    submitter_id,
    current_stage,
    priority,
    due_date
)
select
    gen_random_uuid(),
    '00000000-0000-4000-8000-000000000002'::uuid,
    'synthetic-employee-noise-' || gs::text,
    'Drafted',
    'Normal',
    date '2026-01-01' + (gs % 90)
from generate_series(1, 1000) as gs;

analyze expense_report;
```

The checked query was:

```sql
explain (analyze, buffers)
select *
from expense_report
where tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
  and current_stage = 'Drafted'
order by due_date
limit 50;
```

Before adding the Case Queue index, PostgreSQL used a sequential scan and sorted the matching rows:

```text
Limit  (cost=242.73..242.85 rows=50 width=251) (actual time=0.458..0.463 rows=50 loops=1)
  Buffers: shared hit=102
  ->  Sort  (cost=242.73..246.54 rows=1527 width=251) (actual time=0.457..0.459 rows=50 loops=1)
        Sort Key: due_date
        Sort Method: top-N heapsort  Memory: 35kB
        Buffers: shared hit=102
        ->  Seq Scan on expense_report  (cost=0.00..192.00 rows=1527 width=251) (actual time=0.007..0.375 rows=833 loops=1)
              Filter: ((tenant_id = '00000000-0000-4000-8000-000000000001'::uuid) AND (current_stage = 'Drafted'::text))
              Rows Removed by Filter: 5167
              Buffers: shared hit=102
Planning:
  Buffers: shared hit=95 read=1
Planning Time: 0.458 ms
Execution Time: 0.494 ms
```

After adding the index and seeding the synthetic workload, PostgreSQL used the Case Queue index:

```text
Limit  (cost=0.28..8.05 rows=50 width=251) (actual time=0.033..0.071 rows=50 loops=1)
  Buffers: shared hit=50 read=2
  ->  Index Scan using expense_report_case_queue_idx on expense_report  (cost=0.28..237.64 rows=1527 width=251) (actual time=0.032..0.066 rows=50 loops=1)
        Index Cond: ((tenant_id = '00000000-0000-4000-8000-000000000001'::uuid) AND (current_stage = 'Drafted'::text))
        Buffers: shared hit=50 read=2
Planning:
  Buffers: shared hit=65 read=1
Planning Time: 0.962 ms
Execution Time: 0.105 ms
```

Conclusion: PostgreSQL changed from a `Seq Scan` plus sort to an `Index Scan` using `expense_report_case_queue_idx`.

Proof line:

```text
Index Scan using expense_report_case_queue_idx on expense_report
```

The `Index Cond` line shows the query matched the leading index columns, `tenant_id` and `current_stage`:

```text
Index Cond: ((tenant_id = '00000000-0000-4000-8000-000000000001'::uuid) AND (current_stage = 'Drafted'::text))
```
