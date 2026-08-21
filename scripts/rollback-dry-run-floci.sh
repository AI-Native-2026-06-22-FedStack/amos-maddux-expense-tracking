#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${ARTIFACT_DIR:-artifacts/terraform}"
aws_region="${AWS_REGION:-us-east-1}"
aws_endpoint_url="${AWS_ENDPOINT_URL:-http://localhost:4566}"
stack_name="${STACK_NAME:-expenseflow}"
run_id="${ROLLBACK_DRY_RUN_ID:-$(date -u +%Y%m%d%H%M%S)}"
resource_prefix="${ROLLBACK_DRY_RUN_PREFIX:-ef-bg-${run_id}}"
description_prefix="${stack_name}-rollback-dry-run-${run_id}"

mkdir -p "${artifact_dir}"

aws_floci() {
  aws --endpoint-url "${aws_endpoint_url}" --region "${aws_region}" "$@"
}

write_json() {
  local name="$1"
  shift
  "$@" >"${artifact_dir}/${name}.json"
}

echo "Creating synthetic blue/green rollback dry-run resources in floci: ${description_prefix}"

vpc_id="$(aws_floci ec2 create-vpc \
  --cidr-block 10.250.0.0/16 \
  --query 'Vpc.VpcId' \
  --output text)"

subnet_a="$(aws_floci ec2 create-subnet \
  --vpc-id "${vpc_id}" \
  --cidr-block 10.250.1.0/24 \
  --availability-zone "${aws_region}a" \
  --query 'Subnet.SubnetId' \
  --output text)"

subnet_b="$(aws_floci ec2 create-subnet \
  --vpc-id "${vpc_id}" \
  --cidr-block 10.250.2.0/24 \
  --availability-zone "${aws_region}b" \
  --query 'Subnet.SubnetId' \
  --output text)"

security_group_id="$(aws_floci ec2 create-security-group \
  --group-name "${resource_prefix}-alb-sg" \
  --description "Synthetic floci ALB security group for rollback dry-run" \
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

blue_target_group_arn="$(aws_floci elbv2 create-target-group \
  --name "${resource_prefix}-blue" \
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

green_target_group_arn="$(aws_floci elbv2 create-target-group \
  --name "${resource_prefix}-green" \
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

listener_arn="$(aws_floci elbv2 create-listener \
  --load-balancer-arn "${load_balancer_arn}" \
  --protocol HTTP \
  --port 80 \
  --default-actions Type=fixed-response,FixedResponseConfig='{StatusCode=404,ContentType=text/plain,MessageBody=not_found}' \
  --query 'Listeners[0].ListenerArn' \
  --output text)"

rule_arn="$(aws_floci elbv2 create-rule \
  --listener-arn "${listener_arn}" \
  --priority 100 \
  --conditions Field=path-pattern,Values='/*' \
  --actions Type=forward,TargetGroupArn="${blue_target_group_arn}" \
  --query 'Rules[0].RuleArn' \
  --output text)"

write_json "rollback-dry-run-target-groups-before" \
  aws_floci elbv2 describe-target-groups \
  --target-group-arns "${blue_target_group_arn}" "${green_target_group_arn}"

write_json "rollback-dry-run-rule-serving-blue" \
  aws_floci elbv2 describe-rules \
  --rule-arns "${rule_arn}"

aws_floci elbv2 modify-rule \
  --rule-arn "${rule_arn}" \
  --actions Type=forward,TargetGroupArn="${green_target_group_arn}" >/dev/null

write_json "rollback-dry-run-rule-serving-green" \
  aws_floci elbv2 describe-rules \
  --rule-arns "${rule_arn}"

aws_floci elbv2 modify-rule \
  --rule-arn "${rule_arn}" \
  --actions Type=forward,TargetGroupArn="${blue_target_group_arn}" >/dev/null

write_json "rollback-dry-run-rule-rolled-back-blue" \
  aws_floci elbv2 describe-rules \
  --rule-arns "${rule_arn}"

cat >"${artifact_dir}/rollback-dry-run-summary.txt" <<EOF
run_id=${run_id}
resource_prefix=${resource_prefix}
load_balancer_arn=${load_balancer_arn}
listener_arn=${listener_arn}
production_rule_arn=${rule_arn}
blue_target_group_arn=${blue_target_group_arn}
green_target_group_arn=${green_target_group_arn}
health_check_path=/health
traffic_shift_shape=all-at-once listener rule switch
rollback_action=modify-rule from green target group back to blue target group
EOF

echo "Rollback dry-run complete."
echo "Evidence:"
echo "  ${artifact_dir}/rollback-dry-run-summary.txt"
echo "  ${artifact_dir}/rollback-dry-run-target-groups-before.json"
echo "  ${artifact_dir}/rollback-dry-run-rule-serving-blue.json"
echo "  ${artifact_dir}/rollback-dry-run-rule-serving-green.json"
echo "  ${artifact_dir}/rollback-dry-run-rule-rolled-back-blue.json"
