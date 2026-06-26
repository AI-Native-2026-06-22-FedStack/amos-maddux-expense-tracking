"""Typed async Expense Report workflow helpers."""

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

from expense_report_model import ExpenseReport

HealthState = Literal["ok", "degraded"]
HealthCheckState = Literal["ok", "failed"]
ReviewStatus = Literal["ready", "needs_revision"]

FINANCE_REVIEW_LIMIT = Decimal("5000.00")


@dataclass(frozen=True, slots=True)
class HealthStatus:
    """Local service health status payload."""

    status: HealthState
    service: Literal["ExpenseFlow"]
    checks: Mapping[str, HealthCheckState]


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


async def get_health_status(checks: Mapping[str, bool] | None = None) -> HealthStatus:
    """Return local health status without calling external services."""
    local_checks = {"runtime": True} if checks is None else dict(checks)
    health_checks: dict[str, HealthCheckState] = {
        name: "ok" if is_ok else "failed" for name, is_ok in local_checks.items()
    }
    status: HealthState = "ok" if all(local_checks.values()) else "degraded"

    return HealthStatus(status=status, service="ExpenseFlow", checks=health_checks)


async def prepare_expense_report_review(report: ExpenseReport) -> ExpenseReportReviewResult:
    """Prepare the next review step for a submitted Expense Report."""
    if report.stage != "Submitted":
        return ExpenseReportReviewError(message="Expense Report must be Submitted for review.")

    if report.claimed_amount > FINANCE_REVIEW_LIMIT:
        return ExpenseReportReview(status="ready", next_stage="Finance Review")

    return ExpenseReportReview(status="ready", next_stage="Manager Review")
