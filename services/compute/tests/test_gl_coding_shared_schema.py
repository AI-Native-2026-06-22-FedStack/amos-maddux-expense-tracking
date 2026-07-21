from decimal import Decimal
from uuid import UUID

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from app.gl_coding_contract import GlCodingRequest, GlCodingResponse, UnmappedCodedLineItem
from app.shared_schema import (
    load_gl_coding_schema_path,
    validate_gl_coding_request_contract,
    validate_gl_coding_response_contract,
)


def test_compute_loads_shared_gl_coding_schema_by_path() -> None:
    schema_path = load_gl_coding_schema_path()

    assert schema_path.parts[-3:] == ("packages", "shared-schemas", "gl-coding.schema.json")
    assert schema_path.exists()


def test_shared_schema_accepts_pydantic_gl_coding_payloads() -> None:
    request = GlCodingRequest(
        line_items=[
            {
                "line_item_id": "00000000-0000-4000-8000-000000000101",
                "amount": Decimal("42.50"),
                "currency": "USD",
                "category": "Meals",
            }
        ]
    )
    response = GlCodingResponse(
        coded_line_items=[
            UnmappedCodedLineItem(
                line_item_id=UUID("00000000-0000-4000-8000-000000000101"),
                category="Meals",
                flagged=False,
            )
        ],
        flagged_line_item=None,
    )

    validate_gl_coding_request_contract(request)
    validate_gl_coding_response_contract(response)


def test_unknown_category_still_fails_pydantic_validation() -> None:
    with pytest.raises(ValidationError):
        GlCodingRequest(
            line_items=[
                {
                    "line_item_id": "00000000-0000-4000-8000-000000000101",
                    "amount": Decimal("42.50"),
                    "currency": "USD",
                    "category": "Travel",
                }
            ]
        )


def test_shared_schema_rejects_deductibility_fields() -> None:
    schema_path = load_gl_coding_schema_path()
    import json

    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    validator = Draft202012Validator(
        {
            "$schema": schema["$schema"],
            **schema["$defs"]["GlCodingResponse"],
            "$defs": schema["$defs"],
        }
    )
    errors = list(
        validator.iter_errors(
            {
                "coded_line_items": [],
                "coded_mileage_entries": [],
                "flagged_line_item": None,
                "deductible": False,
            }
        )
    )

    assert len(errors) > 0
