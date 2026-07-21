## Summary

Implements the Module 4 Deliverable 4 contract and integration slice:

- Records ADR-0010 for consumer-driven Core -> GL-coding contracts.
- Adds Core-side Pact consumer generation, broker publishing, provider verification from the broker, and drift-gate proof.
- Wires the integrated submit path from Core to the real FastAPI GL-coding engine, persists coded/flagged line-item output, and enforces role/flag transition guards.
- Extends local compose so one command brings up Core, Compute, Postgres, DynamoDB Local, Redis, LocalStack, and Pact Broker, then proves the composed submit slice runs end to end.

This PR intentionally spans more than 400 changed lines because the capstone deliverable covers ADR, contract tests, provider verification, integrated workflow behavior, compose stack wiring, and recorded validation output together.

## Jira Ticket

TBD - Jira ticket link was not provided in the implementation prompt. Add the ticket link before opening the PR; this description otherwise covers the Module 4 Deliverable 4 grading rubric.

## Related ADRs

- `docs/adr/0010-consumer-driven-contract-testing-for-core-to-gl-coding.md`

## Testing and Validation

Provider verification passing from the local Pact Broker against the real running FastAPI provider:

```text
cd services/compute
uv run pytest tests/test_pact_provider.py -q -s

Exit code: 0

HTTP Request: GET http://127.0.0.1:38811/health "HTTP/1.1 200 OK"
"POST /_pact/state HTTP/1.1" 200
{"method": "POST", "path": "/v1/coding", "status_code": 200}

The pact at http://localhost:9292/pacts/provider/ExpenseFlow%20Domain%20Compute%20GL%20Coding/consumer/ExpenseFlow%20Core%20Case%20Service/pact-version/a62d9301fbc4af1863856d4b2b759177c52687ad is being verified...

has status code 200 (OK)
includes headers
  "content-type" which matches /^application\/json.*/ (OK)
has a matching body (OK)

1 passed in 1.34s
```

Breaking drift proof, with `flagged` temporarily removed and shared schemas bumped to `2.0.0`; the provider verification failed and exited non-zero:

```text
cd services/compute
uv run pytest tests/test_pact_provider.py -q -s

Exit code: 1

HTTP Request: GET http://127.0.0.1:57279/health "HTTP/1.1 200 OK"
"POST /_pact/state HTTP/1.1" 200
{"method": "POST", "path": "/v1/coding", "status_code": 500}

The pact at http://localhost:9292/pacts/provider/ExpenseFlow%20Domain%20Compute%20GL%20Coding/consumer/ExpenseFlow%20Core%20Case%20Service/pact-version/a62d9301fbc4af1863856d4b2b759177c52687ad is being verified...

has status code 200 (FAILED)
body
  $.detail -> Expected 'GL coding payload violates shared schema' to be equal to 'Contains line items without GL mapping'
  $.flagged_line_item -> Expected a Boolean true but got Missing
  $.coded_line_items -> Expected an Array but got Missing
  $.coded_mileage_entries -> Expected an Array but got Missing

RuntimeError: Failed to execute verifier
FAILED tests/test_pact_provider.py::test_provider_satisfies_core_gl_coding_pact_from_broker
1 failed in 1.42s
```

Compatible drift proof, after reverting the breaking edit and adding optional `schema_revision_note` with shared schemas at `1.1.0`:

```text
cd services/compute
uv run pytest tests/test_pact_provider.py -q -s

Exit code: 0

HTTP Request: GET http://127.0.0.1:38139/health "HTTP/1.1 200 OK"
"POST /_pact/state HTTP/1.1" 200
{"method": "POST", "path": "/v1/coding", "status_code": 200}

The pact at http://localhost:9292/pacts/provider/ExpenseFlow%20Domain%20Compute%20GL%20Coding/consumer/ExpenseFlow%20Core%20Case%20Service/pact-version/a62d9301fbc4af1863856d4b2b759177c52687ad is being verified...

has status code 200 (OK)
includes headers
  "content-type" which matches /^application\/json.*/ (OK)
has a matching body (OK)

1 passed in 1.34s
```

Core submit -> GL-coding slice coverage gate:

```text
npm run test:submit-slice:coverage

Exit code: 0

RUN  v3.2.7 /home/amosmaddux/fedstack/amos-maddux-expense-tracking/apps/api
Coverage enabled with v8

✓ test/expense-report-submit-transition-slice.test.ts (1 test) 794ms
  ✓ Expense Report submit and transition cross-service slice > codes on submit, rejects cross-tenant and Employee transitions, gates flags, and sends back 793ms

Test Files  1 passed (1)
Tests  1 passed (1)

% Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
All files          |   76.82 |    70.65 |   79.59 |   76.82 |
controllers        |   79.61 |    83.33 |   88.88 |   79.61 |
engine             |   60.48 |    54.54 |   54.54 |   60.48 |
repository         |   82.22 |    84.21 |   81.81 |   82.22 |
routes             |   97.87 |       50 |     100 |   97.87 |
services           |   74.89 |    66.66 |   88.23 |   74.89 |
-------------------|---------|----------|---------|---------|-------------------
```

Consumer Pact generation:

```text
npm run pact:consumer

Exit code: 0

✓ test/gl-coding-consumer.pact.test.ts (1 test) 64ms

Test Files  1 passed (1)
Tests  1 passed (1)

../../pacts/ExpenseFlow Core Case Service-ExpenseFlow Domain Compute GL Coding.json 22ms
```

Composed stack lifecycle and submit-slice verification:

```text
docker compose down: 0
docker compose up -d: 0
docker compose ps: 0
npm run compose:verify-submit-slice: 0
npm run check: 0

compute          Up (healthy)   0.0.0.0:8000->8000/tcp
core             Up (healthy)   0.0.0.0:3000->3000/tcp
dynamodb-local   Up             0.0.0.0:8001->8000/tcp
localstack       Up (healthy)   0.0.0.0:4566->4566/tcp
pact-broker      Up (healthy)   0.0.0.0:9292->9292/tcp
pact-broker-db   Up (healthy)   5432/tcp
postgres         Up (healthy)   0.0.0.0:5433->5432/tcp
redis            Up (healthy)   0.0.0.0:6379->6379/tcp

Core health: HTTP 200
Compute health: HTTP 200
Pact Broker health: HTTP 200
Seeded synthetic over-500 Meals line item: 21f75a99-c870-4fc1-aec6-4eaa8ddc0bb8
Cross-tenant submit rejected with HTTP 404.
Submit produced persisted GL coding through composed Core -> Compute: stage=Submitted, gl_account_code=6100, flagged=true.
Flagged report was blocked from advancing past Manager Approval with HTTP 409.
Compose submit slice verification passed.
Exit code: 0
```

Full repository check:

```text
npm run check

Exit code: 0

Checking formatting...
All matched files use Prettier code style!

Test Files  3 passed (3)
Tests  10 passed (10)

Test Files  33 passed | 2 skipped (35)
Tests  200 passed | 6 skipped (206)
```

## AI Tool Reflection

I accepted Codex's suggestion to make the Core -> GL-coding Pact consumer-driven and generated through `executeTest` running the real Core GL-coding client, because ExpenseFlow owns both sides and Core's actual submit-time usage is the behavior that must not break. I rejected the  shortcut of proving the compose stack by only checking that containers build so that we cana ctually test whether the composed Core container calls the composed FastAPI provider and persists a real coded/flagged result.

## PR Setup

- Branch: `m4d4-implementation`
- Assignees: self-assign `amosmaddux`
- Reviewers: request `ES`

## Trunk-Based Checklist

- [ ] I confirm this PR links the relevant Jira ticket in the description.
- [ ] I confirm this PR covers one Jira ticket, or all related Jira tickets are linked and explained above.
- [x] I confirm this PR is within 400 changed lines excluding lockfiles and generated files, or the exception is documented in the summary.
- [x] I confirm required checks are expected to pass before merge.

## AI Code-Review Checklist

- [x] I confirm tenant-scoped records and access paths prevent cross-tenant read, write, inference, search, export, and delivery.
- [x] I confirm all new or changed external inputs are validated at boundaries, and unsafe input is rejected or normalized.
- [x] I confirm privileged actions and workflow state changes remain auditable without exposing controlled data.
- [x] I confirm raw receipt data, payment data, bank-feed transaction data, secrets, credentials, tokens, and private identifiers are not logged in plaintext.
- [x] I confirm architectural decision changes link the relevant ADR in the Related ADRs section, or the section states `N/A - no architectural decision changed`.

## Deliverables Checklist

- [x] ADR-0010 records the Core -> GL-coding contract-testing decision as consumer-driven, with owns-both-sides rationale and a named non-Pact integration.
- [x] Pact JS consumer test runs real Core consumer code and publishes the pact to the local broker with only Core-read fields, including the flagged line-item field.
- [x] pact-python provider verification fetches the pact from the broker, verifies against the real FastAPI GL-coding engine, and publishes results.
- [x] Deliberate breaking shared-schema drift fails provider verification with a non-zero exit; compatible optional-field drift passes.
- [x] Integrated submit advances to Submitted, calls the real GL-coding engine over the hardened client with tenant JWT, and persists coded line items plus over-$500 flags.
- [x] Role-gated transition guard enforces Employee 403, Department Manager/Finance Admin transitions, flagged-line blocking, auditable denial, and reject-to-Drafted send-back.
- [x] Cross-service end-to-end slice is green with coverage above the bar: 76.82% line and 70.65% branch.
- [x] `docker compose up -d` brings up Core, Compute, Postgres, DynamoDB Local, Redis, LocalStack, and Pact Broker, and the composed submit slice runs reproducibly after `down` then `up`.
- [x] Verification and coverage output are pasted above.
- [x] AI-tool reflection includes one accepted and one rejected suggestion.
