"""Validation against the shared GL coding JSON Schema package."""

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from jsonschema import Draft202012Validator

from app.gl_coding_contract import GlCodingRequest, GlCodingResponse

SHARED_SCHEMA_PATH = (
    Path(__file__).resolve().parents[3] / "packages" / "shared-schemas" / "gl-coding.schema.json"
)


def validate_gl_coding_request_contract(request: GlCodingRequest) -> None:
    _validate_contract_part("GlCodingRequest", request.model_dump(mode="json"))


def validate_gl_coding_response_contract(response: GlCodingResponse) -> None:
    _validate_contract_part("GlCodingResponse", response.model_dump(mode="json"))


def load_gl_coding_schema_path() -> Path:
    return SHARED_SCHEMA_PATH


def _validate_contract_part(definition_name: str, payload: dict[str, Any]) -> None:
    validator = _validator_for(definition_name)
    errors = sorted(validator.iter_errors(payload), key=lambda error: list(error.path))
    if len(errors) > 0:
        raise HTTPException(status_code=500, detail="GL coding payload violates shared schema")


@lru_cache(maxsize=2)
def _validator_for(definition_name: str) -> Draft202012Validator:
    schema = json.loads(SHARED_SCHEMA_PATH.read_text(encoding="utf-8"))
    definition = schema["$defs"][definition_name]

    return Draft202012Validator(
        {
            "$schema": schema["$schema"],
            **definition,
            "$defs": schema["$defs"],
        }
    )
