# 0004 — Case Queue Index Plan Check

- **_Asked:_** Verify that PostgreSQL uses the Case Queue index for Expense Reports filtered by `tenant_id` and `current_stage`, ordered by `due_date`.

- **_Produced:_** We used `EXPLAIN (ANALYZE, BUFFERS)` to inspect the data access path. Before the Case Queue index was added, the plan used a sequential scan. After adding `expense_report_case_queue_idx`, PostgreSQL used an index scan.

- **_Proof:_**

  ```text
  Index Scan using expense_report_case_queue_idx on expense_report  (cost=0.14..8.16 rows=1 width=309) (actual time=0.014..0.014 rows=1 loops=1)
    Index Cond: ((tenant_id = '00000000-0000-4000-8000-000000000001'::uuid) AND (current_stage = 'Drafted'::text))
    Buffers: shared hit=2
  Planning:
    Buffers: shared hit=155
  Planning Time: 0.264 ms
  Execution Time: 0.037 ms
  ```

- **_Why:_** The `Index Scan using expense_report_case_queue_idx` line proves PostgreSQL used the Case Queue index, and the `Index Cond` line shows the query matched the leading index columns.
