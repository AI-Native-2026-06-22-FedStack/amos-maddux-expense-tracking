from decimal import Decimal
from uuid import UUID

from app.coding import calculate_reimbursable_amount, code_expense_report
from app.gl_coding_contract import GlCodingRequest

TENANT_ID = UUID("00000000-0000-4000-8000-000000000111")
LINE_ITEM_ID = UUID("00000000-0000-4000-8000-000000000101")
SECOND_LINE_ITEM_ID = UUID("00000000-0000-4000-8000-000000000102")
MILEAGE_ENTRY_ID = UUID("00000000-0000-4000-8000-000000000201")
MEALS_GL_CODE_ID = UUID("00000000-0000-4000-8000-000000000301")
MILEAGE_GL_CODE_ID = UUID("00000000-0000-4000-8000-000000000302")


def test_code_expense_report_maps_line_items_from_gl_mapping() -> None:
    request = GlCodingRequest(
        line_items=[
            {
                "line_item_id": LINE_ITEM_ID,
                "amount": Decimal("42.50"),
                "currency": "USD",
                "category": "Meals",
            }
        ]
    )
    db_session = FakeDbSession(
        [
            ("Meals", MEALS_GL_CODE_ID, "6100", "Synthetic Meals Expense", "debit"),
        ]
    )

    response = code_expense_report(
        request,
        tenant_id=TENANT_ID,
        db_session=db_session,
        mileage_rate=Decimal("0.67"),
    )

    assert response.coded_line_items[0].status == "mapped"
    assert response.coded_line_items[0].gl_code_id == MEALS_GL_CODE_ID
    assert response.coded_line_items[0].account_code == "6100"
    assert db_session.last_params == {"tenant_id": TENANT_ID, "categories": ["Meals"]}


def test_code_expense_report_returns_unmapped_marker_for_valid_unmapped_category() -> None:
    request = GlCodingRequest(
        line_items=[
            {
                "line_item_id": LINE_ITEM_ID,
                "amount": Decimal("42.50"),
                "currency": "USD",
                "category": "Supplies",
            }
        ]
    )

    response = code_expense_report(
        request,
        tenant_id=TENANT_ID,
        db_session=FakeDbSession([]),
        mileage_rate=Decimal("0.67"),
    )

    coded_line_item = response.coded_line_items[0]

    assert coded_line_item.status == "unmapped"
    assert coded_line_item.unmapped_marker == "UNMAPPED_GL_CATEGORY"
    assert not hasattr(coded_line_item, "gl_code_id")


def test_code_expense_report_converts_mileage_at_configured_rate() -> None:
    request = GlCodingRequest(
        mileage_entries=[
            {
                "mileage_entry_id": MILEAGE_ENTRY_ID,
                "miles": Decimal("18.25"),
            }
        ]
    )

    response = code_expense_report(
        request,
        tenant_id=TENANT_ID,
        db_session=FakeDbSession(
            [
                ("Mileage", MILEAGE_GL_CODE_ID, "6300", "Synthetic Mileage Expense", "debit"),
            ]
        ),
        mileage_rate=Decimal("0.67"),
    )

    coded_mileage_entry = response.coded_mileage_entries[0]

    assert coded_mileage_entry.status == "mapped"
    assert coded_mileage_entry.reimbursable_amount == Decimal("12.23")
    assert coded_mileage_entry.gl_code_id == MILEAGE_GL_CODE_ID


def test_code_expense_report_flags_only_items_over_500() -> None:
    request = GlCodingRequest(
        line_items=[
            {
                "line_item_id": LINE_ITEM_ID,
                "amount": Decimal("500.00"),
                "currency": "USD",
                "category": "Meals",
            },
            {
                "line_item_id": SECOND_LINE_ITEM_ID,
                "amount": Decimal("500.01"),
                "currency": "USD",
                "category": "Meals",
            },
        ]
    )

    response = code_expense_report(
        request,
        tenant_id=TENANT_ID,
        db_session=FakeDbSession(
            [
                ("Meals", MEALS_GL_CODE_ID, "6100", "Synthetic Meals Expense", "debit"),
            ]
        ),
        mileage_rate=Decimal("0.67"),
    )

    assert response.coded_line_items[0].flagged is False
    assert response.coded_line_items[1].flagged is True
    assert response.flagged_line_item == SECOND_LINE_ITEM_ID
    assert "deductible" not in response.model_dump()


def test_calculate_reimbursable_amount_rounds_to_usd_cents() -> None:
    assert calculate_reimbursable_amount(Decimal("10.005"), Decimal("1.00")) == Decimal("10.01")


class FakeCursor:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self._rows = rows
        self.last_params: dict[str, object] | None = None

    def execute(self, query: str, params: dict[str, object]) -> object:
        self.last_params = params
        return None

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._rows


class FakeCursorContext:
    def __init__(self, cursor: FakeCursor) -> None:
        self._cursor = cursor

    def __enter__(self) -> FakeCursor:
        return self._cursor

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None


class FakeDbSession:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self._cursor = FakeCursor(rows)

    @property
    def last_params(self) -> dict[str, object] | None:
        return self._cursor.last_params

    def cursor(self) -> FakeCursorContext:
        return FakeCursorContext(self._cursor)
