"""GL coding rules for ExpenseFlow compute."""

import os
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Protocol
from uuid import UUID

from fastapi import HTTPException

from app.gl_coding_contract import (
    CodedLineItem,
    CodedMileageEntry,
    ExpenseCategory,
    GlCodingRequest,
    GlCodingResponse,
    MappedCodedLineItem,
    MappedCodedMileageEntry,
    NormalBalance,
    UnmappedCodedLineItem,
    UnmappedCodedMileageEntry,
)

FLAG_THRESHOLD = Decimal("500.00")
USD_CENT = Decimal("0.01")
DEFAULT_MILEAGE_REIMBURSEMENT_RATE = Decimal("0.67")


class Cursor(Protocol):
    def execute(self, query: str, params: dict[str, object]) -> object: ...

    def fetchall(self) -> list[tuple[object, ...]]: ...


class CursorContext(Protocol):
    def __enter__(self) -> Cursor: ...

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> object: ...


class DbSession(Protocol):
    def cursor(self) -> CursorContext: ...


@dataclass(frozen=True)
class GlAccountMapping:
    gl_code_id: UUID
    account_code: str
    account_name: str
    normal_balance: NormalBalance


def code_expense_report(
    request: GlCodingRequest,
    *,
    tenant_id: UUID,
    db_session: DbSession,
    mileage_rate: Decimal,
) -> GlCodingResponse:
    """Return mapped or explicitly unmapped GL coding decisions."""

    categories = {line_item.category for line_item in request.line_items}
    categories.update(mileage_entry.category for mileage_entry in request.mileage_entries)
    mappings = load_gl_mappings(db_session, tenant_id, categories)

    coded_line_items: list[CodedLineItem] = []
    first_flagged_line_item: UUID | None = None

    for line_item in request.line_items:
        flagged = line_item.amount > FLAG_THRESHOLD
        if flagged and first_flagged_line_item is None:
            first_flagged_line_item = line_item.line_item_id

        mapping = mappings.get(line_item.category)
        if mapping is None:
            coded_line_items.append(
                UnmappedCodedLineItem(
                    line_item_id=line_item.line_item_id,
                    category=line_item.category,
                    flagged=flagged,
                )
            )
            continue

        coded_line_items.append(
            MappedCodedLineItem(
                line_item_id=line_item.line_item_id,
                category=line_item.category,
                gl_code_id=mapping.gl_code_id,
                account_code=mapping.account_code,
                account_name=mapping.account_name,
                normal_balance=mapping.normal_balance,
                flagged=flagged,
            )
        )

    coded_mileage_entries: list[CodedMileageEntry] = []
    for mileage_entry in request.mileage_entries:
        reimbursable_amount = calculate_reimbursable_amount(mileage_entry.miles, mileage_rate)
        mapping = mappings.get(mileage_entry.category)
        if mapping is None:
            coded_mileage_entries.append(
                UnmappedCodedMileageEntry(
                    mileage_entry_id=mileage_entry.mileage_entry_id,
                    miles=mileage_entry.miles,
                    reimbursable_amount=reimbursable_amount,
                )
            )
            continue

        coded_mileage_entries.append(
            MappedCodedMileageEntry(
                mileage_entry_id=mileage_entry.mileage_entry_id,
                miles=mileage_entry.miles,
                reimbursable_amount=reimbursable_amount,
                gl_code_id=mapping.gl_code_id,
                account_code=mapping.account_code,
                account_name=mapping.account_name,
                normal_balance=mapping.normal_balance,
            )
        )

    return GlCodingResponse(
        coded_line_items=tuple(coded_line_items),
        coded_mileage_entries=tuple(coded_mileage_entries),
        flagged_line_item=first_flagged_line_item,
    )


def load_gl_mappings(
    db_session: DbSession,
    tenant_id: UUID,
    categories: Iterable[ExpenseCategory],
) -> dict[ExpenseCategory, GlAccountMapping]:
    category_values = tuple(sorted(set(categories)))
    if len(category_values) == 0:
        return {}

    with db_session.cursor() as cursor:
        cursor.execute(
            """
            select
                gl_mapping.category,
                gl_code.id,
                gl_code.account_code,
                gl_code.account_name,
                gl_code.normal_balance
            from gl_mapping
            join gl_code
                on gl_code.tenant_id = gl_mapping.tenant_id
                and gl_code.id = gl_mapping.gl_code_id
            where gl_mapping.tenant_id = %(tenant_id)s
                and gl_mapping.category = any(%(categories)s)
                and gl_code.active = true
            """,
            {"tenant_id": tenant_id, "categories": list(category_values)},
        )
        rows = cursor.fetchall()

    return {row[0]: _mapping_from_row(row) for row in rows}


def calculate_reimbursable_amount(miles: Decimal, mileage_rate: Decimal) -> Decimal:
    return (miles * mileage_rate).quantize(USD_CENT, rounding=ROUND_HALF_UP)


def load_mileage_reimbursement_rate() -> Decimal:
    raw_rate = os.getenv("MILEAGE_REIMBURSEMENT_RATE")
    if raw_rate is None or raw_rate.strip() == "":
        return DEFAULT_MILEAGE_REIMBURSEMENT_RATE

    try:
        rate = Decimal(raw_rate)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Invalid mileage reimbursement rate") from exc

    if rate <= Decimal("0"):
        raise HTTPException(status_code=500, detail="Invalid mileage reimbursement rate")

    return rate


def _mapping_from_row(row: tuple[Any, ...]) -> GlAccountMapping:
    normal_balance = row[4]
    if normal_balance not in ("debit", "credit"):
        raise HTTPException(status_code=500, detail="Invalid GL account normal balance")

    return GlAccountMapping(
        gl_code_id=row[1],
        account_code=row[2],
        account_name=row[3],
        normal_balance=normal_balance,
    )
