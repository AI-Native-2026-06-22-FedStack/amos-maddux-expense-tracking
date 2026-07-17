import os
from pathlib import Path

import pytest

MIGRATION_SQL = Path("db/migrations/0001_gl_coding_reference.sql")
SEED_SQL = Path("db/seeds/0001_default_gl_mappings.sql")


def test_gl_reference_migration_creates_compute_owned_tables() -> None:
    sql = MIGRATION_SQL.read_text(encoding="utf-8")

    assert "create table gl_code" in sql
    assert "create table gl_mapping" in sql
    assert "tenant_id uuid not null" in sql
    assert "constraint gl_mapping_tenant_category_unique unique (tenant_id, category)" in sql
    assert "references gl_code (tenant_id, id)" in sql


def test_default_seed_loads_baseline_category_mappings() -> None:
    sql = SEED_SQL.read_text(encoding="utf-8")

    for category in ["Meals", "Lodging", "Mileage", "Supplies", "Other"]:
        assert f"'{category}'" in sql

    assert "on conflict (tenant_id, account_code) do update" in sql
    assert "on conflict (tenant_id, category) do update" in sql


@pytest.mark.skipif(
    os.getenv("DATABASE_URI") is None,
    reason="DATABASE_URI is required for PostgreSQL constraint verification.",
)
def test_duplicate_category_mapping_is_rejected_by_postgresql() -> None:
    psycopg = pytest.importorskip("psycopg")

    connection = psycopg.connect(os.environ["DATABASE_URI"])
    try:
        with connection:
            with connection.cursor() as cursor:
                cursor.execute(MIGRATION_SQL.read_text(encoding="utf-8"))
                cursor.execute(SEED_SQL.read_text(encoding="utf-8"))
                with pytest.raises(psycopg.errors.UniqueViolation):
                    cursor.execute(
                        """
                        insert into gl_mapping (
                            tenant_id,
                            category,
                            gl_code_id
                        )
                        select tenant_id, category, gl_code_id
                        from gl_mapping
                        where category = 'Meals'
                        limit 1
                        """
                    )
    finally:
        connection.close()
