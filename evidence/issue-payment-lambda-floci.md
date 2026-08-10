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

## Notes

floci runs Lambda-shaped resources locally but does not reproduce production
cold-start conditions. Treat cold-start timing observed here as indicative only.
