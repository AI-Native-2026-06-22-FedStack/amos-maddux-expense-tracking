#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist_dir="$repo_root/apps/web/dist"
cloudfront_dir="$repo_root/cloudfront"
work_dir="${TMPDIR:-/tmp}/expenseflow-spa-deploy"

aws_endpoint_url="${AWS_ENDPOINT_URL:-http://localhost:4566}"
aws_region="${AWS_REGION:-us-east-1}"
aws_account_id="${AWS_ACCOUNT_ID:-000000000000}"
spa_bucket_name="${SPA_BUCKET_NAME:-expenseflow-spa-m7d5}"
distribution_comment="expenseflow-spa-cloudfront-floci"

aws_cli() {
  aws --endpoint-url "$aws_endpoint_url" --region "$aws_region" "$@"
}

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "Required file is missing: $1" >&2
    exit 1
  fi
}

require_file "$dist_dir/index.html"
require_file "$cloudfront_dir/oac.json"
require_file "$cloudfront_dir/distribution.json"
require_file "$cloudfront_dir/bucket-policy.json"

mkdir -p "$work_dir"

echo "Using floci endpoint: $aws_endpoint_url"
echo "Using private SPA bucket: $spa_bucket_name"

if aws_cli s3api head-bucket --bucket "$spa_bucket_name" >/dev/null 2>&1; then
  echo "Bucket already exists: $spa_bucket_name"
else
  echo "Creating private bucket: $spa_bucket_name"
  if [[ "$aws_region" == "us-east-1" ]]; then
    aws_cli s3api create-bucket --bucket "$spa_bucket_name" >/dev/null
  else
    aws_cli s3api create-bucket \
      --bucket "$spa_bucket_name" \
      --create-bucket-configuration "LocationConstraint=$aws_region" >/dev/null
  fi
fi

aws_cli s3api put-public-access-block \
  --bucket "$spa_bucket_name" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" >/dev/null

echo "Syncing existing SPA build from apps/web/dist"
aws_cli s3 sync "$dist_dir/" "s3://$spa_bucket_name/" --delete

oac_id="$(
  aws_cli cloudfront list-origin-access-controls 2>/dev/null |
    jq -r '.OriginAccessControlList.Items[]? | select(.Name == "expenseflow-spa-oac") | .Id' |
    head -n 1
)"

if [[ -z "$oac_id" || "$oac_id" == "null" ]]; then
  echo "Creating CloudFront Origin Access Control"
  oac_id="$(
    aws_cli cloudfront create-origin-access-control \
      --origin-access-control-config "file://$cloudfront_dir/oac.json" |
      jq -r '.OriginAccessControl.Id'
  )"
else
  echo "Reusing OAC: $oac_id"
fi

distribution_id="${SPA_DISTRIBUTION_ID:-}"
distribution_domain_name=""

if [[ -n "$distribution_id" ]]; then
  distribution_domain_name="$(
    aws_cli cloudfront get-distribution --id "$distribution_id" |
      jq -r '.Distribution.DomainName'
  )"
else
  distribution_id="$(
    aws_cli cloudfront list-distributions 2>/dev/null |
      jq -r --arg comment "$distribution_comment" \
        '.DistributionList.Items[]? | select(.Comment == $comment) | .Id' |
      head -n 1
  )"

  if [[ -n "$distribution_id" && "$distribution_id" != "null" ]]; then
    echo "Reusing distribution: $distribution_id"
    distribution_domain_name="$(
      aws_cli cloudfront get-distribution --id "$distribution_id" |
        jq -r '.Distribution.DomainName'
    )"
  fi
fi

if [[ -z "$distribution_id" || "$distribution_id" == "null" ]]; then
  rendered_distribution="$work_dir/distribution.json"
  caller_reference="expenseflow-spa-$(date +%Y%m%d%H%M%S)"

  jq \
    --arg callerReference "$caller_reference" \
    --arg bucketName "$spa_bucket_name" \
    --arg region "$aws_region" \
    --arg oacId "$oac_id" \
    '.CallerReference = $callerReference
      | .Origins.Items[0].DomainName = ($bucketName + ".s3." + $region + ".amazonaws.com")
      | .Origins.Items[0].OriginAccessControlId = $oacId' \
    "$cloudfront_dir/distribution.json" > "$rendered_distribution"

  echo "Creating CloudFront distribution with OAC-backed S3 origin"
  create_distribution_output="$(
    aws_cli cloudfront create-distribution \
      --distribution-config "file://$rendered_distribution"
  )"
  distribution_id="$(jq -r '.Distribution.Id' <<< "$create_distribution_output")"
  distribution_domain_name="$(jq -r '.Distribution.DomainName' <<< "$create_distribution_output")"
fi

rendered_bucket_policy="$work_dir/bucket-policy.json"
jq \
  --arg bucketName "$spa_bucket_name" \
  --arg accountId "$aws_account_id" \
  --arg distributionId "$distribution_id" \
  '(.Statement[0].Resource) = ("arn:aws:s3:::" + $bucketName + "/*")
    | (.Statement[0].Condition.StringEquals."AWS:SourceArn") =
      ("arn:aws:cloudfront::" + $accountId + ":distribution/" + $distributionId)' \
  "$cloudfront_dir/bucket-policy.json" > "$rendered_bucket_policy"

echo "Applying distribution-scoped bucket policy"
aws_cli s3api put-bucket-policy \
  --bucket "$spa_bucket_name" \
  --policy "file://$rendered_bucket_policy" >/dev/null

echo
echo "SPA deploy resources are ready on floci:"
echo "  SPA_BUCKET_NAME=$spa_bucket_name"
echo "  SPA_DISTRIBUTION_ID=$distribution_id"
echo "  SPA_CLOUDFRONT_DOMAIN=$distribution_domain_name"
echo
echo "Verification examples:"
echo "  aws --endpoint-url \"$aws_endpoint_url\" cloudfront get-distribution --id \"$distribution_id\""
echo "  aws --endpoint-url \"$aws_endpoint_url\" s3api get-public-access-block --bucket \"$spa_bucket_name\""
