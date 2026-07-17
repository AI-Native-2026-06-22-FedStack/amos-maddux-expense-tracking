from decimal import Decimal
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.gl_coding_contract import (
    GlCodingRequest,
    GlCodingResponse,
    MappedCodedLineItem,
    MappedCodedMileageEntry,
    UnmappedCodedLineItem,
)

LINE_ITEM_ID = UUID("00000000-0000-4000-8000-000000000101")
MILEAGE_ENTRY_ID = UUID("00000000-0000-4000-8000-000000000201")
GL_CODE_ID = UUID("00000000-0000-4000-8000-000000000301")


def test_gl_coding_request_accepts_line_items_and_mileage_entries() -> None:
    request = GlCodingRequest(
        line_items=[
            {
                "line_item_id": LINE_ITEM_ID,
                "amount": Decimal("42.50"),
                "currency": "USD",
                "category": "Meals",
            }
        ],
        mileage_entries=[
            {
                "mileage_entry_id": MILEAGE_ENTRY_ID,
                "miles": Decimal("18.25"),
            }
        ],
    )

    assert request.line_items[0].amount == Decimal("42.50")
    assert request.mileage_entries[0].miles == Decimal("18.25")
    assert request.mileage_entries[0].category == "Mileage"


def test_gl_coding_request_rejects_negative_line_item_amount() -> None:
    with pytest.raises(ValidationError):
        GlCodingRequest(
            line_items=[
                {
                    "line_item_id": LINE_ITEM_ID,
                    "amount": Decimal("-1.00"),
                    "currency": "USD",
                    "category": "Meals",
                }
            ]
        )


def test_gl_coding_request_rejects_negative_miles() -> None:
    with pytest.raises(ValidationError):
        GlCodingRequest(
            mileage_entries=[
                {
                    "mileage_entry_id": MILEAGE_ENTRY_ID,
                    "miles": Decimal("-1.00"),
                }
            ]
        )


def test_gl_coding_request_rejects_mileage_amount_field() -> None:
    with pytest.raises(ValidationError):
        GlCodingRequest(
            mileage_entries=[
                {
                    "mileage_entry_id": MILEAGE_ENTRY_ID,
                    "miles": Decimal("18.25"),
                    "amount": Decimal("11.95"),
                }
            ]
        )


def test_gl_coding_request_rejects_object_shaped_category() -> None:
    with pytest.raises(ValidationError):
        GlCodingRequest(
            line_items=[
                {
                    "line_item_id": LINE_ITEM_ID,
                    "amount": Decimal("42.50"),
                    "currency": "USD",
                    "category": {"name": "Meals"},
                }
            ]
        )


def test_gl_coding_request_rejects_unsupported_category() -> None:
    with pytest.raises(ValidationError):
        GlCodingRequest(
            line_items=[
                {
                    "line_item_id": LINE_ITEM_ID,
                    "amount": Decimal("42.50"),
                    "currency": "USD",
                    "category": "Travel",
                }
            ]
        )


def test_gl_coding_response_includes_flagged_line_item_field() -> None:
    response = GlCodingResponse(
        coded_line_items=[
            MappedCodedLineItem(
                line_item_id=LINE_ITEM_ID,
                category="Meals",
                gl_code_id=GL_CODE_ID,
                account_code="6100",
                account_name="Synthetic Meals Expense",
                normal_balance="debit",
                flagged=True,
            )
        ],
        coded_mileage_entries=[
            MappedCodedMileageEntry(
                mileage_entry_id=MILEAGE_ENTRY_ID,
                miles=Decimal("18.25"),
                reimbursable_amount=Decimal("12.23"),
                gl_code_id=GL_CODE_ID,
                account_code="6300",
                account_name="Synthetic Mileage Expense",
                normal_balance="debit",
            )
        ],
        flagged_line_item=LINE_ITEM_ID,
    )

    assert response.model_dump()["flagged_line_item"] == LINE_ITEM_ID
    assert response.coded_mileage_entries[0].miles == Decimal("18.25")


def test_gl_coding_response_accepts_valid_category_unmapped_line_item() -> None:
    response = GlCodingResponse(
        coded_line_items=[
            UnmappedCodedLineItem(
                line_item_id=LINE_ITEM_ID,
                category="Supplies",
                flagged=False,
            )
        ],
        flagged_line_item=None,
    )

    dumped = response.model_dump()

    assert dumped["coded_line_items"][0]["status"] == "unmapped"
    assert dumped["coded_line_items"][0]["unmapped_marker"] == "UNMAPPED_GL_CATEGORY"
    assert "gl_code_id" not in dumped["coded_line_items"][0]


def test_mapped_gl_coding_response_requires_gl_account_fields() -> None:
    with pytest.raises(ValidationError):
        MappedCodedLineItem(
            line_item_id=LINE_ITEM_ID,
            category="Meals",
            flagged=False,
        )
