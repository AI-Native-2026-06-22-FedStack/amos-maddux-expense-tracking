"""Tests that amounts over 500 are returned for review."""

from decimal import Decimal

from expense_report_model import ExpenseReport, MoneyLineItem
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


def test_flags_report_with_line_items_when_total_is_over_500() -> None:
    """Expense Reports with line items over 500 are returned unchanged."""
    at_boundary_line_items = [
        MoneyLineItem(amount=Decimal("250.00"), currency="USD"),
        MoneyLineItem(amount=Decimal("250.00"), currency="USD"),
    ]
    over_boundary_line_items = [
        MoneyLineItem(amount=Decimal("250.00"), currency="USD"),
        MoneyLineItem(amount=Decimal("250.01"), currency="USD"),
    ]
    at_boundary_report = ExpenseReport(
        title="Synthetic conference supplies at boundary",
        stage="Submitted",
        claimed_amount=Decimal("500.00"),
        money_line_items=at_boundary_line_items,
    )
    over_boundary_report = ExpenseReport(
        title="Synthetic conference supplies over boundary",
        stage="Submitted",
        claimed_amount=Decimal("500.01"),
        money_line_items=over_boundary_line_items,
    )

    flagged_reports = flag_when_report_over_500([at_boundary_report, over_boundary_report])

    assert flagged_reports == [over_boundary_report]
    assert flagged_reports[0] is over_boundary_report
    assert flagged_reports[0].money_line_items == over_boundary_line_items
