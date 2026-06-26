.PHONY: sync check lint type test

sync:
	uv sync

lint: sync
	uv run ruff check src tests

type: sync
	uv run mypy src

test: sync
	uv run pytest

check: sync
	uv run ruff check src tests
	uv run mypy src
	uv run pytest
