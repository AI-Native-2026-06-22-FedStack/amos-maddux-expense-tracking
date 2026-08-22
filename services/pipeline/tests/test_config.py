"""Unit tests for services/pipeline/config.py: the one place DATABASE_URI
and the analytics schema name are read from, so they are not scattered as
string literals across the pipeline's persistence-boundary code.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import DEFAULT_ANALYTICS_SCHEMA, load_pipeline_db_config  # noqa: E402


def test_load_pipeline_db_config_uses_database_uri_and_default_schema(monkeypatch):
    monkeypatch.setenv("DATABASE_URI", "postgres://user@host:5432/db")
    monkeypatch.delenv("PIPELINE_ANALYTICS_SCHEMA", raising=False)

    config = load_pipeline_db_config()

    assert config.database_uri == "postgres://user@host:5432/db"
    assert config.analytics_schema == DEFAULT_ANALYTICS_SCHEMA


def test_load_pipeline_db_config_honors_configured_schema_override(monkeypatch):
    monkeypatch.setenv("DATABASE_URI", "postgres://user@host:5432/db")
    monkeypatch.setenv("PIPELINE_ANALYTICS_SCHEMA", "custom_pipeline_schema")

    config = load_pipeline_db_config()

    assert config.analytics_schema == "custom_pipeline_schema"


def test_load_pipeline_db_config_requires_database_uri(monkeypatch):
    monkeypatch.delenv("DATABASE_URI", raising=False)

    with pytest.raises(RuntimeError, match="DATABASE_URI"):
        load_pipeline_db_config()


def test_load_pipeline_db_config_rejects_blank_database_uri(monkeypatch):
    monkeypatch.setenv("DATABASE_URI", "   ")

    with pytest.raises(RuntimeError, match="DATABASE_URI"):
        load_pipeline_db_config()


def test_load_pipeline_db_config_rejects_blank_schema_override(monkeypatch):
    monkeypatch.setenv("DATABASE_URI", "postgres://user@host:5432/db")
    monkeypatch.setenv("PIPELINE_ANALYTICS_SCHEMA", "   ")

    with pytest.raises(RuntimeError, match="PIPELINE_ANALYTICS_SCHEMA"):
        load_pipeline_db_config()
