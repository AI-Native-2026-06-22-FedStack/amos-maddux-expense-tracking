#!/usr/bin/env bash
set -euo pipefail

api_image="${1:-expenseflow-core-case-service:otel-local}"
compute_image="${2:-expenseflow-gl-coding:otel-local}"
artifact_dir="${ARTIFACT_DIR:-artifacts/security}"
compose_project="${FLOCI_TRACE_COMPOSE_PROJECT:-expenseflow-dast}"
network_name="${FLOCI_TRACE_NETWORK:-expenseflow-local}"
api_container="${FLOCI_TRACE_API_CONTAINER:-expenseflow-trace-api}"
compute_container="${FLOCI_TRACE_COMPUTE_CONTAINER:-expenseflow-trace-compute}"
adot_container="${FLOCI_TRACE_ADOT_CONTAINER:-expenseflow-trace-adot}"
aws_endpoint="${AWS_ENDPOINT_URL:-http://localhost:4566}"
floci_region="${AWS_REGION:-us-east-1}"
real_xray_region="${REAL_AWS_REGION:-${AWS_REGION:-us-east-1}}"
account_id="000000000000"
target_url="${FLOCI_TRACE_TARGET_URL:-http://floci/ready}"
# Default to a fresh random trace ID per run rather than a fixed constant.
# A reused trace ID was observed to make X-Ray's get-trace-summaries never
# surface the trace even though PutTraceSegments accepted every segment
# (UnprocessedTraceSegments: [] each time) -- most likely X-Ray's server-side
# trace merge getting confused by repeated, non-monotonic segment data under
# the same ID across script runs. FLOCI_TRACE_ID can still override this for
# reproducible debugging.
trace_id_seed="${FLOCI_TRACE_ID:-$(printf '%08x%s' "$(date -u +%s)" "$(openssl rand -hex 12)")}"
span_id_seed="${FLOCI_SPAN_ID:-$(openssl rand -hex 8)}"
correlation_id="${FLOCI_TRACE_CORRELATION_ID:-synthetic-floci-trace-correlation-id}"
run_id="${FLOCI_TRACE_RUN_ID:-$(date -u +%H%M%S)}"
resource_prefix="${FLOCI_TRACE_RESOURCE_PREFIX:-ef-trace-${run_id}}"
start_epoch="$(date -u +%s)"

export AWS_ENDPOINT_URL="${aws_endpoint}"
export AWS_REGION="${floci_region}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export COMPOSE_AWS_ENDPOINT_URL="${COMPOSE_AWS_ENDPOINT_URL:-http://floci:4566}"

mkdir -p "${artifact_dir}"

aws_floci() {
  aws --endpoint-url "${aws_endpoint}" --region "${floci_region}" "$@"
}

aws_real_xray() {
  if [ -n "${REAL_AWS_ACCESS_KEY_ID:-}" ]; then
    env -u AWS_ENDPOINT_URL \
      AWS_ACCESS_KEY_ID="${REAL_AWS_ACCESS_KEY_ID}" \
      AWS_SECRET_ACCESS_KEY="${REAL_AWS_SECRET_ACCESS_KEY:-}" \
      AWS_SESSION_TOKEN="${REAL_AWS_SESSION_TOKEN:-}" \
      aws --region "${real_xray_region}" xray "$@"
    return
  fi

  env -u AWS_ENDPOINT_URL \
    -u AWS_ACCESS_KEY_ID \
    -u AWS_SECRET_ACCESS_KEY \
    -u AWS_SESSION_TOKEN \
    aws --region "${real_xray_region}" xray "$@"
}

docker compose -p "${compose_project}" up -d --wait postgres redis floci
docker compose -p "${compose_project}" up -d --force-recreate compose-init
docker compose -p "${compose_project}" wait compose-init

docker rm -f "${api_container}" "${compute_container}" "${adot_container}" >/dev/null 2>&1 || true

adot_env_args=(-e "AWS_REGION=${real_xray_region}")
if [ -n "${REAL_AWS_ACCESS_KEY_ID:-}" ]; then
  adot_env_args+=(
    -e "AWS_ACCESS_KEY_ID=${REAL_AWS_ACCESS_KEY_ID}"
    -e "AWS_SECRET_ACCESS_KEY=${REAL_AWS_SECRET_ACCESS_KEY:-}"
  )
fi
if [ -n "${REAL_AWS_SESSION_TOKEN:-}" ]; then
  adot_env_args+=(-e "AWS_SESSION_TOKEN=${REAL_AWS_SESSION_TOKEN}")
fi

docker run -d \
  --name "${adot_container}" \
  --network "${network_name}" \
  "${adot_env_args[@]}" \
  -v "$(pwd)/observability/adot-collector.yaml:/etc/otel-agent-config.yaml:ro" \
  public.ecr.aws/aws-observability/aws-otel-collector:v0.43.0 \
  --config=/etc/otel-agent-config.yaml >/dev/null

docker run -d \
  --name "${compute_container}" \
  --network "${network_name}" \
  -e AWS_REGION="${floci_region}" \
  -e DATABASE_URI=postgres://expenseflow:synthetic-compose-db-password@postgres:5432/expenseflow \
  -e DATABASE_URL=postgres://expenseflow:synthetic-compose-db-password@postgres:5432/expenseflow \
  -e OTEL_SERVICE_NAME=expenseflow-gl-coding-engine \
  -e OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://${adot_container}:4318/v1/traces" \
  "${compute_image}" >/dev/null

docker run -d \
  --name "${api_container}" \
  --network "${network_name}" \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e AWS_ENDPOINT=http://floci:4566 \
  -e AWS_REGION="${floci_region}" \
  -e DB_PASSWORD_SECRET_ID=expenseflow/local/db-password \
  -e JWT_SIGNING_KEYS_SECRET_ID=expenseflow/local/jwt-signing-keys \
  -e DATABASE_URI=postgres://expenseflow@postgres:5432/expenseflow \
  -e REDIS_URL=redis://redis:6379 \
  -e COMPUTE_SERVICE_URL="http://${compute_container}:8000" \
  -e GL_CODING_SERVICE_BASE_URL="http://${compute_container}:8000" \
  -e API_CORS_ALLOWED_ORIGIN=http://expenseflow-spa.test \
  -e TOTP_SECRET_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY= \
  -e SNS_STAGE_EVENTS_TOPIC=expenseflow-stage-events \
  -e SQS_STAGE_EVENTS_QUEUE=expenseflow-stage-projection \
  -e SQS_STAGE_EVENTS_DLQ=expenseflow-stage-projection-dlq \
  -e EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS=60000 \
  -e EXPENSE_WRITE_RATE_LIMIT_MAX=120 \
  -e EXPENSE_WRITE_SLOW_DOWN_AFTER=80 \
  -e EXPENSE_WRITE_DELAY_INCREMENT_MS=250 \
  -e EXPENSE_WRITE_MAX_DELAY_MS=5000 \
  -e OTEL_SERVICE_NAME=expenseflow-core-case-service \
  -e OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://${adot_container}:4318/v1/traces" \
  "${api_image}" >/dev/null

for attempt in $(seq 1 40); do
  if docker run --rm --network "${network_name}" curlimages/curl:8.16.0 \
    -fsS "http://${api_container}:3000/health" >/dev/null; then
    break
  fi

  if [ "${attempt}" -eq 40 ]; then
    docker logs "${api_container}" >&2 || true
    echo "ExpenseFlow API container did not become healthy for trace proof."
    exit 1
  fi

  sleep 2
done

vpc_id="$(aws_floci ec2 create-vpc \
  --cidr-block 10.27.0.0/16 \
  --query 'Vpc.VpcId' \
  --output text 2>/dev/null || true)"
if [ -z "${vpc_id}" ] || [ "${vpc_id}" = "None" ]; then
  vpc_id="$(aws_floci ec2 describe-vpcs --query 'Vpcs[0].VpcId' --output text)"
fi

subnet_a="$(aws_floci ec2 create-subnet \
  --vpc-id "${vpc_id}" \
  --cidr-block 10.27.1.0/24 \
  --availability-zone "${floci_region}a" \
  --query 'Subnet.SubnetId' \
  --output text 2>/dev/null || true)"
subnet_b="$(aws_floci ec2 create-subnet \
  --vpc-id "${vpc_id}" \
  --cidr-block 10.27.2.0/24 \
  --availability-zone "${floci_region}b" \
  --query 'Subnet.SubnetId' \
  --output text 2>/dev/null || true)"
if [ -z "${subnet_a}" ] || [ "${subnet_a}" = "None" ]; then
  subnet_a="$(aws_floci ec2 describe-subnets --query 'Subnets[0].SubnetId' --output text)"
fi
if [ -z "${subnet_b}" ] || [ "${subnet_b}" = "None" ]; then
  subnet_b="$(aws_floci ec2 describe-subnets --query 'Subnets[1].SubnetId' --output text)"
fi

security_group_id="$(aws_floci ec2 create-security-group \
  --group-name "${resource_prefix}-alb-sg" \
  --description "Synthetic floci ALB security group for trace proof" \
  --vpc-id "${vpc_id}" \
  --query 'GroupId' \
  --output text)"

load_balancer_arn="$(aws_floci elbv2 create-load-balancer \
  --name "${resource_prefix}-alb" \
  --subnets "${subnet_a}" "${subnet_b}" \
  --security-groups "${security_group_id}" \
  --scheme internet-facing \
  --type application \
  --query 'LoadBalancers[0].LoadBalancerArn' \
  --output text)"
load_balancer_dns_name="$(aws_floci elbv2 describe-load-balancers \
  --load-balancer-arns "${load_balancer_arn}" \
  --query 'LoadBalancers[0].DNSName' \
  --output text)"

target_group_arn="$(aws_floci elbv2 create-target-group \
  --name "${resource_prefix}-api" \
  --protocol HTTP \
  --port 3000 \
  --vpc-id "${vpc_id}" \
  --target-type ip \
  --health-check-protocol HTTP \
  --health-check-port traffic-port \
  --health-check-path /health \
  --matcher HttpCode=200 \
  --query 'TargetGroups[0].TargetGroupArn' \
  --output text)"

aws_floci elbv2 create-listener \
  --load-balancer-arn "${load_balancer_arn}" \
  --protocol HTTP \
  --port 80 \
  --default-actions "Type=forward,TargetGroupArn=${target_group_arn}" >/dev/null

api_ip="$(docker inspect -f "{{with index .NetworkSettings.Networks \"${network_name}\"}}{{.IPAddress}}{{end}}" "${api_container}")"
if [ -z "${api_ip}" ]; then
  api_ip="$(docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" "${api_container}")"
fi

aws_floci elbv2 register-targets \
  --target-group-arn "${target_group_arn}" \
  --targets "Id=${api_ip},Port=3000" >/dev/null 2>&1 || true

for attempt in $(seq 1 30); do
  if docker run --rm --network "${network_name}" curlimages/curl:8.16.0 \
    -fsS \
    -H "Host: ${load_balancer_dns_name}" \
    -H "traceparent: 00-${trace_id_seed}-${span_id_seed}-01" \
    -H "X-Correlation-Id: ${correlation_id}" \
    "${target_url}" | tee "${artifact_dir}/trace-proof-ready-response.json" >/dev/null; then
    break
  fi

  if [ "${attempt}" -eq 30 ]; then
    docker logs "${api_container}" >"${artifact_dir}/trace-proof-api.log" 2>&1 || true
    docker logs "${compute_container}" >"${artifact_dir}/trace-proof-compute.log" 2>&1 || true
    echo "floci trace target did not answer successfully: ${target_url} host=${load_balancer_dns_name}"
    exit 1
  fi

  sleep 2
done

sleep 10
end_epoch="$(date -u +%s)"

docker logs "${api_container}" >"${artifact_dir}/trace-proof-api.log" 2>&1 || true
docker logs "${compute_container}" >"${artifact_dir}/trace-proof-compute.log" 2>&1 || true
docker logs "${adot_container}" >"${artifact_dir}/trace-proof-adot.log" 2>&1 || true

api_trace_count="$(grep -Ec "\"traceId\"[[:space:]]*:[[:space:]]*\"${trace_id_seed}\"" "${artifact_dir}/trace-proof-api.log" || true)"
compute_trace_count="$(grep -Ec "\"traceId\"[[:space:]]*:[[:space:]]*\"${trace_id_seed}\"" "${artifact_dir}/trace-proof-compute.log" || true)"

if [ "${api_trace_count}" -lt 1 ] || [ "${compute_trace_count}" -lt 1 ]; then
  echo "Expected trace ID ${trace_id_seed} in both API and compute logs." >&2
  echo "API matches: ${api_trace_count}; compute matches: ${compute_trace_count}" >&2
  exit 1
fi

printf '%s\n' "${trace_id_seed}" >"${artifact_dir}/xray-trace-id.txt"

# X-Ray derives its trace ID from the same 32 hex chars as the W3C trace ID:
# "1-<first 8 hex>-<remaining 24 hex>". Compute the expected X-Ray ID so the
# proof can confirm this run's trace specifically reached X-Ray, rather than
# treating any trace present in the account/region during the time window as
# sufficient evidence of a successful export.
expected_xray_trace_id="1-${trace_id_seed:0:8}-${trace_id_seed:8:24}"

xray_error_file="${artifact_dir}/xray-fetch-error.txt"
xray_summaries_tmp="${artifact_dir}/xray-trace-summaries.json.tmp"
xray_traces_tmp="${artifact_dir}/xray-batch-get-traces.json.tmp"
rm -f "${xray_error_file}" "${xray_summaries_tmp}" "${xray_traces_tmp}"

# X-Ray indexing can lag a few seconds behind export, so poll with backoff
# instead of a single query. A bounded number of attempts still fails the
# script hard if the trace never lands, rather than hanging indefinitely.
xray_poll_attempts="${FLOCI_XRAY_POLL_ATTEMPTS:-6}"
xray_poll_interval_seconds="${FLOCI_XRAY_POLL_INTERVAL_SECONDS:-10}"
xray_trace_found=0

for xray_attempt in $(seq 1 "${xray_poll_attempts}"); do
  end_epoch="$(date -u +%s)"

  if ! aws_real_xray get-trace-summaries \
    --start-time "${start_epoch}" \
    --end-time "${end_epoch}" \
    >"${xray_summaries_tmp}" 2>"${xray_error_file}"; then
    rm -f "${xray_summaries_tmp}"
    echo "Real AWS X-Ray trace summary pull failed; see ${xray_error_file}." >&2
    exit 1
  fi
  mv "${xray_summaries_tmp}" "${artifact_dir}/xray-trace-summaries.json"

  if jq -e --arg id "${expected_xray_trace_id}" \
    'any(.TraceSummaries[]; .Id == $id)' \
    "${artifact_dir}/xray-trace-summaries.json" >/dev/null; then
    xray_trace_found=1
    break
  fi

  echo "Expected X-Ray trace ID ${expected_xray_trace_id} not yet visible (attempt ${xray_attempt}/${xray_poll_attempts})." >&2
  [ "${xray_attempt}" -eq "${xray_poll_attempts}" ] || sleep "${xray_poll_interval_seconds}"
done

if [ "${xray_trace_found}" -ne 1 ]; then
  echo "Expected X-Ray trace ID ${expected_xray_trace_id} (derived from seeded traceId ${trace_id_seed}) was not found in xray-trace-summaries.json after ${xray_poll_attempts} attempts." >&2
  echo "The ADOT collector may have failed to export this run's trace even though other traces exist in the account/region for this time window." >&2
  echo "Check ${artifact_dir}/trace-proof-adot.log for exporter errors (service.telemetry.logs.level is set to debug in observability/adot-collector.yaml)." >&2
  exit 1
fi

if ! aws_real_xray batch-get-traces \
  --trace-ids "${expected_xray_trace_id}" \
  >"${xray_traces_tmp}" 2>"${xray_error_file}"; then
  rm -f "${xray_traces_tmp}"
  echo "Real AWS X-Ray batch trace pull failed; see ${xray_error_file}." >&2
  exit 1
fi
mv "${xray_traces_tmp}" "${artifact_dir}/xray-batch-get-traces.json"

if ! jq -e --arg id "${expected_xray_trace_id}" \
  'any(.Traces[]; .Id == $id)' \
  "${artifact_dir}/xray-batch-get-traces.json" >/dev/null; then
  echo "Expected X-Ray trace ID ${expected_xray_trace_id} was not returned by batch-get-traces." >&2
  exit 1
fi

cat >"${artifact_dir}/trace-proof-summary.json" <<EOF
{
  "targetUrl": "${target_url}",
  "correlationId": "${correlation_id}",
  "traceId": "${trace_id_seed}",
  "xrayTraceId": "${expected_xray_trace_id}",
  "apiLogMatches": ${api_trace_count},
  "computeLogMatches": ${compute_trace_count},
  "realXrayRegion": "${real_xray_region}",
  "xrayTraceSummaryCount": $(jq '.TraceSummaries | length' "${artifact_dir}/xray-trace-summaries.json")
}
EOF

echo "Trace proof passed for traceId=${trace_id_seed} (xrayTraceId=${expected_xray_trace_id})"
