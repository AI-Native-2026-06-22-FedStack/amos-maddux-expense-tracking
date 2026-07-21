# Pact Provider Verification Test Results

Date: 2026-07-20

## Setup

Local Pact Broker was running through Docker Compose before verification:

```text
docker compose up -d pact-broker-db pact-broker
npm run pact:consumer
npm run pact:publish
```

The provider pytest starts the real FastAPI app with Uvicorn on `127.0.0.1:<free-port>`, verifies the pact from `PACT_BROKER_BASE_URL` with pact-python `Verifier.broker_source(...)`, and publishes results with `set_publish_options(...)`.

Broker-side result confirmation:

```text
curl -sS 'http://localhost:9292/pacts/provider/ExpenseFlow%20Domain%20Compute%20GL%20Coding/consumer/ExpenseFlow%20Core%20Case%20Service/pact-version/a62d9301fbc4af1863856d4b2b759177c52687ad/verification-results/latest'

{"providerName":"ExpenseFlow Domain Compute GL Coding","providerApplicationVersion":"0.1.0-local","success":true,"verificationDate":"2026-07-20T21:55:31+00:00","testResults":[{"interactionId":"e4cbcafbecaab050cf099833a6e167a46f8af160","success":true}],"verifiedBy":{"implementation":"Pact-Rust","version":"1.3.6","client_implementation":"pact-python","client_test_framework":"pact_ffi","client_version":"0.5.4.1"}}
```

## Provider Verification Pass

Command:

```text
cd services/compute
uv run pytest tests/test_pact_provider.py -q -s
```

Exit code: `0`

Selected output:

```text
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

## Breaking Drift Proof

Temporary breaking change:

- `packages/shared-schemas/package.json` bumped from `1.0.0` to `2.0.0`.
- Removed the `flagged` response field from the GL-coding shared schema line item response definitions.

Command:

```text
cd services/compute
uv run pytest tests/test_pact_provider.py -q -s
```

Exit code: `1`

Selected output:

```text
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

The command exited non-zero, so the provider job would block this breaking schema drift.

## Compatible Drift Proof

Compatible change kept after reverting the breaking edit:

- `packages/shared-schemas/package.json` set to `1.1.0`.
- Added optional top-level `schema_revision_note` string to `GlCodingResponse`.

Command:

```text
cd services/compute
uv run pytest tests/test_pact_provider.py -q -s
```

Exit code: `0`

Selected output:

```text
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

## Provider Suite

Command:

```text
cd services/compute
make test
```

Exit code: `0`

Selected output:

```text
uv sync
uv run pytest
tests/test_pact_provider.py . [ 61%]
44 passed, 1 warning in 1.77s
```

Command:

```text
cd services/compute
make check
```

Exit code: `0`

Selected output:

```text
uv sync
uv run ruff check app tests
All checks passed!
uv run mypy app
Success: no issues found in 8 source files
uv run pytest
44 passed, 1 warning in 1.77s
```

## Repository Check

Command:

```text
npm run check
```

Exit code: `0`

Selected output:

```text
> expenseflow@0.1.0 check
> npm run build && npm run lint && npm test

Test Files  3 passed (3)
Tests  10 passed (10)

Test Files  32 passed | 2 skipped (34)
Tests  194 passed | 6 skipped (200)
```

# Integrated Submit and Transition Slice Results

Date: 2026-07-20

## Cross-Service Slice Test

Command:

```text
cd apps/api
npx vitest run --config vitest.config.ts test/expense-report-submit-transition-slice.test.ts
```

Exit code: `0`

Selected output:

```text
RUN  v3.2.7 /home/amosmaddux/fedstack/amos-maddux-expense-tracking/apps/api

POST /v1/expense-reports ... statusCode 201
POST /v1/expense-reports/<report-id>/submit with tenant B ... statusCode 404
POST /v1/expense-reports/<report-id>/submit with tenant A ... statusCode 200
POST /v1/expense-reports/<report-id>/advance as Employee ... statusCode 403
POST /v1/expense-reports/<report-id>/advance as Department Manager ... statusCode 200
POST /v1/expense-reports/<report-id>/advance with uncleared flag ... statusCode 409
POST /v1/expense-reports/<report-id>/advance after flag clear ... statusCode 200
POST /v1/expense-reports/<report-id>/reject as Finance Admin ... statusCode 200

✓ test/expense-report-submit-transition-slice.test.ts (1 test) 1276ms
  ✓ Expense Report submit and transition cross-service slice > codes on submit, rejects cross-tenant and Employee transitions, gates flags, and sends back 1275ms

Test Files  1 passed (1)
Tests  1 passed (1)
```

The test starts the real FastAPI GL-coding provider with `uv run uvicorn app.main:app`, points Core at that local provider URL, seeds synthetic GL mappings in Postgres, and proves that Core persists mapped GL code `6100`, `flagged: true`, and the stage/audit history.

## Slice Coverage Gate

Command:

```text
npm run test:submit-slice:coverage
```

Exit code: `0`

Coverage scope:

```text
apps/api/src/controllers/expense-report-controller.ts
apps/api/src/engine/gl-client.ts
apps/api/src/repository/expense-report-repository.ts
apps/api/src/routes/expense-report-routes.ts
apps/api/src/services/expense-report-service.ts
```

Selected output:

```text
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

The aggregate slice gate passed the configured thresholds: line coverage `76.82%` is above `70%`; branch coverage `70.65%` is above `60%`.

## Focused Regression Tests

Command:

```text
cd apps/api
npx vitest run --config vitest.config.ts src/services/expense-report-service.test.ts src/routes/expense-report-routes.test.ts test/expense-report-repository.test.ts test/expense-report-submit-transition-slice.test.ts
```

Exit code: `0`

Selected output:

```text
✓ test/expense-report-submit-transition-slice.test.ts (1 test) 724ms
✓ test/expense-report-repository.test.ts (9 tests) 514ms
✓ src/routes/expense-report-routes.test.ts (10 tests) 443ms
✓ src/services/expense-report-service.test.ts (7 tests) 255ms

Test Files  4 passed (4)
Tests  27 passed (27)
```

## Consumer Pact Regeneration

Command:

```text
npm run pact:consumer
```

Exit code: `0`

Selected output:

```text
✓ test/gl-coding-consumer.pact.test.ts (1 test) 64ms

Test Files  1 passed (1)
Tests  1 passed (1)

../../pacts/ExpenseFlow Core Case Service-ExpenseFlow Domain Compute GL Coding.json 22ms
```

## Full Repository Check

Command:

```text
npm run check
```

Exit code: `0`

Selected output:

```text
> expenseflow@0.1.0 check
> npm run build && npm run lint && npm test

Checking formatting...
All matched files use Prettier code style!

Test Files  3 passed (3)
Tests  10 passed (10)

Test Files  33 passed | 2 skipped (35)
Tests  200 passed | 6 skipped (206)
```

# Compose Submit Slice Results

```sh
npm run compose:verify-submit-slice
```

```text
Core health: HTTP 200
Compute health: HTTP 200
Pact Broker health: HTTP 200
Seeded synthetic over-500 Meals line item: afea56d9-3b32-4416-9c32-f8f918474bde
Cross-tenant submit rejected with HTTP 404.
Submit produced persisted GL coding through composed Core -> Compute: stage=Submitted, gl_account_code=6100, flagged=true.
Flagged report was blocked from advancing past Manager Approval with HTTP 409.
Compose submit slice verification passed.
Exit code: 0
```

# Compose Stack Lifecycle Results

Commands:

```text
docker compose down
docker compose up -d
docker compose ps
npm run compose:verify-submit-slice
npm run check
```

Exit codes:

```text
docker compose down: 0
docker compose up -d: 0
docker compose ps: 0
npm run compose:verify-submit-slice: 0
npm run check: 0
```

Selected final `docker compose ps` output:

```text
compute          Up (healthy)   0.0.0.0:8000->8000/tcp
core             Up (healthy)   0.0.0.0:3000->3000/tcp
dynamodb-local   Up             0.0.0.0:8001->8000/tcp
localstack       Up (healthy)   0.0.0.0:4566->4566/tcp
pact-broker      Up (healthy)   0.0.0.0:9292->9292/tcp
pact-broker-db   Up (healthy)   5432/tcp
postgres         Up (healthy)   0.0.0.0:5433->5432/tcp
redis            Up (healthy)   0.0.0.0:6379->6379/tcp
```

Selected final `npm run check` output:

```text
Checking formatting...
All matched files use Prettier code style!

Test Files  3 passed (3)
Tests  10 passed (10)

Test Files  33 passed | 2 skipped (35)
Tests  200 passed | 6 skipped (206)
```

# Compose Submit Slice Results

```sh
npm run compose:verify-submit-slice
```

```text
Core health: HTTP 200
Compute health: HTTP 200
Pact Broker health: HTTP 200
Seeded synthetic over-500 Meals line item: 64ecfde2-363e-49e3-a036-3977f1cfcbb4
Cross-tenant submit rejected with HTTP 404.
Submit produced persisted GL coding through composed Core -> Compute: stage=Submitted, gl_account_code=6100, flagged=true.
Flagged report was blocked from advancing past Manager Approval with HTTP 409.
Compose submit slice verification passed.
Exit code: 0
```

# Compose Submit Slice Results

```sh
npm run compose:verify-submit-slice
```

```text
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
