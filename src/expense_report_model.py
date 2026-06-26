"""Pydantic v2 boundary models for ExpenseFlow Expense Reports."""

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ExpenseReportStage = Literal[
    "Drafted",
    "Submitted",
    "Manager Approval",
    "AP Review",
    "Paid",
    "Reconciled",
]


class MoneyLineItem(BaseModel):
    """Validated monetary line item boundary for an Expense Report."""

    model_config = ConfigDict(frozen=True, strict=True, str_strip_whitespace=True)

    amount: Decimal = Field(gt=Decimal(0), max_digits=12, decimal_places=2)
    currency: Literal["USD"]


class ExpenseReport(BaseModel):
    """Validated external boundary for an Expense Report."""

    model_config = ConfigDict(frozen=True, str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=120)
    stage: ExpenseReportStage
    claimed_amount: Decimal = Field(gt=Decimal(0), max_digits=12, decimal_places=2)
    currency: Literal["USD"] = "USD"
