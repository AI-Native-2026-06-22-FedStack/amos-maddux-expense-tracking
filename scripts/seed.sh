#!/usr/bin/env sh
set -eu

export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
export AWS_ENDPOINT="${AWS_ENDPOINT:-$AWS_ENDPOINT_URL}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export COMPOSE_AWS_ENDPOINT_URL="${COMPOSE_AWS_ENDPOINT_URL:-http://floci:4566}"

docker compose up -d --wait postgres floci
docker compose up -d --force-recreate compose-init
docker compose wait compose-init
