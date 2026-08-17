# First Observability Proof

Date: 2026-08-17

## Alarm

The first post-release alarm is defined in `infra/terraform/modules/observability`.

- Alarm: `aws_cloudwatch_metric_alarm.release_health`
- Signal: `AWS/ApplicationELB` `TargetResponseTime`
- Window: 3 consecutive one-minute periods by default
- Runbook: the alarm description includes `docs/runbook-rollback.md`
- Target: floci CloudWatch via the existing Terraform provider endpoint

## Trace Proof

Command used:

```bash
AWS_ENDPOINT_URL=http://localhost:4566 \
AWS_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
FLOCI_TRACE_RUN_ID=1511 \
./scripts/trace-proof-floci.sh \
  expenseflow-core-case-service:otel-local \
  expenseflow-gl-coding:otel-local
```

The floci deployed URL returned:

```json
{ "service": "ExpenseFlow API", "status": "ready" }
```

Seeded trace ID:

```text
1234567890abcdef1234567890abcdef
```

The same seeded trace ID and correlation ID appeared in both service logs:

- `artifacts/security/trace-proof-api.log`
- `artifacts/security/trace-proof-compute.log`

Correlation ID:

```text
synthetic-floci-trace-correlation-id
```

The ADOT collector started and listened for OTLP traffic, using the AWS X-Ray exporter instead of floci.

## X-Ray Artifact Status

The script separates floci AWS calls from real AWS X-Ray calls. The floci request and log-correlation assertions passed, but the real X-Ray artifact pull was blocked because this shell did not have valid real AWS credentials. The captured error is in `artifacts/security/xray-fetch-error.txt`:

```text
UnrecognizedClientException: The security token included in the request is invalid.
```

Re-run the same script with real program-region X-Ray credentials, for example via `REAL_AWS_REGION`, `REAL_AWS_ACCESS_KEY_ID`, `REAL_AWS_SECRET_ACCESS_KEY`, and `REAL_AWS_SESSION_TOKEN`, to populate:

- `artifacts/security/xray-trace-summaries.json`
- `artifacts/security/xray-batch-get-traces.json`
- `artifacts/security/trace-proof-summary.json`
