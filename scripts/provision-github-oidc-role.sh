#!/usr/bin/env sh
# Creates or updates the no-permission IAM role used by the ADR-0024
# pull-request OIDC proof job, then stores its ARN as the GitHub repository
# variable consumed by .github/workflows/secure-pr.yml.
set -eu

AWS_PROFILE="${AWS_PROFILE:-expenseflow-smoke}"
AWS_REGION="${AWS_REGION:-us-east-1}"
EXPECTED_AWS_ACCOUNT_ID="${EXPECTED_AWS_ACCOUNT_ID:-208096650110}"
REPO="${REPO:-AI-Native-2026-06-22-FedStack/amos-maddux-expense-tracking}"
ROLE_NAME="${ROLE_NAME:-expenseflow-secure-pr-gate-oidc}"
PERMISSIONS_BOUNDARY_NAME="${PERMISSIONS_BOUNDARY_NAME:-TraineeSandboxBoundary}"
PERMISSIONS_BOUNDARY_ARN="${PERMISSIONS_BOUNDARY_ARN:-}"
SET_GITHUB_VARIABLE="${SET_GITHUB_VARIABLE:-true}"
export AWS_PROFILE

OIDC_PROVIDER_URL="token.actions.githubusercontent.com"
OIDC_AUDIENCE="sts.amazonaws.com"
OIDC_SUBJECT="repo:${REPO}:pull_request"

account_id="$(aws sts get-caller-identity \
  --region "$AWS_REGION" \
  --query Account \
  --output text)"

if [ "$account_id" != "$EXPECTED_AWS_ACCOUNT_ID" ]; then
  echo "Refusing to provision in AWS account ${account_id}; expected ${EXPECTED_AWS_ACCOUNT_ID}." >&2
  echo "Set EXPECTED_AWS_ACCOUNT_ID=${account_id} only if this is intentional." >&2
  exit 1
fi

oidc_provider_arn="arn:aws:iam::${account_id}:oidc-provider/${OIDC_PROVIDER_URL}"

if [ -z "$PERMISSIONS_BOUNDARY_ARN" ]; then
  PERMISSIONS_BOUNDARY_ARN="arn:aws:iam::${account_id}:policy/${PERMISSIONS_BOUNDARY_NAME}"
fi

aws iam get-open-id-connect-provider \
  --open-id-connect-provider-arn "$oidc_provider_arn" \
  --region "$AWS_REGION" \
  >/dev/null

trust_policy="$(mktemp "${TMPDIR:-/tmp}/expenseflow-github-oidc-trust.XXXXXX.json")"
trap 'rm -f "$trust_policy"' EXIT HUP INT TERM

cat >"$trust_policy" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "${oidc_provider_arn}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER_URL}:aud": "${OIDC_AUDIENCE}",
          "${OIDC_PROVIDER_URL}:sub": "${OIDC_SUBJECT}"
        }
      }
    }
  ]
}
EOF

if aws iam get-role --role-name "$ROLE_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document "file://${trust_policy}" \
    --region "$AWS_REGION" \
    >/dev/null
  echo "Updated trust policy for IAM role ${ROLE_NAME}."
else
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --description "No-permission GitHub Actions OIDC proof role for ExpenseFlow secure-pr pull_request runs." \
    --assume-role-policy-document "file://${trust_policy}" \
    --max-session-duration 3600 \
    --permissions-boundary "$PERMISSIONS_BOUNDARY_ARN" \
    --tags \
      "Key=Name,Value=${ROLE_NAME}" \
      "Key=Owner,Value=platform-iac@expenseflow.internal" \
      "Key=Environment,Value=github-pr-gate" \
    --region "$AWS_REGION" \
    >/dev/null
  echo "Created IAM role ${ROLE_NAME}."
fi

permissions_boundary_arn="$(aws iam get-role \
  --role-name "$ROLE_NAME" \
  --region "$AWS_REGION" \
  --query 'Role.PermissionsBoundary.PermissionsBoundaryArn' \
  --output text)"

if [ "$permissions_boundary_arn" != "$PERMISSIONS_BOUNDARY_ARN" ]; then
  echo "Warning: ${ROLE_NAME} permissions boundary is ${permissions_boundary_arn}; expected ${PERMISSIONS_BOUNDARY_ARN}." >&2
fi

attached_policy_count="$(aws iam list-attached-role-policies \
  --role-name "$ROLE_NAME" \
  --region "$AWS_REGION" \
  --query 'length(AttachedPolicies)' \
  --output text)"

inline_policy_count="$(aws iam list-role-policies \
  --role-name "$ROLE_NAME" \
  --region "$AWS_REGION" \
  --query 'length(PolicyNames)' \
  --output text)"

if [ "$attached_policy_count" != "0" ] || [ "$inline_policy_count" != "0" ]; then
  echo "Warning: ${ROLE_NAME} has ${attached_policy_count} attached and ${inline_policy_count} inline policies." >&2
  echo "The oidc-verify job only needs a trust policy; review those permissions before relying on this role." >&2
fi

role_arn="$(aws iam get-role \
  --role-name "$ROLE_NAME" \
  --region "$AWS_REGION" \
  --query 'Role.Arn' \
  --output text)"

echo "OIDC role ARN: ${role_arn}"

if [ "$SET_GITHUB_VARIABLE" = "true" ]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "GitHub CLI is not installed. Set the repository variable manually:" >&2
    echo "  gh variable set AWS_ROLE_ARN --repo ${REPO} --body ${role_arn}" >&2
    exit 1
  fi

  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    echo "GitHub CLI is not authenticated. After 'gh auth login', run:" >&2
    echo "  gh variable set AWS_ROLE_ARN --repo ${REPO} --body ${role_arn}" >&2
    exit 1
  fi

  gh variable set AWS_ROLE_ARN --repo "$REPO" --body "$role_arn"
  echo "Set AWS_ROLE_ARN repository variable for ${REPO}."
else
  echo "Skipped GitHub variable update because SET_GITHUB_VARIABLE=${SET_GITHUB_VARIABLE}."
fi
