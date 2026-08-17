#!/bin/sh
set -eu

image_ref="${1:-expenseflow-core-case-service:m7-provenance-local}"
artifact_dir="${ARTIFACT_DIR:-artifacts/security}"
compose_project="${FLOCI_DAST_COMPOSE_PROJECT:-expenseflow-dast}"
network_name="${FLOCI_DAST_NETWORK:-expenseflow-local}"
api_container="${FLOCI_DAST_API_CONTAINER:-expenseflow-dast-api}"
target_url="${FLOCI_DAST_TARGET_URL:-http://floci/health}"
zap_image="${ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy:stable}"
curl_image="${CURL_IMAGE:-curlimages/curl:8.16.0}"
aws_endpoint="${AWS_ENDPOINT_URL:-http://localhost:4566}"
aws_region="${AWS_REGION:-us-east-1}"
account_id="000000000000"

export AWS_ENDPOINT_URL="${aws_endpoint}"
export AWS_REGION="${aws_region}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export COMPOSE_AWS_ENDPOINT_URL="${COMPOSE_AWS_ENDPOINT_URL:-http://floci:4566}"

mkdir -p "${artifact_dir}"
cp .zap/rules.tsv "${artifact_dir}/zap-rules.tsv"
printf '%s\n' "${target_url}" > "${artifact_dir}/zap-target-url.txt"

aws_floci() {
  aws --endpoint-url "${aws_endpoint}" --region "${aws_region}" "$@"
}

docker compose -p "${compose_project}" up -d --wait postgres redis floci
docker compose -p "${compose_project}" up -d --force-recreate compose-init
docker compose -p "${compose_project}" wait compose-init

docker rm -f "${api_container}" >/dev/null 2>&1 || true
docker run -d \
  --name "${api_container}" \
  --network "${network_name}" \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e AWS_ENDPOINT=http://floci:4566 \
  -e AWS_REGION="${aws_region}" \
  -e DB_PASSWORD_SECRET_ID=expenseflow/local/db-password \
  -e JWT_SIGNING_KEYS_SECRET_ID=expenseflow/local/jwt-signing-keys \
  -e DATABASE_URI=postgres://expenseflow@postgres:5432/expenseflow \
  -e REDIS_URL=redis://redis:6379 \
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
  "${image_ref}" >/dev/null

for attempt in $(seq 1 30); do
  if docker run --rm --network "${network_name}" "${curl_image}" \
    -fsS "http://${api_container}:3000/health" >/dev/null; then
    break
  fi

  if [ "${attempt}" -eq 30 ]; then
    docker logs "${api_container}" >&2 || true
    echo "ExpenseFlow API container did not become healthy for DAST."
    exit 1
  fi

  sleep 2
done

vpc_id="$(aws_floci ec2 create-vpc \
  --cidr-block 10.26.0.0/16 \
  --query 'Vpc.VpcId' \
  --output text 2>/dev/null || true)"
if [ -z "${vpc_id}" ] || [ "${vpc_id}" = "None" ]; then
  vpc_id="$(aws_floci ec2 describe-vpcs --query 'Vpcs[0].VpcId' --output text)"
fi

subnet_a="$(aws_floci ec2 create-subnet \
  --vpc-id "${vpc_id}" \
  --cidr-block 10.26.1.0/24 \
  --availability-zone "${aws_region}a" \
  --query 'Subnet.SubnetId' \
  --output text 2>/dev/null || true)"
subnet_b="$(aws_floci ec2 create-subnet \
  --vpc-id "${vpc_id}" \
  --cidr-block 10.26.2.0/24 \
  --availability-zone "${aws_region}b" \
  --query 'Subnet.SubnetId' \
  --output text 2>/dev/null || true)"
if [ -z "${subnet_a}" ] || [ "${subnet_a}" = "None" ]; then
  subnet_a="$(aws_floci ec2 describe-subnets --query 'Subnets[0].SubnetId' --output text)"
fi
if [ -z "${subnet_b}" ] || [ "${subnet_b}" = "None" ]; then
  subnet_b="$(aws_floci ec2 describe-subnets --query 'Subnets[1].SubnetId' --output text)"
fi

security_group_id="$(aws_floci ec2 create-security-group \
  --group-name expenseflow-dast-alb \
  --description "Synthetic floci ALB security group for DAST" \
  --vpc-id "${vpc_id}" \
  --query 'GroupId' \
  --output text 2>/dev/null || true)"
if [ -z "${security_group_id}" ] || [ "${security_group_id}" = "None" ]; then
  security_group_id="$(aws_floci ec2 describe-security-groups \
    --filters Name=group-name,Values=expenseflow-dast-alb \
    --query 'SecurityGroups[0].GroupId' \
    --output text)"
fi

load_balancer_arn="$(aws_floci elbv2 create-load-balancer \
  --name expenseflow-dast-alb \
  --subnets "${subnet_a}" "${subnet_b}" \
  --security-groups "${security_group_id}" \
  --scheme internet-facing \
  --type application \
  --query 'LoadBalancers[0].LoadBalancerArn' \
  --output text 2>/dev/null || true)"
if [ -z "${load_balancer_arn}" ] || [ "${load_balancer_arn}" = "None" ]; then
  load_balancer_arn="$(aws_floci elbv2 describe-load-balancers \
    --names expenseflow-dast-alb \
    --query 'LoadBalancers[0].LoadBalancerArn' \
    --output text)"
fi

target_group_arn="$(aws_floci elbv2 create-target-group \
  --name expenseflow-dast-api-tg \
  --protocol HTTP \
  --port 3000 \
  --vpc-id "${vpc_id}" \
  --target-type ip \
  --health-check-protocol HTTP \
  --health-check-port traffic-port \
  --health-check-path /health \
  --matcher HttpCode=200 \
  --query 'TargetGroups[0].TargetGroupArn' \
  --output text 2>/dev/null || true)"
if [ -z "${target_group_arn}" ] || [ "${target_group_arn}" = "None" ]; then
  target_group_arn="$(aws_floci elbv2 describe-target-groups \
    --names expenseflow-dast-api-tg \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text)"
fi

listener_arn="$(aws_floci elbv2 describe-listeners \
  --load-balancer-arn "${load_balancer_arn}" \
  --query 'Listeners[0].ListenerArn' \
  --output text 2>/dev/null || true)"
if [ -z "${listener_arn}" ] || [ "${listener_arn}" = "None" ]; then
  aws_floci elbv2 create-listener \
    --load-balancer-arn "${load_balancer_arn}" \
    --protocol HTTP \
    --port 80 \
    --default-actions "Type=forward,TargetGroupArn=${target_group_arn}" >/dev/null
fi

api_ip="$(docker inspect -f "{{with index .NetworkSettings.Networks \"${network_name}\"}}{{.IPAddress}}{{end}}" "${api_container}")"
if [ -z "${api_ip}" ]; then
  api_ip="$(docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" "${api_container}")"
fi

aws_floci elbv2 register-targets \
  --target-group-arn "${target_group_arn}" \
  --targets "Id=${api_ip},Port=3000" >/dev/null 2>&1 || true

for attempt in $(seq 1 30); do
  if docker run --rm --network "${network_name}" "${curl_image}" -fsS "${target_url}" \
    | tee "${artifact_dir}/zap-target-curl.json" >/dev/null; then
    break
  fi

  if [ "${attempt}" -eq 30 ]; then
    echo "DAST target did not answer before ZAP scan: ${target_url}"
    exit 1
  fi

  sleep 2
done

set +e
docker run --rm \
  --network "${network_name}" \
  -v "$(pwd)/${artifact_dir}:/zap/wrk:rw" \
  "${zap_image}" zap-baseline.py \
    -t "${target_url}" \
    -c zap-rules.tsv \
    -m 1 \
    -T 5 \
    -r zap-baseline.html \
    -J zap-baseline.json
zap_status="$?"
set -e

ZAP_STATUS="${zap_status}" node <<'NODE'
const fs = require("node:fs");
const reportPath = "artifacts/security/zap-baseline.json";
const zapStatus = Number(process.env.ZAP_STATUS);

if (!fs.existsSync(reportPath)) {
  console.error(`Missing ZAP JSON report: ${reportPath}`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const alerts = (report.site || []).flatMap((site) => site.alerts || []);
const mediumOrAbove = alerts.filter((alert) => Number(alert.riskcode) >= 2);

if (mediumOrAbove.length > 0) {
  console.error("OWASP ZAP reported Medium-or-above alerts:");
  for (const alert of mediumOrAbove) {
    console.error(`- ${alert.pluginid} ${alert.riskdesc}: ${alert.alert}`);
  }
  process.exit(1);
}

if (zapStatus === 1 || zapStatus === 3) {
  console.error(`OWASP ZAP baseline failed with exit code ${zapStatus}.`);
  process.exit(zapStatus);
}

if (zapStatus === 2) {
  console.error("OWASP ZAP reported WARN alerts. Add an explicit INFO/FAIL disposition in .zap/rules.tsv.");
  process.exit(2);
}

console.log(`OWASP ZAP baseline passed: ${alerts.length} alert(s), 0 Medium-or-above.`);
NODE

printf 'DAST target: %s\n' "${target_url}"
