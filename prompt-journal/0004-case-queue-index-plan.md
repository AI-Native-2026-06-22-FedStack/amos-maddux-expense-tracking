# 0004 — Case Queue Index Plan Check

- **_Asked:_** Verify that PostgreSQL uses the Case Queue index for Expense Reports filtered by `tenant_id` and `current_stage`, ordered by `due_date`.

- **_Produced:_** We used `EXPLAIN (ANALYZE, BUFFERS)` to inspect the data access path. Before the Case Queue index was added, the plan used a sequential scan. After adding `expense_report_case_queue_idx`, PostgreSQL used an index scan. The check now uses 6,000 synthetic Expense Report rows so the after-plan is not based on a single-row fixture.

- **_Synthetic seed:_**

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

- **_Before index proof:_**

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

- **_After index proof:_**

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

- **_Why:_** The before-plan shows `Seq Scan on expense_report` and a `Sort` on `due_date`. The after-plan shows `Index Scan using expense_report_case_queue_idx`, and the `Index Cond` line shows the query matched the leading index columns.
