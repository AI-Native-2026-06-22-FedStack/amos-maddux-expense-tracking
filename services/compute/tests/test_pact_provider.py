import importlib
import os
import socket
import threading
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
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


def test_provider_satisfies_core_gl_coding_pact_from_broker() -> None:
    broker_url = os.getenv("PACT_BROKER_BASE_URL", PACT_BROKER_BASE_URL)
    provider_version = os.getenv("PACT_PROVIDER_VERSION", PACT_PROVIDER_VERSION)
    provider_branch = os.getenv("PACT_PROVIDER_BRANCH", PACT_PROVIDER_BRANCH)

    with running_compute_provider() as provider_url:
        verifier = (
            Verifier(PROVIDER_NAME, host="127.0.0.1")
            .add_transport(url=provider_url)
            .broker_source(broker_url)
            .filter_consumers(CONSUMER_NAME)
            .add_custom_header("authorization", f"Bearer {mint_test_access_token()}")
            .set_publish_options(version=provider_version, branch=provider_branch)
            .set_error_on_empty_pact(enabled=True)
            .state_handler(
                {
                    "a tenant has a valid Meals GL-coding category": lambda: None,
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
    main.app.dependency_overrides[main.get_db_session] = FakeDbSession
    return main


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


class FakeCursor:
    def execute(self, query: str, params: dict[str, object]) -> object:
        return None

    def fetchall(self) -> list[tuple[object, ...]]:
        return []


class FakeCursorContext:
    def __enter__(self) -> FakeCursor:
        return FakeCursor()

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None


class FakeDbSession:
    def cursor(self) -> FakeCursorContext:
        return FakeCursorContext()
