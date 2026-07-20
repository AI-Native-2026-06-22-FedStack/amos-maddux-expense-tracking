.PHONY: sync check lint type test

sync:
	uv sync

lint: sync
	uv run ruff check app tests

type: sync
	uv run mypy app

test: sync
	uv run pytest

check: sync
	uv run ruff check app tests
	uv run mypy app
	uv run pytest
