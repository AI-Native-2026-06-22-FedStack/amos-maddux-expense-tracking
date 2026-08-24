#!/usr/bin/env python3
"""Write the small, hand-authored, gzipped JSONL fixture used by
test_aggregate.py and test_equivalence_check.py.

Not run automatically — the fixture file itself is checked in
(tiny_export.jsonl.gz) so tests don't depend on regenerating it. Re-run this
script only if the fixture's row shape needs to change.

expense_report_id and record_id must be valid hex UUIDs (not merely
UUID-shaped): tools/load_line_items_to_postgres.py casts them with `::uuid`
when loading into a real Postgres, and DuckDB's `::uuid` cast rejects
non-hex characters.
"""

import gzip
import json
from pathlib import Path

FIXTURE_PATH = Path(__file__).parent / "tiny_export.jsonl.gz"

TENANT_A = "aaaaaaaa-0000-4000-8000-000000000001"
TENANT_B = "bbbbbbbb-0000-4000-8000-000000000002"

# One field per FIELD_ORDER entry in services/pipeline/tools/generate_export.py,
# so this fixture matches the real export's shape exactly.
ROWS = [
    # Tenant A, GL 6100, Jan: one flagged ($600.00 > $500 threshold), one not
    # ($10.00). Both in the same tenant/gl/month group.
    {
        "record_type": "line_item", "tenant_id": TENANT_A,
        "expense_report_id": "cccccccc-0000-4000-8000-000000000001",
        "record_id": "dddddddd-0000-4000-8000-000000000001",
        "submitter_id": "synthetic-submitter-1", "current_stage": "Paid",
        "merchant": "Delta Air Lines", "category": "Meals",
        "amount_cents": 60000, "currency": "USD", "miles": None,
        "trip_date": None, "origin": None, "destination": None,
        "business_purpose": None, "gl_account_code": "6100",
        "gl_account_name": "Meals Expense", "gl_normal_balance": "debit",
        "gl_coding_status": "mapped", "receipt_number": "RCT-000001",
        "receipt_date": "2026-01-05", "flagged": False, "deductible": True,
        "manager_review_status": "approved", "created_at": "2026-01-05T00:00:00Z",
    },
    {
        "record_type": "line_item", "tenant_id": TENANT_A,
        "expense_report_id": "cccccccc-0000-4000-8000-000000000002",
        "record_id": "dddddddd-0000-4000-8000-000000000002",
        "submitter_id": "synthetic-submitter-1", "current_stage": "Paid",
        "merchant": "Panera Bread", "category": "Meals",
        "amount_cents": 1000, "currency": "USD", "miles": None,
        "trip_date": None, "origin": None, "destination": None,
        "business_purpose": None, "gl_account_code": "6100",
        "gl_account_name": "Meals Expense", "gl_normal_balance": "debit",
        "gl_coding_status": "mapped", "receipt_number": "RCT-000002",
        "receipt_date": "2026-01-12", "flagged": False, "deductible": True,
        "manager_review_status": "approved", "created_at": "2026-01-12T00:00:00Z",
    },
    # Tenant A, GL 6200 (leading-zero variant "06200" — must survive as a
    # string, unmerged with plain "6200" elsewhere), Jan: exactly $500.00,
    # which the > (strict) rule must NOT flag.
    {
        "record_type": "line_item", "tenant_id": TENANT_A,
        "expense_report_id": "cccccccc-0000-4000-8000-000000000003",
        "record_id": "dddddddd-0000-4000-8000-000000000003",
        "submitter_id": "synthetic-submitter-1", "current_stage": "Submitted",
        "merchant": "Marriott Hotels", "category": "Lodging",
        "amount_cents": 50000, "currency": "USD", "miles": None,
        "trip_date": None, "origin": None, "destination": None,
        "business_purpose": None, "gl_account_code": "06200",
        "gl_account_name": "Lodging Expense", "gl_normal_balance": "debit",
        "gl_coding_status": "mapped", "receipt_number": "RCT-000003",
        "receipt_date": "2026-01-20", "flagged": False, "deductible": True,
        "manager_review_status": "pending", "created_at": "2026-01-20T00:00:00Z",
    },
    # Tenant A, GL 6100, Feb: different month, must be its own group.
    {
        "record_type": "line_item", "tenant_id": TENANT_A,
        "expense_report_id": "cccccccc-0000-4000-8000-000000000004",
        "record_id": "dddddddd-0000-4000-8000-000000000004",
        "submitter_id": "synthetic-submitter-1", "current_stage": "Drafted",
        "merchant": "Chevron", "category": "Meals",
        "amount_cents": 2500, "currency": "USD", "miles": None,
        "trip_date": None, "origin": None, "destination": None,
        "business_purpose": None, "gl_account_code": "6100",
        "gl_account_name": "Meals Expense", "gl_normal_balance": "debit",
        "gl_coding_status": "mapped", "receipt_number": "RCT-000004",
        "receipt_date": "2026-02-02", "flagged": False, "deductible": False,
        "manager_review_status": "pending", "created_at": "2026-02-02T00:00:00Z",
    },
    # Tenant B, GL 6100, Jan: different tenant, must be its own group even
    # though tenant B also uses GL 6100 in January.
    {
        "record_type": "line_item", "tenant_id": TENANT_B,
        "expense_report_id": "cccccccc-0000-4000-8000-000000000005",
        "record_id": "dddddddd-0000-4000-8000-000000000005",
        "submitter_id": "synthetic-submitter-2", "current_stage": "Reconciled",
        "merchant": "Staples", "category": "Supplies",
        "amount_cents": 75000, "currency": "USD", "miles": None,
        "trip_date": None, "origin": None, "destination": None,
        "business_purpose": None, "gl_account_code": "6100",
        "gl_account_name": "Meals Expense", "gl_normal_balance": "debit",
        "gl_coding_status": "mapped", "receipt_number": "RCT-000005",
        "receipt_date": "2026-01-15", "flagged": False, "deductible": True,
        "manager_review_status": "approved", "created_at": "2026-01-15T00:00:00Z",
    },
    # A mileage row: must be excluded entirely from spend and from the flag
    # denominator (amount_cents is null; the flag rule never applies to it).
    {
        "record_type": "mileage", "tenant_id": TENANT_A,
        "expense_report_id": "cccccccc-0000-4000-8000-000000000006",
        "record_id": "dddddddd-0000-4000-8000-000000000006",
        "submitter_id": "synthetic-submitter-1", "current_stage": "Paid",
        "merchant": None, "category": "Mileage", "amount_cents": None,
        "currency": None, "miles": "42.00", "trip_date": "2026-01-08",
        "origin": "Chicago, IL", "destination": "Austin, TX",
        "business_purpose": "Client site visit", "gl_account_code": "6300",
        "gl_account_name": "Mileage Expense", "gl_normal_balance": "debit",
        "gl_coding_status": "mapped", "receipt_number": None,
        "receipt_date": None, "flagged": False, "deductible": True,
        "manager_review_status": "approved", "created_at": "2026-01-08T00:00:00Z",
    },
]


def main() -> None:
    with gzip.open(FIXTURE_PATH, "wt", encoding="utf-8") as f:
        for row in ROWS:
            f.write(json.dumps(row))
            f.write("\n")
    print(f"wrote {len(ROWS)} rows to {FIXTURE_PATH}")


if __name__ == "__main__":
    main()
