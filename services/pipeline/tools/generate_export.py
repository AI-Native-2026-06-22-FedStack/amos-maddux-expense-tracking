#!/usr/bin/env python3
"""Deterministic vendor-style export generator for the ExpenseFlow analytical pipeline.

Emits one gzipped, line-delimited JSON file under data/exports/ representing a mix
of expense_line_item and mileage_entry activity (with receipt_* fields folded onto
line-item rows), spread across several tenants and months, with a small number of
seeded data-quality defects for the downstream profiling exercise to discover.

Field names and conventions are taken directly from apps/api/src/db/schema.ts and
services/compute/db/seeds/0001_default_gl_mappings.sql rather than invented:
  - expense_line_item: tenant_id, expense_report_id, merchant, amount_cents,
    currency, category, gl_account_code, gl_account_name, gl_normal_balance,
    gl_coding_status, flagged, deductible, manager_review_status, created_at
  - receipt: receipt_number, receipt_date, amount_cents, currency
  - mileage_entry: trip_date, origin, destination, miles, business_purpose
  - category enum: Meals | Lodging | Mileage | Supplies | Other
  - GL codes seeded per category: 6100/6200/6300/6400/6900 (kept as text)
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import random
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

# Fixed anchor date for the "months" window. Using a hardcoded constant (not
# date.today()) is determinism-critical: if this were wall-clock-derived, the
# same --seed and --rows would produce different date ranges on different days,
# breaking byte-identical reruns.
ANCHOR_DATE = date(2026, 1, 1)

CATEGORIES = ("Meals", "Lodging", "Mileage", "Supplies", "Other")

# Mirrors services/compute/db/seeds/0001_default_gl_mappings.sql. Mileage is
# GL-coded as "Mileage" via the same category->account_code mapping.
CATEGORY_GL = {
    "Meals": ("6100", "Synthetic Meals Expense"),
    "Lodging": ("6200", "Synthetic Lodging Expense"),
    "Mileage": ("6300", "Synthetic Mileage Expense"),
    "Supplies": ("6400", "Synthetic Supplies Expense"),
    "Other": ("6900", "Synthetic Other Expense"),
}

STAGES = ("Drafted", "Submitted", "Manager Approval", "AP Review", "Paid", "Reconciled")
REVIEW_STATUSES = ("pending", "approved", "rejected")
GL_CODING_STATUSES = ("mapped", "unmapped")

MERCHANTS = (
    "Delta Air Lines",
    "Marriott Hotels",
    "Uber",
    "Staples",
    "Chevron",
    "Hilton Garden Inn",
    "United Airlines",
    "Office Depot",
    "Shell",
    "Panera Bread",
)

CITIES = (
    "Chicago, IL",
    "Austin, TX",
    "Denver, CO",
    "Seattle, WA",
    "Atlanta, GA",
    "Boston, MA",
    "Phoenix, AZ",
    "Portland, OR",
)

# Fixed column order for JSONL output. A plain dict literal below preserves
# insertion order (guaranteed by the language since 3.7), so this is not
# derived from any unordered set/dict iteration.
FIELD_ORDER = (
    "record_type",
    "tenant_id",
    "expense_report_id",
    "record_id",
    "submitter_id",
    "current_stage",
    "merchant",
    "category",
    "amount_cents",
    "currency",
    "miles",
    "trip_date",
    "origin",
    "destination",
    "business_purpose",
    "gl_account_code",
    "gl_account_name",
    "gl_normal_balance",
    "gl_coding_status",
    "receipt_number",
    "receipt_date",
    "flagged",
    "deductible",
    "manager_review_status",
    "created_at",
)


@dataclass(frozen=True)
class Tenant:
    tenant_id: str
    gl_codes: dict[str, tuple[str, str]]


def deterministic_uuid(rng: random.Random) -> str:
    """Build a UUID-shaped string from the seeded RNG stream.

    Using uuid.uuid4() would pull from the OS CSPRNG (os.urandom), which is
    unseeded and unrepeatable. Instead we draw 128 bits directly from the
    seeded `rng` and format them as a UUIDv4-shaped string, so the same seed
    always yields the same id sequence.
    """
    bits = rng.getrandbits(128)
    # Force the version/variant nibbles so the value is visually a valid v4
    # UUID; this is cosmetic only, the entropy source is what matters.
    bits &= ~(0xF << 76)
    bits |= 0x4 << 76
    bits &= ~(0x3 << 62)
    bits |= 0x2 << 62
    hex_str = f"{bits:032x}"
    return f"{hex_str[0:8]}-{hex_str[8:12]}-{hex_str[12:16]}-{hex_str[16:20]}-{hex_str[20:32]}"


def build_tenants(rng: random.Random, tenant_count: int) -> list[Tenant]:
    """Pre-generate tenants up front, each with its own GL code set.

    Generating all tenant ids in one fixed-order pass (rather than lazily
    on first use during row generation) keeps the RNG draw sequence stable
    regardless of how rows happen to be distributed across tenants.
    """
    tenants = []
    for _ in range(tenant_count):
        tenant_id = deterministic_uuid(rng)
        # Each tenant gets its own account_name suffix so cross-tenant GL
        # rows are distinguishable, while account_code stays stable per
        # category (mirrors the real seed migration's per-tenant GL codes).
        gl_codes = {
            category: (code, f"{name} ({tenant_id[:8]})")
            for category, (code, name) in CATEGORY_GL.items()
        }
        tenants.append(Tenant(tenant_id=tenant_id, gl_codes=gl_codes))
    return tenants


def build_months(month_count: int) -> list[date]:
    """Fixed list of month-start dates ending at ANCHOR_DATE, oldest first."""
    months = []
    year, month = ANCHOR_DATE.year, ANCHOR_DATE.month
    for _ in range(month_count):
        months.append(date(year, month, 1))
        month -= 1
        if month == 0:
            month = 12
            year -= 1
    months.reverse()
    return months


def random_day_in_month(rng: random.Random, month_start: date) -> date:
    if month_start.month == 12:
        next_month = date(month_start.year + 1, 1, 1)
    else:
        next_month = date(month_start.year, month_start.month + 1, 1)
    days_in_month = (next_month - month_start).days
    offset = rng.randrange(days_in_month)
    return month_start + timedelta(days=offset)


def make_line_item_row(
    rng: random.Random,
    tenant: Tenant,
    month_start: date,
    defect_rate: float,
) -> dict:
    category = rng.choice([c for c in CATEGORIES if c != "Mileage"])
    gl_code, gl_name = tenant.gl_codes[category]
    amount_cents = rng.randint(500, 250_000)  # integer minor units only
    trip_or_purchase_date = random_day_in_month(rng, month_start)
    currency = "USD"
    receipt_date_val: str | None = trip_or_purchase_date.isoformat()
    receipt_number = f"RCT-{rng.randint(100000, 999999)}"

    # --- Defect 1: currency case drift ---
    if rng.random() < defect_rate:
        currency = currency.lower()

    # --- Defect 2: GL account code padding/whitespace drift ---
    if rng.random() < defect_rate:
        gl_code = f"0{gl_code}" if rng.random() < 0.5 else f"{gl_code} "

    # --- Defect 3: non-positive amount_cents ---
    if rng.random() < defect_rate:
        amount_cents = 0 if rng.random() < 0.5 else -abs(amount_cents)

    # --- Defect 4: missing receipt_date despite populated receipt ---
    if rng.random() < defect_rate:
        receipt_date_val = None

    created_at = f"{trip_or_purchase_date.isoformat()}T00:00:00Z"

    return {
        "record_type": "line_item",
        "tenant_id": tenant.tenant_id,
        "expense_report_id": deterministic_uuid(rng),
        "record_id": deterministic_uuid(rng),
        "submitter_id": f"synthetic-submitter-{deterministic_uuid(rng)}",
        "current_stage": rng.choice(STAGES),
        "merchant": rng.choice(MERCHANTS),
        "category": category,
        "amount_cents": amount_cents,
        "currency": currency,
        "miles": None,
        "trip_date": None,
        "origin": None,
        "destination": None,
        "business_purpose": None,
        "gl_account_code": gl_code,  # kept as str; never cast to int
        "gl_account_name": gl_name,
        "gl_normal_balance": "debit",
        "gl_coding_status": rng.choice(GL_CODING_STATUSES),
        "receipt_number": receipt_number,
        "receipt_date": receipt_date_val,
        "flagged": rng.random() < 0.05,
        "deductible": rng.random() < 0.7,
        "manager_review_status": rng.choice(REVIEW_STATUSES),
        "created_at": created_at,
    }


def make_mileage_row(
    rng: random.Random,
    tenant: Tenant,
    month_start: date,
    defect_rate: float,
) -> dict:
    gl_code, gl_name = tenant.gl_codes["Mileage"]
    trip_date = random_day_in_month(rng, month_start)
    # numeric(10,2) in the DB: keep as a fixed 2-decimal string, never a float.
    miles = f"{rng.randint(1, 30000) / 100:.2f}"
    created_at = f"{trip_date.isoformat()}T00:00:00Z"

    # --- Defect 2 (shared): GL account code padding drift, mileage side ---
    if rng.random() < defect_rate:
        gl_code = f"0{gl_code}" if rng.random() < 0.5 else f"{gl_code} "

    trip_date_str = trip_date.isoformat()
    # --- Defect 5: locale-format date drift (MM/DD/YYYY instead of ISO) ---
    if rng.random() < defect_rate:
        trip_date_str = trip_date.strftime("%m/%d/%Y")

    return {
        "record_type": "mileage",
        "tenant_id": tenant.tenant_id,
        "expense_report_id": deterministic_uuid(rng),
        "record_id": deterministic_uuid(rng),
        "submitter_id": f"synthetic-submitter-{deterministic_uuid(rng)}",
        "current_stage": rng.choice(STAGES),
        "merchant": None,
        "category": "Mileage",
        "amount_cents": None,
        "currency": None,
        "miles": miles,
        "trip_date": trip_date_str,
        "origin": rng.choice(CITIES),
        "destination": rng.choice(CITIES),
        "business_purpose": "Client site visit",
        "gl_account_code": gl_code,
        "gl_account_name": gl_name,
        "gl_normal_balance": "debit",
        "gl_coding_status": rng.choice(GL_CODING_STATUSES),
        "receipt_number": None,
        "receipt_date": None,
        "flagged": False,
        "deductible": True,
        "manager_review_status": rng.choice(REVIEW_STATUSES),
        "created_at": created_at,
    }


def generate_rows(rng: random.Random, args: argparse.Namespace, tenants: list[Tenant], months: list[date]):
    """Yield one row dict at a time (generator, not a list) to avoid holding
    millions of dicts in memory simultaneously.
    """
    ids_seen: list[str] = []
    for i in range(args.rows):
        # Deterministic tenant/month assignment: drawn from the same seeded
        # stream, not from wall-clock or row index alone, so distribution is
        # reproducible but still varies row to row.
        tenant = rng.choice(tenants)
        month_start = rng.choice(months)

        is_mileage = rng.random() < 0.2
        if is_mileage:
            row = make_mileage_row(rng, tenant, month_start, args.defect_rate)
        else:
            row = make_line_item_row(rng, tenant, month_start, args.defect_rate)

        # --- Defect 6: duplicate record_id reused from the previous row ---
        if i > 0 and rng.random() < args.defect_rate:
            row["record_id"] = ids_seen[-1]
        ids_seen.append(row["record_id"])
        if len(ids_seen) > 1:
            ids_seen.pop(0)  # only need the immediately-preceding id

        yield row


def write_export(path: Path, rows) -> int:
    """Stream rows straight into a gzip member, one JSON line at a time.

    mtime=0 is determinism-critical: gzip.open()/GzipFile default to stamping
    the current wall-clock time into the gzip header, which would make the
    compressed bytes differ between two runs with identical --rows/--seed
    even though the decompressed content is identical. Fixing mtime=0 (and
    relying on the default deterministic compresslevel) makes the .gz file
    itself byte-identical across reruns, not just its decompressed content.
    """
    row_count = 0
    with open(path, "wb") as raw_file:
        with gzip.GzipFile(fileobj=raw_file, mode="wb", mtime=0) as gz:
            with io.TextIOWrapper(gz, encoding="utf-8", newline="\n") as text_out:
                for row in rows:
                    ordered = {key: row[key] for key in FIELD_ORDER}
                    text_out.write(json.dumps(ordered, separators=(",", ":")))
                    text_out.write("\n")
                    row_count += 1
    return row_count


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a deterministic gzipped JSONL vendor-style ExpenseFlow export."
    )
    parser.add_argument("--rows", type=int, required=True, help="Number of records to generate.")
    parser.add_argument("--seed", type=int, required=True, help="Random seed for deterministic output.")
    parser.add_argument("--tenants", type=int, default=12, help="Number of distinct tenants.")
    parser.add_argument("--months", type=int, default=6, help="Number of distinct months, ending at a fixed anchor date.")
    parser.add_argument(
        "--defect-rate",
        type=float,
        default=0.02,
        help="Per-check probability of injecting each defect type (default 0.02).",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("data/exports"),
        help="Output directory (default: data/exports/).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    # Single seeded RNG instance drives every random choice in this run
    # (tenant ids, GL padding defects, dates, amounts, etc). No other source
    # of randomness (os.urandom, uuid4, time-based seeding, hash()) is used
    # anywhere in the generation path.
    rng = random.Random(args.seed)

    tenants = build_tenants(rng, args.tenants)
    months = build_months(args.months)

    out_path = args.out_dir / f"expense_export_seed{args.seed}_rows{args.rows}.jsonl.gz"

    row_iter = generate_rows(rng, args, tenants, months)
    written = write_export(out_path, row_iter)

    print(f"wrote {written} rows to {out_path}")


if __name__ == "__main__":
    main()
