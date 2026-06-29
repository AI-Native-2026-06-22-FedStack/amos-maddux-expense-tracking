"""Tests for the ExpenseFlow Python starter package."""

from decimal import Decimal

import pytest
from pydantic import ValidationError

from expense_report import (
    ExpenseReportReview,
    ExpenseReportReviewError,
    get_health_status,
    prepare_expense_report_review,
)
from expense_report_model import ExpenseReport, MoneyLineItem


def test_money_line_item_model_accepts_valid_boundary_input() -> None:
    """Money line item boundary accepts valid synthetic input."""
    line_item = MoneyLineItem(amount=Decimal("125.50"), currency="USD")

    assert line_item.amount == Decimal("125.50")
    assert line_item.currency == "USD"


def test_money_line_item_model_rejects_negative_amount() -> None:
    """Money line item boundary rejects negative amounts."""
    with pytest.raises(ValidationError):
        MoneyLineItem(amount=Decimal("-1.00"), currency="USD")


def test_expense_report_model_accepts_valid_boundary_input() -> None:
    """Expense Report boundary accepts valid synthetic input."""
    report = ExpenseReport(
        title="Synthetic conference supplies",
        stage="Submitted",
        claimed_amount=Decimal("125.50"),
    )

    assert report.title == "Synthetic conference supplies"
    assert report.stage == "Submitted"
    assert report.claimed_amount == Decimal("125.50")
    assert report.currency == "USD"


def test_expense_report_model_rejects_invalid_stage() -> None:
    """Expense Report boundary rejects unsupported stages."""
    with pytest.raises(ValidationError):
        ExpenseReport(
            title="Synthetic conference supplies",
            stage="Manager Review",
            claimed_amount=Decimal("125.50"),
        )


async def test_prepare_expense_report_review_returns_happy_path() -> None:
    """Submitted Expense Reports advance to Manager Approval under the finance threshold."""
    report = ExpenseReport(
        title="Synthetic conference supplies",
        stage="Submitted",
        claimed_amount=Decimal("125.50"),
    )

    result = await prepare_expense_report_review(report)

    assert isinstance(result, ExpenseReportReview)
    assert result.status == "ready"
    assert result.next_stage == "Manager Approval"


async def test_prepare_expense_report_review_returns_ap_review_for_large_claim() -> None:
    """Submitted Expense Reports above the finance threshold advance to AP Review."""
    report = ExpenseReport(
        title="Synthetic team offsite",
        stage="Submitted",
        claimed_amount=Decimal("5000.01"),
    )

    result = await prepare_expense_report_review(report)

    assert isinstance(result, ExpenseReportReview)
    assert result.status == "ready"
    assert result.next_stage == "AP Review"


async def test_prepare_expense_report_review_returns_error_for_wrong_stage() -> None:
    """Expense Reports outside Submitted stage return a typed error."""
    report = ExpenseReport(
        title="Synthetic conference supplies",
        stage="Drafted",
        claimed_amount=Decimal("125.50"),
    )

    result = await prepare_expense_report_review(report)

    assert isinstance(result, ExpenseReportReviewError)
    assert result.message == "Expense Report must be Submitted for review."


async def test_get_health_status_returns_happy_path() -> None:
    """Health status returns an ok payload for local runtime checks."""
    result = await get_health_status()

    assert result.status == "ok"
    assert result.service == "ExpenseFlow"
    assert result.checks["runtime"] == "ok"


async def test_get_health_status_returns_degraded_for_failed_local_check() -> None:
    """Health status reports degraded when a local check fails."""
    result = await get_health_status({"synthetic_local_check": False})

    assert result.status == "degraded"
    assert result.checks["synthetic_local_check"] == "failed"
