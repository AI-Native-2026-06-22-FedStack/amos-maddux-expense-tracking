from datetime import datetime, timedelta, timezone

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

TEST_JWT_ISSUER = "expense-api"
TEST_JWT_AUDIENCE = "expense-clients"
TEST_JWT_KEY_ID = "local-development-key"
_TEST_JWT_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
TEST_JWT_PRIVATE_KEY_PEM = _TEST_JWT_PRIVATE_KEY.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
).decode("utf-8")
TEST_JWT_PUBLIC_KEY_PEM = _TEST_JWT_PRIVATE_KEY.public_key().public_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PublicFormat.SubjectPublicKeyInfo,
).decode("utf-8")


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

    # Fake Python-minted tokens avoid Express auth while proving Python honors
    # the same token contract.
    return jwt.encode(
        {
            "sub": user_id,
            "tenantId": tenant_id,
            "roles": [role],
            "iss": issuer,
            "aud": audience,
            "exp": expires_at,
        },
        TEST_JWT_PRIVATE_KEY_PEM,
        algorithm="RS256",
        headers={"kid": key_id},
    )
