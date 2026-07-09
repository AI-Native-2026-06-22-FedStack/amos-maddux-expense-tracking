import os
from pathlib import Path
from typing import Any, Literal

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, ValidationError


Role = Literal["Finance Admin", "Department Manager", "Employee", "Admin"]

JWT_ISSUER = os.getenv("JWT_ISSUER", "expense-api")
JWT_AUDIENCE = os.getenv("JWT_AUDIENCE", "expense-clients")
JWT_KEY_ID = os.getenv("JWT_KEY_ID", "local-development-key")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")


class CurrentUser(BaseModel):
    user_id: str
    tenant_id: str
    role: Role


def _load_public_keys_by_kid() -> dict[str, str]:
    public_key_pem = os.getenv("JWT_PUBLIC_KEY_PEM")
    if public_key_pem is not None and public_key_pem.strip() != "":
        return {JWT_KEY_ID: public_key_pem.replace("\\n", "\n")}

    public_key_path = os.getenv("JWT_PUBLIC_KEY_PATH")
    if public_key_path is not None and public_key_path.strip() != "":
        try:
            return {JWT_KEY_ID: Path(public_key_path).read_text(encoding="utf-8")}
        except OSError as exc:
            raise _invalid_token() from exc

    return {}


PUBLIC_KEYS_BY_KID = _load_public_keys_by_kid()


def verify_token(token: str) -> CurrentUser:
    try:
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")
        if not isinstance(kid, str):
            raise _invalid_token()

        public_key = PUBLIC_KEYS_BY_KID.get(kid)
        if public_key is None:
            raise _invalid_token()

        payload = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            issuer=JWT_ISSUER,
            audience=JWT_AUDIENCE,
            options={"require": ["exp", "sub", "tenantId", "roles"]},
        )

        return _current_user_from_payload(payload)
    except HTTPException:
        raise
    except jwt.PyJWTError as exc:
        raise _invalid_token() from exc


def get_current_user(token: str = Depends(oauth2_scheme)) -> CurrentUser:
    return verify_token(token)


def _current_user_from_payload(payload: dict[str, Any]) -> CurrentUser:
    try:
        roles = payload["roles"]
        if not isinstance(roles, list) or len(roles) == 0:
            raise _invalid_token()

        return CurrentUser(
            user_id=payload["sub"],
            tenant_id=payload["tenantId"],
            role=roles[0],
        )
    except (KeyError, TypeError, ValidationError) as exc:
        raise _invalid_token() from exc


def _invalid_token() -> HTTPException:
    return HTTPException(status_code=401, detail="Invalid token")
