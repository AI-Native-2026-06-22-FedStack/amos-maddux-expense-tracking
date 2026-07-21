import importlib
import os
import socket
import threading
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from types import ModuleType

import httpx
from pact import Verifier
from uvicorn import Config, Server

from tests.token_helpers import (
    TEST_JWT_AUDIENCE,
    TEST_JWT_ISSUER,
    TEST_JWT_KEY_ID,
    TEST_JWT_PUBLIC_KEY_PEM,
    mint_test_access_token,
)

CONSUMER_NAME = "ExpenseFlow Core Case Service"
PROVIDER_NAME = "ExpenseFlow Domain Compute GL Coding"
PACT_BROKER_BASE_URL = "http://localhost:9292"
PACT_PROVIDER_VERSION = "0.1.0-local"
PACT_PROVIDER_BRANCH = "local"
PACT_TENANT_ID = "00000000-0000-4000-8000-000000000501"
PACT_MEALS_GL_CODE_ID = "00000000-0000-4000-8000-000000000601"
COMPUTE_ROOT = Path(__file__).resolve().parents[1]
GL_REFERENCE_MIGRATION = COMPUTE_ROOT / "db/migrations/0001_gl_coding_reference.sql"


def test_provider_satisfies_core_gl_coding_pact_from_broker() -> None:
    broker_url = os.getenv("PACT_BROKER_BASE_URL", PACT_BROKER_BASE_URL)
    provider_version = os.getenv("PACT_PROVIDER_VERSION", PACT_PROVIDER_VERSION)
    provider_branch = os.getenv("PACT_PROVIDER_BRANCH", PACT_PROVIDER_BRANCH)
    database_uri = require_database_uri()

    with pact_gl_reference_data(database_uri), running_compute_provider() as provider_url:
        verifier = (
            Verifier(PROVIDER_NAME, host="127.0.0.1")
            .add_transport(url=provider_url)
            .broker_source(broker_url)
            .filter_consumers(CONSUMER_NAME)
            .add_custom_header(
                "authorization",
                f"Bearer {mint_test_access_token(tenant_id=PACT_TENANT_ID)}",
            )
            .set_publish_options(version=provider_version, branch=provider_branch)
            .set_error_on_empty_pact(enabled=True)
            .state_handler(
                {
                    "a tenant has a valid Meals GL-coding category": lambda: seed_meals_mapping(
                        database_uri
                    ),
                    "a tenant has no Supplies GL-coding category": lambda: clear_supplies_mapping(
                        database_uri
                    ),
                    "": lambda: None,
                }
            )
        )

        verifier.verify()


@contextmanager
def running_compute_provider() -> Iterator[str]:
    main = load_compute_app_with_test_dependencies()
    port = find_free_port()
    server = Server(
        Config(
            app=main.app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
            access_log=False,
        )
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    provider_url = f"http://127.0.0.1:{port}"
    wait_until_ready(provider_url)

    try:
        yield provider_url
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        main.app.dependency_overrides.clear()


def load_compute_app_with_test_dependencies() -> ModuleType:
    os.environ["JWT_PUBLIC_KEY_PEM"] = TEST_JWT_PUBLIC_KEY_PEM
    os.environ["JWT_KEY_ID"] = TEST_JWT_KEY_ID
    os.environ["JWT_ISSUER"] = TEST_JWT_ISSUER
    os.environ["JWT_AUDIENCE"] = TEST_JWT_AUDIENCE
    os.environ["MILEAGE_REIMBURSEMENT_RATE"] = "0.67"

    import app.auth
    import app.main

    importlib.reload(app.auth)
    main = importlib.reload(app.main)
    return main


def require_database_uri() -> str:
    database_uri = os.getenv("DATABASE_URI")
    if database_uri is None or database_uri.strip() == "":
        raise RuntimeError("DATABASE_URI is required for Pact provider verification.")

    return database_uri


@contextmanager
def pact_gl_reference_data(database_uri: str) -> Iterator[None]:
    ensure_gl_reference_schema(database_uri)
    cleanup_pact_tenant_gl_reference_data(database_uri)

    try:
        yield
    finally:
        cleanup_pact_tenant_gl_reference_data(database_uri)


def ensure_gl_reference_schema(database_uri: str) -> None:
    import psycopg

    with psycopg.connect(database_uri) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "select to_regclass('public.gl_code'), to_regclass('public.gl_mapping')"
            )
            gl_code_table, gl_mapping_table = cursor.fetchone()

            if gl_code_table is not None and gl_mapping_table is not None:
                return

            if gl_code_table is not None or gl_mapping_table is not None:
                raise RuntimeError("Compute GL reference schema is partially applied.")

            cursor.execute(GL_REFERENCE_MIGRATION.read_text(encoding="utf-8"))


def seed_meals_mapping(database_uri: str) -> None:
    import psycopg

    with psycopg.connect(database_uri) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                with upsert_code as (
                    insert into gl_code (
                        id,
                        tenant_id,
                        account_code,
                        account_name,
                        normal_balance,
                        active
                    )
                    values (
                        %(gl_code_id)s::uuid,
                        %(tenant_id)s::uuid,
                        '6100',
                        'Synthetic Meals Expense',
                        'debit',
                        true
                    )
                    on conflict (tenant_id, account_code) do update
                    set
                        account_name = excluded.account_name,
                        normal_balance = excluded.normal_balance,
                        active = true,
                        updated_at = now()
                    returning id, tenant_id
                )
                insert into gl_mapping (
                    tenant_id,
                    category,
                    gl_code_id
                )
                select tenant_id, 'Meals', id
                from upsert_code
                on conflict (tenant_id, category) do update
                set
                    gl_code_id = excluded.gl_code_id,
                    updated_at = now()
                """,
                {"tenant_id": PACT_TENANT_ID, "gl_code_id": PACT_MEALS_GL_CODE_ID},
            )


def clear_supplies_mapping(database_uri: str) -> None:
    import psycopg

    with psycopg.connect(database_uri) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                delete from gl_mapping
                where tenant_id = %(tenant_id)s::uuid
                    and category = 'Supplies'
                """,
                {"tenant_id": PACT_TENANT_ID},
            )


def cleanup_pact_tenant_gl_reference_data(database_uri: str) -> None:
    import psycopg

    with psycopg.connect(database_uri) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                delete from gl_mapping
                where tenant_id = %(tenant_id)s::uuid
                    and category in ('Meals', 'Supplies')
                """,
                {"tenant_id": PACT_TENANT_ID},
            )
            cursor.execute(
                """
                delete from gl_code
                where tenant_id = %(tenant_id)s::uuid
                    and account_code in ('6100', '6400')
                """,
                {"tenant_id": PACT_TENANT_ID},
            )


def wait_until_ready(provider_url: str) -> None:
    deadline = time.monotonic() + 10
    last_error: Exception | None = None

    while time.monotonic() < deadline:
        try:
            response = httpx.get(f"{provider_url}/health", timeout=0.5)
            if response.status_code == 200:
                return
        except Exception as exc:
            last_error = exc

        time.sleep(0.05)

    raise RuntimeError(f"Compute provider did not become ready: {last_error}")


def find_free_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])
