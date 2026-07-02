"""Filter Expense Reports that are over the 500 review threshold."""

from decimal import Decimal

from expense_report_model import ExpenseReport


def flag_when_report_over_500(reports: list[ExpenseReport]) -> list[ExpenseReport]:
    """Return original Expense Reports with claimed amounts higher than 500."""
    return [report for report in reports if report.claimed_amount > Decimal(500)]
