"""Database dependency for compute-owned storage."""

import os
from collections.abc import Iterator
from typing import Any

from fastapi import HTTPException


def get_db_session() -> Iterator[Any]:
    database_uri = os.getenv("DATABASE_URI")
    if database_uri is None or database_uri.strip() == "":
        raise HTTPException(status_code=500, detail="DATABASE_URI is required")

    try:
        import psycopg
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="Database driver is not installed") from exc

    with psycopg.connect(database_uri) as connection:
        yield connection
