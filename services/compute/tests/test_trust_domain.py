import importlib
import logging
from datetime import datetime, timedelta, timezone
from types import ModuleType
from typing import Callable
from uuid import UUID

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from tests.token_helpers import (
    TEST_JWT_AUDIENCE,
    TEST_JWT_ISSUER,
    TEST_JWT_KEY_ID,
    TEST_JWT_PRIVATE_KEY_PEM,
    TEST_JWT_PUBLIC_KEY_PEM,
    mint_test_access_token,
)


def test_node_shaped_rs256_token_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    auth = _load_auth_with_test_key(monkeypatch)
    token = mint_test_access_token(
        user_id="00000000-0000-4000-8000-000000000211",
        tenant_id="00000000-0000-4000-8000-000000000111",
        role="Employee",
    )

    current_user = auth.verify_token(token)

    assert current_user.user_id == "00000000-0000-4000-8000-000000000211"
    assert current_user.tenant_id == "00000000-0000-4000-8000-000000000111"
    assert current_user.role == "Employee"


def test_wrong_audience_token_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    auth = _load_auth_with_test_key(monkeypatch)
    token = mint_test_access_token(audience="synthetic-wrong-audience")

    # Temporarily removing the audience check should make this test fail.
    _assert_unauthorized(auth.verify_token, token)


def test_wrong_issuer_token_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    auth = _load_auth_with_test_key(monkeypatch)
    token = mint_test_access_token(issuer="synthetic-wrong-issuer")

    _assert_unauthorized(auth.verify_token, token)


def test_unknown_kid_token_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    auth = _load_auth_with_test_key(monkeypatch)
    token = mint_test_access_token(key_id="synthetic-unknown-key")

    _assert_unauthorized(auth.verify_token, token)


def test_malformed_token_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    auth = _load_auth_with_test_key(monkeypatch)

    _assert_unauthorized(auth.verify_token, "synthetic-malformed-token")


def test_missing_required_claim_token_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    auth = _load_auth_with_test_key(monkeypatch)
    token = _mint_token_without_roles()

    _assert_unauthorized(auth.verify_token, token)


def test_expired_token_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    auth = _load_auth_with_test_key(monkeypatch)
    token = mint_test_access_token(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))

    _assert_unauthorized(auth.verify_token, token)


def test_tampered_token_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    auth = _load_auth_with_test_key(monkeypatch)
    token = mint_test_access_token()
    header, payload, signature = token.split(".")
    tampered_token = ".".join([header, payload, _tamper_signature(signature)])

    _assert_unauthorized(auth.verify_token, tampered_token)


def test_health_route_is_public(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _load_test_client(monkeypatch)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_route_logs_incoming_correlation_id(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    client = _load_test_client(monkeypatch)

    response = client.get(
        "/health",
        headers={"X-Correlation-Id": "synthetic-cross-service-correlation-id"},
    )
    captured = capsys.readouterr()

    assert response.status_code == 200
    assert response.headers["X-Correlation-Id"] == "synthetic-cross-service-correlation-id"
    assert '"correlationId": "synthetic-cross-service-correlation-id"' in captured.out
    assert '"event": "request.completed"' in captured.out


def test_compute_disables_uvicorn_access_logs(monkeypatch: pytest.MonkeyPatch) -> None:
    _load_test_client(monkeypatch)

    assert logging.getLogger("uvicorn.access").disabled is True


def test_me_route_rejects_missing_authorization(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _load_test_client(monkeypatch)

    response = client.get("/me")

    assert response.status_code == 401


def test_me_route_rejects_invalid_token(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _load_test_client(monkeypatch)

    response = client.get("/me", headers={"Authorization": "Bearer synthetic-malformed-token"})

    assert response.status_code == 401


def test_me_route_returns_current_user_for_valid_token(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _load_test_client(monkeypatch)
    token = mint_test_access_token(
        user_id="00000000-0000-4000-8000-000000000212",
        tenant_id="00000000-0000-4000-8000-000000000112",
        role="Employee",
    )

    response = client.get("/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert response.json() == {
        "user_id": "00000000-0000-4000-8000-000000000212",
        "tenant_id": "00000000-0000-4000-8000-000000000112",
        "role": "Employee",
    }


def test_v1_coding_route_rejects_missing_authorization(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _load_test_client(monkeypatch)

    response = client.post("/v1/coding", json={"line_items": [], "mileage_entries": []})

    assert response.status_code == 401


def test_v1_coding_route_codes_with_authenticated_tenant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    main = _load_test_main(monkeypatch)
    main.app.dependency_overrides[main.get_db_session] = lambda: FakeDbSession(
        [
            (
                "Meals",
                UUID("00000000-0000-4000-8000-000000000301"),
                "6100",
                "Synthetic Meals Expense",
                "debit",
            )
        ]
    )
    monkeypatch.setenv("MILEAGE_REIMBURSEMENT_RATE", "0.67")
    client = TestClient(main.app)
    token = mint_test_access_token(
        user_id="00000000-0000-4000-8000-000000000212",
        tenant_id="00000000-0000-4000-8000-000000000112",
        role="Employee",
    )

    response = client.post(
        "/v1/coding",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "line_items": [
                {
                    "line_item_id": "00000000-0000-4000-8000-000000000101",
                    "amount": "500.01",
                    "currency": "USD",
                    "category": "Meals",
                },
                {
                    "line_item_id": "00000000-0000-4000-8000-000000000102",
                    "amount": "42.50",
                    "currency": "USD",
                    "category": "Supplies",
                },
            ],
            "mileage_entries": [],
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "coded_line_items": [
            {
                "status": "mapped",
                "line_item_id": "00000000-0000-4000-8000-000000000101",
                "category": "Meals",
                "gl_code_id": "00000000-0000-4000-8000-000000000301",
                "account_code": "6100",
                "account_name": "Synthetic Meals Expense",
                "normal_balance": "debit",
                "flagged": True,
            },
            {
                "status": "unmapped",
                "line_item_id": "00000000-0000-4000-8000-000000000102",
                "category": "Supplies",
                "unmapped_marker": "UNMAPPED_GL_CATEGORY",
                "flagged": False,
            },
        ],
        "coded_mileage_entries": [],
        "flagged_line_item": "00000000-0000-4000-8000-000000000101",
    }


def test_v1_coding_route_keeps_unknown_category_as_422(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    main = _load_test_main(monkeypatch)
    main.app.dependency_overrides[main.get_db_session] = lambda: FakeDbSession([])
    client = TestClient(main.app)
    token = mint_test_access_token()

    response = client.post(
        "/v1/coding",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "line_items": [
                {
                    "line_item_id": "00000000-0000-4000-8000-000000000101",
                    "amount": "42.50",
                    "currency": "USD",
                    "category": "Travel",
                }
            ]
        },
    )

    assert response.status_code == 422


def _load_auth_with_test_key(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    monkeypatch.setenv("JWT_PUBLIC_KEY_PEM", TEST_JWT_PUBLIC_KEY_PEM)
    monkeypatch.setenv("JWT_KEY_ID", TEST_JWT_KEY_ID)
    monkeypatch.setenv("JWT_ISSUER", TEST_JWT_ISSUER)
    monkeypatch.setenv("JWT_AUDIENCE", TEST_JWT_AUDIENCE)

    import app.auth

    return importlib.reload(app.auth)


def _load_test_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    main = _load_test_main(monkeypatch)
    return TestClient(main.app)


def _load_test_main(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    _load_auth_with_test_key(monkeypatch)

    import app.main

    main = importlib.reload(app.main)
    return main


def _assert_unauthorized(verify_token: Callable[[str], object], token: str) -> None:
    with pytest.raises(HTTPException) as exc_info:
        verify_token(token)

    assert exc_info.value.status_code == 401


def _mint_token_without_roles() -> str:
    return jwt.encode(
        {
            "sub": "00000000-0000-4000-8000-000000000213",
            "tenantId": "00000000-0000-4000-8000-000000000113",
            "iss": TEST_JWT_ISSUER,
            "aud": TEST_JWT_AUDIENCE,
            "exp": datetime.now(timezone.utc) + timedelta(minutes=15),
        },
        TEST_JWT_PRIVATE_KEY_PEM,
        algorithm="RS256",
        headers={"kid": TEST_JWT_KEY_ID},
    )


def _tamper_signature(signature: str) -> str:
    replacement = "A" if signature[0] != "A" else "B"
    return f"{replacement}{signature[1:]}"


class FakeCursor:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self._rows = rows

    def execute(self, query: str, params: dict[str, object]) -> object:
        return None

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._rows


class FakeCursorContext:
    def __init__(self, cursor: FakeCursor) -> None:
        self._cursor = cursor

    def __enter__(self) -> FakeCursor:
        return self._cursor

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None


class FakeDbSession:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self._cursor = FakeCursor(rows)

    def cursor(self) -> FakeCursorContext:
        return FakeCursorContext(self._cursor)
