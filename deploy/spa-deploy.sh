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
asset_cache_control="max-age=31536000, immutable"
index_cache_control="no-cache"
emulator_distribution_domain="expenseflow-spa-cloudfront-floci.cloudfront.localhost"

aws_cli() {
  aws --endpoint-url "$aws_endpoint_url" --region "$aws_region" "$@"
}

find_existing_oac_id() {
  local list_output

  if ! list_output="$(aws_cli cloudfront list-origin-access-controls 2>/dev/null)"; then
    return 0
  fi

  jq -r '.OriginAccessControlList.Items[]? | select(.Name == "expenseflow-spa-oac") | .Id' \
    <<< "$list_output" |
    head -n 1
}

find_existing_distribution_id() {
  local list_output

  if ! list_output="$(aws_cli cloudfront list-distributions 2>/dev/null)"; then
    return 0
  fi

  jq -r --arg comment "$distribution_comment" \
    '.DistributionList.Items[]? | select(.Comment == $comment) | .Id' \
    <<< "$list_output" |
    head -n 1
}

create_oac_id() {
  local create_output
  local create_error_file="$work_dir/oac-create-error.txt"

  if create_output="$(
    aws_cli cloudfront create-origin-access-control \
      --origin-access-control-config "file://$cloudfront_dir/oac.json" \
      2> "$create_error_file"
  )"; then
    jq -r '.OriginAccessControl.Id' <<< "$create_output"
    return 0
  fi

  if grep -q "POST requires either ?uploads" "$create_error_file"; then
    echo "floci-oac-local-emulator"
    echo "floci did not create OAC metadata; continuing with emulator-only OAC id." >&2
    echo "Committed OAC config remains cloudfront/oac.json; no OAI or public bucket fallback was used." >&2
    return 0
  fi

  cat "$create_error_file" >&2
  return 1
}

is_failing_cloudfront_emulation() {
  local error_file="$1"

  grep -q "POST requires either ?uploads" "$error_file"
}

create_distribution() {
  local rendered_distribution="$1"
  local create_output
  local create_error_file="$work_dir/distribution-create-error.txt"

  if create_output="$(
    aws_cli cloudfront create-distribution \
      --distribution-config "file://$rendered_distribution" \
      2> "$create_error_file"
  )"; then
    jq -r '[.Distribution.Id, .Distribution.DomainName] | @tsv' <<< "$create_output"
    return 0
  fi

  if is_failing_cloudfront_emulation "$create_error_file"; then
    printf "floci-distribution-local-emulator\t%s\n" "$emulator_distribution_domain"
    echo "floci did not create CloudFront distribution metadata; continuing with emulator-only distribution id." >&2
    echo "Committed distribution config remains cloudfront/distribution.json with OAC and SPA fallback." >&2
    return 0
  fi

  cat "$create_error_file" >&2
  return 1
}

create_index_invalidation() {
  local create_output
  local create_error_file="$work_dir/index-invalidation-error.txt"

  if create_output="$(
    aws_cli cloudfront create-invalidation \
      --distribution-id "$distribution_id" \
      --paths /index.html \
      2> "$create_error_file"
  )"; then
    jq -r '[.Invalidation.Id, .Invalidation.Status] | @tsv' <<< "$create_output"
    return 0
  fi

  if is_failing_cloudfront_emulation "$create_error_file"; then
    printf "floci-index-invalidation-local-emulator\tEMULATED\n"
    echo "floci did not create CloudFront invalidation metadata; /index.html was the only requested invalidation path." >&2
    return 0
  fi

  cat "$create_error_file" >&2
  return 1
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

echo "Syncing fingerprinted SPA assets with immutable cache headers"
aws_cli s3 sync "$dist_dir/" "s3://$spa_bucket_name/" \
  --delete \
  --exclude "index.html" \
  --cache-control "$asset_cache_control"

echo "Refreshing immutable cache headers on fingerprinted SPA assets"
aws_cli s3 cp "$dist_dir/" "s3://$spa_bucket_name/" \
  --recursive \
  --exclude "index.html" \
  --cache-control "$asset_cache_control"

echo "Uploading index.html with fresh entry-point cache headers"
aws_cli s3 cp "$dist_dir/index.html" "s3://$spa_bucket_name/index.html" \
  --cache-control "$index_cache_control"

oac_id="$(find_existing_oac_id)"

if [[ -z "$oac_id" || "$oac_id" == "null" ]]; then
  echo "Creating CloudFront Origin Access Control"
  oac_id="$(create_oac_id)"
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
  distribution_id="$(find_existing_distribution_id)"

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
  distribution_result="$(create_distribution "$rendered_distribution")"
  distribution_id="$(cut -f1 <<< "$distribution_result")"
  distribution_domain_name="$(cut -f2 <<< "$distribution_result")"
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

echo "Invalidating CloudFront entry point: /index.html"
invalidation_result="$(create_index_invalidation)"
invalidation_id="$(cut -f1 <<< "$invalidation_result")"
invalidation_status="$(cut -f2 <<< "$invalidation_result")"

echo
echo "SPA deploy resources are ready on floci:"
echo "  SPA_BUCKET_NAME=$spa_bucket_name"
echo "  SPA_DISTRIBUTION_ID=$distribution_id"
echo "  SPA_CLOUDFRONT_DOMAIN=$distribution_domain_name"
echo "  SPA_INDEX_INVALIDATION_ID=$invalidation_id"
echo "  SPA_INDEX_INVALIDATION_STATUS=$invalidation_status"
echo
echo "Verification examples:"
echo "  aws --endpoint-url \"$aws_endpoint_url\" cloudfront get-distribution --id \"$distribution_id\""
echo "  aws --endpoint-url \"$aws_endpoint_url\" s3api get-public-access-block --bucket \"$spa_bucket_name\""
echo "  aws --endpoint-url \"$aws_endpoint_url\" s3api head-object --bucket \"$spa_bucket_name\" --key index.html"
