import importlib
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from tests.token_helpers import (
    TEST_JWT_AUDIENCE,
    TEST_JWT_ISSUER,
    TEST_JWT_KEY_ID,
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


def _load_auth_with_test_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("JWT_PUBLIC_KEY_PATH", str(TEST_JWT_PUBLIC_KEY_PATH))
    monkeypatch.setenv("JWT_KEY_ID", TEST_JWT_KEY_ID)
    monkeypatch.setenv("JWT_ISSUER", TEST_JWT_ISSUER)
    monkeypatch.setenv("JWT_AUDIENCE", TEST_JWT_AUDIENCE)

    import app.auth

    return importlib.reload(app.auth)


def _assert_unauthorized(verify_token, token: str) -> None:
    with pytest.raises(HTTPException) as exc_info:
        verify_token(token)

    assert exc_info.value.status_code == 401


def _tamper_signature(signature: str) -> str:
    replacement = "A" if signature[-1] != "A" else "B"
    return f"{signature[:-1]}{replacement}"
