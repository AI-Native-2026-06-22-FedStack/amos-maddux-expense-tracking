
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

### 4. Duplicate uniqueness violation

Rejected by `attachment_metadata_storage_key_unique`.

```text
ERROR:  duplicate key value violates unique constraint "attachment_metadata_storage_key_unique"
DETAIL:  Key (storage_key)=(duplicate-test-storage-key) already exists.
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

Before adding the Case Queue index, the query plan used a sequential scan. After adding the index, PostgreSQL used the Case Queue index:

```text
Index Scan using expense_report_case_queue_idx on expense_report  (cost=0.14..8.16 rows=1 width=309) (actual time=0.014..0.014 rows=1 loops=1)
  Index Cond: ((tenant_id = '00000000-0000-4000-8000-000000000001'::uuid) AND (current_stage = 'Drafted'::text))
  Buffers: shared hit=2
Planning:
  Buffers: shared hit=155
Planning Time: 0.264 ms
Execution Time: 0.037 ms
```

Conclusion: PostgreSQL used an `Index Scan`, not a sequential scan.

Proof line:

```text
Index Scan using expense_report_case_queue_idx on expense_report
```

The `Index Cond` line shows the query matched the leading index columns, `tenant_id` and `current_stage`:

```text
Index Cond: ((tenant_id = '00000000-0000-4000-8000-000000000001'::uuid) AND (current_stage = 'Drafted'::text))
```
