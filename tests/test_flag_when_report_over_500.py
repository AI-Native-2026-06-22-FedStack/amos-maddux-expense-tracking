"""Tests that amounts over 500 are returned for review."""

from decimal import Decimal

from expense_report_model import ExpenseReport
from flag_when_report_over_500 import flag_when_report_over_500


def test_flags__when_report_over_500() -> None:
    """Expense Reports with claimed amounts over the finance review threshold are flagged for Finance Review."""
    at_threshold_report = ExpenseReport(
        title="Expensive conference supplies",
        stage="Submitted",
        claimed_amount=Decimal("500"),
    )
    over_threshold_report = ExpenseReport(
        title="Very expensive conference supplies",
        stage="Submitted",
        claimed_amount=Decimal("501"),
    )

    reports = [at_threshold_report, over_threshold_report]
    flagged_reports = flag_when_report_over_500(reports)

    assert flagged_reports == [over_threshold_report]
