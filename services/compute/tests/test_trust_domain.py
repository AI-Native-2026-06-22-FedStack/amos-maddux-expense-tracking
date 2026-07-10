import importlib
from datetime import datetime, timedelta, timezone
from types import ModuleType
from typing import Callable

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from tests.token_helpers import (
    TEST_JWT_AUDIENCE,
    TEST_JWT_ISSUER,
    TEST_JWT_KEY_ID,
    TEST_JWT_PRIVATE_KEY_PATH,
    TEST_JWT_PUBLIC_KEY_PATH,
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


def _load_auth_with_test_key(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    monkeypatch.setenv("JWT_PUBLIC_KEY_PATH", str(TEST_JWT_PUBLIC_KEY_PATH))
    monkeypatch.setenv("JWT_KEY_ID", TEST_JWT_KEY_ID)
    monkeypatch.setenv("JWT_ISSUER", TEST_JWT_ISSUER)
    monkeypatch.setenv("JWT_AUDIENCE", TEST_JWT_AUDIENCE)

    import app.auth

    return importlib.reload(app.auth)


def _load_test_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    _load_auth_with_test_key(monkeypatch)

    import app.main

    main = importlib.reload(app.main)
    return TestClient(main.app)


def _assert_unauthorized(verify_token: Callable[[str], object], token: str) -> None:
    with pytest.raises(HTTPException) as exc_info:
        verify_token(token)

    assert exc_info.value.status_code == 401


def _mint_token_without_roles() -> str:
    private_key = TEST_JWT_PRIVATE_KEY_PATH.read_text(encoding="utf-8")

    return jwt.encode(
        {
            "sub": "00000000-0000-4000-8000-000000000213",
            "tenantId": "00000000-0000-4000-8000-000000000113",
            "iss": TEST_JWT_ISSUER,
            "aud": TEST_JWT_AUDIENCE,
            "exp": datetime.now(timezone.utc) + timedelta(minutes=15),
        },
        private_key,
        algorithm="RS256",
        headers={"kid": TEST_JWT_KEY_ID},
    )


def _tamper_signature(signature: str) -> str:
    replacement = "A" if signature[0] != "A" else "B"
    return f"{replacement}{signature[1:]}"
