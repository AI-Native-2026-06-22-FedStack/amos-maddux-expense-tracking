"""Pydantic v2 boundary models for compute-owned GL coding."""

from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

ExpenseCategory = Literal["Meals", "Lodging", "Mileage", "Supplies", "Other"]
NormalBalance = Literal["debit", "credit"]


class GlCodingLineItem(BaseModel):
    """Monetary Expense Report line item submitted for GL coding."""

    model_config = ConfigDict(frozen=True, extra="forbid", strict=True, str_strip_whitespace=True)

    line_item_id: UUID
    amount: Decimal = Field(gt=Decimal("0"), max_digits=12, decimal_places=2)
    currency: Literal["USD"]
    category: ExpenseCategory


class GlCodingMileageEntry(BaseModel):
    """Mileage entry submitted for GL coding as distance only."""

    model_config = ConfigDict(frozen=True, extra="forbid", strict=True, str_strip_whitespace=True)

    mileage_entry_id: UUID
    miles: Decimal = Field(gt=Decimal("0"), max_digits=8, decimal_places=2)
    category: Literal["Mileage"] = "Mileage"


class GlCodingRequest(BaseModel):
    """Validated request boundary for GL coding decisions."""

    model_config = ConfigDict(frozen=True, extra="forbid", str_strip_whitespace=True)

    line_items: tuple[GlCodingLineItem, ...] = Field(default_factory=tuple)
    mileage_entries: tuple[GlCodingMileageEntry, ...] = Field(default_factory=tuple)


class CodedLineItem(BaseModel):
    """Coded monetary line item returned by the compute service."""

    model_config = ConfigDict(frozen=True, extra="forbid", strict=True, str_strip_whitespace=True)

    line_item_id: UUID
    category: ExpenseCategory
    gl_code_id: UUID
    account_code: str = Field(min_length=1, max_length=32)
    account_name: str = Field(min_length=1, max_length=120)
    normal_balance: NormalBalance
    flagged: bool = False


class CodedMileageEntry(BaseModel):
    """Coded mileage entry returned as distance-based coding, not dollars."""

    model_config = ConfigDict(frozen=True, extra="forbid", strict=True, str_strip_whitespace=True)

    mileage_entry_id: UUID
    miles: Decimal = Field(gt=Decimal("0"), max_digits=8, decimal_places=2)
    category: Literal["Mileage"] = "Mileage"
    gl_code_id: UUID
    account_code: str = Field(min_length=1, max_length=32)
    account_name: str = Field(min_length=1, max_length=120)
    normal_balance: NormalBalance


class GlCodingResponse(BaseModel):
    """Typed GL coding response including the flagged line-item contract field."""

    model_config = ConfigDict(frozen=True, extra="forbid", str_strip_whitespace=True)

    coded_line_items: tuple[CodedLineItem, ...] = Field(default_factory=tuple)
    coded_mileage_entries: tuple[CodedMileageEntry, ...] = Field(default_factory=tuple)
    flagged_line_item: UUID | None
