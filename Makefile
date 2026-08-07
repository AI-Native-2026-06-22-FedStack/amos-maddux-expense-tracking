SHELL := /bin/sh

export AWS_ENDPOINT_URL ?= http://localhost:4566
export AWS_ENDPOINT ?= $(AWS_ENDPOINT_URL)
export AWS_REGION ?= us-east-1
export AWS_ACCESS_KEY_ID ?= test
export AWS_SECRET_ACCESS_KEY ?= test
export COMPOSE_AWS_ENDPOINT_URL ?= http://floci:4566
export COMPOSE_DATABASE_URI ?= postgres://expenseflow:synthetic-compose-db-password@localhost:5433/expenseflow
export COMPOSE_CORE_URL ?= http://localhost:3000

.PHONY: up down seed test sync lint type check python-test python-check

up: seed
	docker compose up -d --wait --remove-orphans

down:
	docker compose --profile brownfield down --volumes --remove-orphans

seed:
	./scripts/seed.sh

test: up
	AWS_ENDPOINT_URL="$(AWS_ENDPOINT_URL)" \
	AWS_ENDPOINT="$(AWS_ENDPOINT)" \
	AWS_REGION="$(AWS_REGION)" \
	AWS_ACCESS_KEY_ID="$(AWS_ACCESS_KEY_ID)" \
	AWS_SECRET_ACCESS_KEY="$(AWS_SECRET_ACCESS_KEY)" \
	COMPOSE_DATABASE_URI="$(COMPOSE_DATABASE_URI)" \
	COMPOSE_CORE_URL="$(COMPOSE_CORE_URL)" \
	npm run compose:verify-submit-slice

sync:
	uv sync

lint: sync
	uv run ruff check src tests

type: sync
	uv run mypy src

python-test: sync
	uv run pytest

python-check: sync
	uv run ruff check src tests
	uv run mypy src
	uv run pytest

check: python-check
