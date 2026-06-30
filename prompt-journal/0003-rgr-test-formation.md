# 0003 — RGR Test Formation

- **_Asked:_** Add an edge-case test for a report with several line items at and around the 500 boundary, then refactor the function without breaking boundary tests. Preserve red-green-refactor commit ordering: the edge test red, then green, then any refactor.

- **_Produced:_** Codex proposed a red-green-refactor plan: first add a red test with line items totaling exactly `Decimal("500.00")` and `Decimal("500.01")`; then make the test green by adding `line_items: list[MoneyLineItem] = Field(default_factory=list)` to `ExpenseReport`; then refactor `flag_when_report_over_500` without changing behavior.

- **_Accepted / Rejected:_** ACCEPTED: Add `line_items` to `ExpenseReport` as the green implementation after the red line-item boundary test. REJECTED: Undo the line-item red test and avoid changing `ExpenseReport`.

- **_Why:_** Adding `line_items` matched the intended Expense Report model and made the red test pass with the smallest production change. Undoing the line-item test was rejected because it came from a temporary misread; the clarified requirement confirmed that Expense Reports should preserve line items.
