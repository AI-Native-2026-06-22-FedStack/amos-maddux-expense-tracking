
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


