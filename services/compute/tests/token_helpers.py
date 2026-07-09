from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt


TEST_JWT_ISSUER = "expense-api"
TEST_JWT_AUDIENCE = "expense-clients"
TEST_JWT_KEY_ID = "local-development-key"
TEST_JWT_KEYS_DIR = Path(__file__).parent / "fixtures" / "jwt_keys"
TEST_JWT_PRIVATE_KEY_PATH = TEST_JWT_KEYS_DIR / "SYNTHETIC-jwt-private.pem"
TEST_JWT_PUBLIC_KEY_PATH = TEST_JWT_KEYS_DIR / "SYNTHETIC-jwt-public.pem"


def mint_test_access_token(
    user_id: str = "00000000-0000-4000-8000-000000000201",
    tenant_id: str = "00000000-0000-4000-8000-000000000101",
    role: str = "Employee",
    expires_at: datetime | None = None,
    issuer: str = TEST_JWT_ISSUER,
    audience: str = TEST_JWT_AUDIENCE,
    key_id: str = TEST_JWT_KEY_ID,
) -> str:
    if expires_at is None:
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=15)
    private_key = TEST_JWT_PRIVATE_KEY_PATH.read_text(encoding="utf-8")

    # Fake Python-minted tokens avoid the cost of Express auth while proving Python honors the same contract.
    return jwt.encode(
        {
            "sub": user_id,
            "tenantId": tenant_id,
            "roles": [role],
            "iss": issuer,
            "aud": audience,
            "exp": expires_at,
        },
        private_key,
        algorithm="RS256",
        headers={"kid": key_id},
    )
