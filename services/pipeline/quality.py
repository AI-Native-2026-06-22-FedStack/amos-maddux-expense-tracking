"""Semantic/value-level data-quality checks for the ExpenseFlow ingest,
run over rows that have already passed the incoming Pydantic boundary
(models.ExpenseRow, enforced in validate.py). These checks test whether a
structurally valid row is semantically plausible, not whether its fields
have the right Python/Pydantic type -- that is already a solved problem
by the time a row reaches this module.

Every check below is required to trace to an anomaly actually recorded in
docs/data/expense-export-profile.md ("the profile"). Two of the five
checks originally proposed for this deliverable have no support in the
profile as literally stated, and were replaced with the profile-supported
anomaly closest in spirit. The mapping:

  1. non-negative amount
     -> KEPT, broadened to non-positive amount (profile: "Non-positive
        amount_cents (0 or negative)", 32,097 rows). Pydantic's
        ExpenseRow.reject_negative_amount already rejects amount_cents < 0
        at the incoming boundary, so a row reaching this module can only
        ever be negative if it slipped past that boundary in some future
        refactor -- but amount_cents == 0 is NOT rejected by Pydantic (see
        models.py's own docstring: "Zero and null are left untouched"), so
        this check's real, independent coverage is the zero case, plus a
        defense-in-depth re-check of negative for the reason stated above.

  2. known GL code against the project's existing reference source
     -> KEPT AS STATED, but the "reference source" is derived, not a live
        database read: services/compute/db/migrations/
        0001_gl_coding_reference.sql's gl_code table only has rows seeded
        for ONE tenant (services/compute/db/seeds/
        0001_default_gl_mappings.sql), while the export spans 12 tenants,
        and ADR-0006 forbids this pipeline from querying that operational
        table directly regardless. KNOWN_GL_ACCOUNT_CODES below is parsed
        from that same seed file's account_code values at import time, so
        the reference set is derived from the one real source of truth,
        not re-typed as an independent copy. The profile's own
        gl_account_code anomaly (leading zero / whitespace padding,
        39,908 rows) is used here as the source of realistic test
        fixtures for a code that must still PASS after normalization
        (it names a real, known account), not as this check's failure
        condition -- a code failing this check is one that does not match
        any known account code at all, which the profile did not
        specifically count but the reference data supports checking for.

  3. tenant presence
     -> KEPT AS STATED as a defensive check, despite the profile showing
        tenant_id at 0 nulls / 0.0% null rate across all 2,000,000 rows
        with no seeded defect ever targeting it. There is no profile
        evidence this check will ever fire against real export data; it
        exists to catch a hypothetical future export that omits tenant_id,
        and its tests below use synthetic rows rather than a documented
        anomaly, since none exists.

  4. referential integrity between a receipt and its line item
     -> REPLACED. This export has no separate receipt entity to reference:
        receipt_* fields are folded directly onto the expense_line_item
        row itself (profile doc: "Source shapes represented:
        expense_line_item (with receipt_* fields folded onto line-item
        rows)"). There is nothing to join across. The closest documented,
        real anomaly is an internal consistency defect on that same row:
        "receipt_number populated but receipt_date null, on line_item
        rows" (31,743 rows) -- a within-row check, not a cross-record one.

  5. no duplicate receipt
     -> REPLACED. receipt_number is generated independently per row
        (services/pipeline/tools/generate_export.py:
        f"RCT-{rng.randint(100000, 999999)}") with no seeded duplication
        defect and no measurement of receipt_number collisions anywhere in
        the profile. The profile's one documented duplicate-identifier
        anomaly is on a different field entirely: "record_id duplicated
        from the immediately preceding row" (39,920 rows, "Defect 6",
        confirmed in the generator source at the row["record_id"] =
        ids_seen[-1] reuse). This check detects duplicate record_id across
        a batch of rows instead.

Row-level vs. batch-level: checks 1-4 are decidable from a single row's
own fields. Check 5 (duplicate record_id) is inherently batch-level -- a
duplicate cannot be identified by looking at one row in isolation; it
requires comparing against every other record_id already seen in the same
run.

QualityFailure carries only non-sensitive identity (record_id, tenant_id,
row_index) and a reason string built from non-sensitive fields (amount,
gl_account_code, currency, boolean flags) -- never receipt_number or any
other field in config/sensitive-log-fields.json's key list. Rows handed to
these checks have already passed through extract.py's redaction (see
extract.py, redaction.py), so receipt_number arrives here as the literal
string "[REDACTED]" already; check_receipt_date_consistency below still
must not echo that value into its reason text as if it carried
information, since it is a censor token, not row content.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

QualityCheckName = Literal[
    "expense_row",
    "non_positive_amount",
    "known_gl_code",
    "tenant_presence",
    "receipt_date_consistency",
    "duplicate_record_id",
]
"""Every reason validate.py can reject a row. "expense_row" is the
incoming-boundary Pydantic gate (models.ExpenseRow, enforced in
validate.py, not defined in this module) reported through the same
QualityFailure shape so a Pydantic rejection and a semantic quality
rejection quarantine identically; the remaining five are this module's
own checks (see module docstring for the profile-anomaly mapping)."""

_GL_MAPPING_SEED_PATH = (
    Path(__file__).resolve().parents[1]
    / "compute"
    / "db"
    / "seeds"
    / "0001_default_gl_mappings.sql"
)
_GL_CODE_TUPLE_PATTERN = re.compile(r"\(\s*'(\d+)'\s*,\s*'[^']*'\s*\)")


def _load_known_gl_account_codes() -> frozenset[str]:
    """Parse the account_code values out of the gl_code seed's VALUES
    list, e.g. ('6100', 'Synthetic Meals Expense') -> "6100". The seed
    file's second VALUES block (category -> code, e.g.
    ('Meals', '6100')) never matches: its first element is not all-digit,
    so _GL_CODE_TUPLE_PATTERN only matches the (code, name) tuples.
    """
    text = _GL_MAPPING_SEED_PATH.read_text(encoding="utf-8")
    codes = _GL_CODE_TUPLE_PATTERN.findall(text)
    return frozenset(codes)


KNOWN_GL_ACCOUNT_CODES: frozenset[str] = _load_known_gl_account_codes()


@dataclass(frozen=True)
class QualityFailure:
    """One failed semantic quality check, with enough non-sensitive
    identity to locate the offending row without carrying any sensitive
    field value in `reason`.
    """

    check: QualityCheckName
    reason: str
    record_id: str
    tenant_id: str
    row_index: int | None = None


def _normalize_gl_code(code: str) -> str:
    """Strip whitespace padding and leading zeros, matching the two
    formatting defects the profile documents (leading zero, whitespace
    padding) -- both are cosmetic once normalized, not evidence the code
    itself is unknown. "" (a code of all zeros) normalizes to "0" rather
    than an empty string, so it cannot accidentally match every known
    code via an empty-string membership check.
    """
    stripped = code.strip().lstrip("0")
    return stripped if stripped != "" else "0"


def check_non_positive_amount(row: dict[str, object]) -> QualityFailure | None:
    """Profile: "Non-positive amount_cents (0 or negative)" (32,097 rows).

    Only evaluated when amount_cents is present: it is structurally null
    on every mileage row (profile doc), which is not a quality defect.
    """
    amount = row.get("amount_cents")
    if amount is None:
        return None
    if not isinstance(amount, int) or isinstance(amount, bool):
        return None  # not this check's concern; the incoming boundary owns type
    if amount <= 0:
        return QualityFailure(
            check="non_positive_amount",
            reason=f"amount_cents is non-positive ({amount})",
            record_id=str(row.get("record_id", "")),
            tenant_id=str(row.get("tenant_id", "")),
        )
    return None


def check_known_gl_code(row: dict[str, object]) -> QualityFailure | None:
    """gl_account_code, normalized, must match a known account code from
    the gl_code reference seed (KNOWN_GL_ACCOUNT_CODES). A leading-zero or
    whitespace-padded but otherwise-known code (the profile's documented
    formatting defect) passes; a code that names no known account at all
    fails.
    """
    raw_code = row.get("gl_account_code")
    if not isinstance(raw_code, str):
        return None
    normalized = _normalize_gl_code(raw_code)
    if normalized not in KNOWN_GL_ACCOUNT_CODES:
        return QualityFailure(
            check="known_gl_code",
            reason=f"gl_account_code {raw_code!r} does not match any known account code",
            record_id=str(row.get("record_id", "")),
            tenant_id=str(row.get("tenant_id", "")),
        )
    return None


def check_tenant_presence(row: dict[str, object]) -> QualityFailure | None:
    """tenant_id must be present and non-blank. Defensive: the profile
    shows 0 nulls / 0.0% rate across the full 2,000,000-row export, so
    this check has no documented failure case in real data -- it guards
    against a hypothetical future export defect, not an observed one.
    """
    tenant_id = row.get("tenant_id")
    if tenant_id is None or (isinstance(tenant_id, str) and tenant_id.strip() == ""):
        return QualityFailure(
            check="tenant_presence",
            reason="tenant_id is missing or blank",
            record_id=str(row.get("record_id", "")),
            tenant_id="",
        )
    return None


def check_receipt_date_consistency(row: dict[str, object]) -> QualityFailure | None:
    """Profile: "receipt_number populated but receipt_date null, on
    line_item rows" (31,743 rows). A within-row consistency check --
    this export folds receipt fields onto the line-item row itself, so
    there is no separate receipt record to cross-reference (see this
    module's docstring for why this replaces the originally proposed
    receipt/line-item referential-integrity check).

    receipt_number's own value is never echoed into `reason`: rows
    reaching this check have already been redacted by extract.py, so a
    populated receipt_number is the literal censor token
    ("[REDACTED]"), never real content -- but this check still avoids
    treating that token as informative, on the principle that a
    quality-check reason should never depend on a sensitive field's value
    even when that value happens to already be censored.
    """
    if row.get("record_type") != "line_item":
        return None
    receipt_number = row.get("receipt_number")
    receipt_date = row.get("receipt_date")
    if receipt_number is not None and receipt_date is None:
        return QualityFailure(
            check="receipt_date_consistency",
            reason="receipt_number is populated but receipt_date is null",
            record_id=str(row.get("record_id", "")),
            tenant_id=str(row.get("tenant_id", "")),
        )
    return None


ROW_LEVEL_CHECKS = (
    check_non_positive_amount,
    check_known_gl_code,
    check_tenant_presence,
    check_receipt_date_consistency,
)


def run_row_level_checks(row: dict[str, object]) -> list[QualityFailure]:
    """Run every row-level check against one row, returning all failures
    (a row can fail more than one check independently).
    """
    failures = []
    for check in ROW_LEVEL_CHECKS:
        failure = check(row)
        if failure is not None:
            failures.append(failure)
    return failures


def check_duplicate_record_id(rows: list[dict[str, object]]) -> list[QualityFailure]:
    """Profile: "record_id duplicated from the immediately preceding row"
    (39,920 rows, "Defect 6"; generator source: row["record_id"] =
    ids_seen[-1]). Batch-level by necessity: a duplicate cannot be
    identified from a single row in isolation, only by comparing each
    row's record_id against every record_id already seen earlier in the
    same batch/run.

    Every row whose record_id repeats one already seen is reported (the
    first occurrence is not flagged; only the repeat is), with row_index
    identifying its position in the batch so the offending row can be
    located without any other row-content lookup.
    """
    failures: list[QualityFailure] = []
    seen: set[str] = set()

    for index, row in enumerate(rows):
        record_id = str(row.get("record_id", ""))
        if record_id in seen:
            failures.append(
                QualityFailure(
                    check="duplicate_record_id",
                    reason=f"record_id {record_id!r} duplicates an earlier row in this batch",
                    record_id=record_id,
                    tenant_id=str(row.get("tenant_id", "")),
                    row_index=index,
                )
            )
        else:
            seen.add(record_id)

    return failures


def run_all_quality_checks(rows: list[dict[str, object]]) -> list[QualityFailure]:
    """Run every row-level check over every row, plus the one batch-level
    check over the whole batch, returning all failures found.
    """
    failures: list[QualityFailure] = []
    for row in rows:
        failures.extend(run_row_level_checks(row))
    failures.extend(check_duplicate_record_id(rows))
    return failures
