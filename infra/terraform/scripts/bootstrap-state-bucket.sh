#!/usr/bin/env sh
set -eu

bucket_name="${TF_STATE_BUCKET:-expenseflow-terraform-state-floci}"
aws_region="${AWS_REGION:-us-east-1}"
aws_endpoint_url="${AWS_ENDPOINT_URL:-http://localhost:4566}"

aws_floci() {
  AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}" \
    AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}" \
    aws --endpoint-url "$aws_endpoint_url" --region "$aws_region" "$@"
}

if ! aws_floci s3api head-bucket --bucket "$bucket_name" >/dev/null 2>&1; then
  aws_floci s3api create-bucket --bucket "$bucket_name" >/dev/null
fi

aws_floci s3api put-public-access-block \
  --bucket "$bucket_name" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null

aws_floci s3api put-bucket-versioning \
  --bucket "$bucket_name" \
  --versioning-configuration Status=Enabled >/dev/null

aws_floci s3api put-bucket-encryption \
  --bucket "$bucket_name" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null

printf 'Terraform state bucket is ready on floci: %s\n' "$bucket_name"
