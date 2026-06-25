"""Typed async Expense Report workflow helpers."""

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

from expense_report_model import ExpenseReport

ReviewStatus = Literal["ready", "needs_revision"]

FINANCE_REVIEW_LIMIT = Decimal("5000.00")


@dataclass(frozen=True, slots=True)
class ExpenseReportReview:
    """Successful review decision for an Expense Report."""

    status: ReviewStatus
    next_stage: Literal["Manager Review", "Finance Review"]


@dataclass(frozen=True, slots=True)
class ExpenseReportReviewError:
    """Review error for an Expense Report that cannot advance."""

    message: str


type ExpenseReportReviewResult = ExpenseReportReview | ExpenseReportReviewError


async def prepare_expense_report_review(report: ExpenseReport) -> ExpenseReportReviewResult:
    """Prepare the next review step for a submitted Expense Report."""
    if report.stage != "Submitted":
        return ExpenseReportReviewError(message="Expense Report must be Submitted for review.")

    if report.claimed_amount > FINANCE_REVIEW_LIMIT:
        return ExpenseReportReview(status="ready", next_stage="Finance Review")

    return ExpenseReportReview(status="ready", next_stage="Manager Review")
