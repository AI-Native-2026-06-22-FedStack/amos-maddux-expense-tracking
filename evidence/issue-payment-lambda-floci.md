# Issue-Payment Lambda floci verification

Date: 2026-08-10

All AWS CLI calls target local floci only:

```sh
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_REGION=us-east-1
```

## Expected resources

- Function: `expenseflow-issue-payment`
- Runtime: `nodejs24.x`
- Architecture: `arm64`
- Handler: `index.handler`
- HTTP API route:
  `POST /v1/expense-reports/{expenseReportId}/issue-payment`
- Core Case Service remains on ECS Fargate and is reached through
  `CORE_CASE_SERVICE_URL`.

## Verification checklist

- Package from `lambda/issue-payment` with `npm run build`.
- If the Lambda runtime container cannot call back to floci, start floci with
  `lambda/issue-payment/floci/docker-compose.override.yml` so Lambda
  containers join the local `expenseflow-local` network and use the `floci`
  host override.
- Create or update the Lambda using `lambda/issue-payment/floci/function.json`
  and the packaged `issue-payment.zip`.
  Replace `${lambda_execution_role}` with the local floci Lambda execution role
  value from your shell; do not commit that value.
- Create the HTTP API using `lambda/issue-payment/floci/http-api-create.json`.
- Create the proxy integration using
  `lambda/issue-payment/floci/http-api-integration.json`.
  Replace `${issue_payment_function_uri}` from command output or local shell
  state; do not commit that value.
- Create the route using `lambda/issue-payment/floci/http-api-route.json`,
  replacing `${integration_id}` with the floci integration ID.
- Invoke the function twice with the same synthetic `X-Correlation-Id`.
- Confirm the structured Powertools log lines include:
  - `issuePayment.invoked`
  - `issuePayment.forwarded`
  - `correlationId`
  - the same `initInstanceId` on the second warm invocation
- Confirm the second invocation does not inherit body values from the first
  invocation.
- Confirm function configuration reports:

```text
Runtime=nodejs24.x
Architectures=arm64
```

## Route verification on 2026-08-10

- floci function configuration reported `Runtime=nodejs24.x`,
  `Architectures=arm64`, and handler `index.handler`.
- API Gateway v2 reported `ProtocolType=HTTP`.
- The single route was
  `POST /v1/expense-reports/{expenseReportId}/issue-payment`.
- The integration reported `IntegrationType=AWS_PROXY` and
  `PayloadFormatVersion=2.0`.
- Two synthetic POST requests were sent through the local floci API Gateway URL:
  - `/v1/expense-reports/erpt-synthetic-route-001/issue-payment`
  - `/v1/expense-reports/erpt-synthetic-route-002/issue-payment`
- Both requests reached the Lambda and returned handler responses:
  `401 {"message":"Authorization header is required."}`.
- Both responses echoed the per-request synthetic `X-Correlation-Id` header.
- The Powertools log output was structured JSON with `issuePayment.rejected`,
  the request `correlationId`, the parsed `expenseReportId`, and the same
  synthetic init marker across the two warm route invocations.
- The live route test intentionally omitted `Authorization` so it verified API
  Gateway proxy routing without requiring the Core Case Service container. The
  command-forwarding path is covered by the Lambda unit tests and forwards to
  `/v1/expense-reports/:expenseReportId/advance` when `Authorization` is
  present.

## Warm invoke verification on 2026-08-10

- A fresh local floci function was created from the packaged Lambda and reported
  `Runtime=nodejs24.x`, `Architectures=arm64`, handler `index.handler`, and a
  30-second timeout.
- A fresh local floci HTTP API reported `ProtocolType=HTTP`.
- `get-routes` for the verification API reported one route:
  `POST /v1/expense-reports/{expenseReportId}/issue-payment`.
- `get-integrations` for the verification API reported one `AWS_PROXY`
  integration with payload format `2.0`.
- The route was invoked twice with synthetic authorization and correlation
  headers. The Core Case Service container was not started for this check, so
  both responses were the handler's expected forwarding-failed JSON response:
  `502 {"message":"Core Case Service command forwarding failed."}`.
- Both responses included the per-request synthetic `X-Correlation-Id`.
- The first invoke had JSON body `{"reason":"First synthetic verification
  reason"}` and logged structured Powertools JSON with `hasReason=true`.
- The second warm invoke had an empty request body. floci presented that proxy
  event as `body: null`; the handler treated it as no reason and logged
  structured Powertools JSON with `hasReason=false`.
- The two post-fix invokes used the same synthetic `initInstanceId`, showing
  the init-created config/client/logger state was reused for the warm second
  invocation.

## Notes

floci runs Lambda-shaped resources locally but does not reproduce production
cold-start conditions. Treat cold-start timing observed here as indicative only.
