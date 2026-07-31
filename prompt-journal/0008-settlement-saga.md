# 0008 - Settlement Saga

- **_Asked:_** Coordinate Paid to Reconciled settlement as a saga: issue a payment stub, reconcile the Expense Report, and compensate committed steps in reverse order if a later step fails.

- **_Produced:_** Added an orchestrated settlement saga for the Paid to Reconciled path. The coordinator records completed forward steps during one saga execution, issues a synthetic payment ID as the first committed local action, then transitions the Expense Report to Reconciled as the second committed local action.

- **_Accepted / Rejected:_** ACCEPTED: Use orchestration through a central coordinator. REJECTED: Use choreography for this starter flow.

- **_Why:_** This settlement has a short, ordered sequence with an explicit compensation rule: if reconciliation fails after payment is issued, void the issued payment and leave the Expense Report in Paid with no payment ID. A central coordinator keeps the completed-step list local and makes reverse compensation deterministic. Choreography would add event handlers and eventual ordering concerns before ExpenseFlow has multiple independent settlement participants.

- **_Compensation model:_** Compensations are new idempotent actions, not rollbacks of committed work. Voiding a payment clears only the matching payment ID and is a no-op if that payment has already been voided, so a retried compensation does not double-offset.
