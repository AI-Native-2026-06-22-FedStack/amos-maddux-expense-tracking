"""Tests for extract.py's redaction-first behavior: every row is redacted
via the shared Module 3 redactor before extract() returns it, and a
redaction failure prevents the unredacted row from proceeding.
"""

from __future__ import annotations

import gzip
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))

from make_fixture import ROWS  # noqa: E402

from extract import extract  # noqa: E402
from redaction import RedactionError  # noqa: E402
from redaction import redact_row as _real_redact_row  # noqa: E402

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "tiny_export.jsonl.gz"


def _write_export(rows: list[dict[str, object]]) -> Path:
    with tempfile.NamedTemporaryFile(suffix=".jsonl.gz", delete=False) as tmp:
        path = Path(tmp.name)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row))
            f.write("\n")
    return path


def test_extract_redacts_receipt_number_on_every_row():
    result = extract(FIXTURE_PATH, run_id="redaction-test")

    line_item_rows = [row for row in result.rows if row["record_type"] == "line_item"]
    assert len(line_item_rows) > 0
    for row in line_item_rows:
        # The real fixture's receipt_number values (RCT-000001, etc.) must
        # never survive extract() unredacted.
        assert row["receipt_number"] == "[REDACTED]"


def test_extract_output_never_contains_the_original_synthetic_receipt_numbers():
    result = extract(FIXTURE_PATH, run_id="leak-check")

    serialized = json.dumps(result.rows)
    original_receipt_numbers = {
        row["receipt_number"] for row in ROWS if row["receipt_number"] is not None
    }
    assert len(original_receipt_numbers) > 0
    for original_value in original_receipt_numbers:
        assert original_value not in serialized


def test_extract_preserves_non_sensitive_fields_after_redaction():
    result = extract(FIXTURE_PATH, run_id="preserve-test")

    first_row = result.rows[0]
    assert first_row["tenant_id"] == ROWS[0]["tenant_id"]
    assert first_row["amount_cents"] == ROWS[0]["amount_cents"]
    assert first_row["gl_account_code"] == ROWS[0]["gl_account_code"]


def test_extract_propagates_redaction_error_and_does_not_return_the_row():
    path = _write_export([dict(ROWS[0])])

    try:
        with patch("extract.redact_row", side_effect=RedactionError("simulated failure")):
            with pytest.raises(RedactionError):
                extract(path, run_id="redaction-failure-test")
    finally:
        path.unlink()


def test_extract_redacts_before_any_row_is_appended():
    """A row is only ever appended to ExtractResult.rows after redact_row()
    succeeds -- if redaction fails partway through a multi-row file, no
    unredacted row from that file is returned at all (extract() raises
    instead of returning a partial, mixed-redaction result).
    """
    path = _write_export([dict(ROWS[0]), dict(ROWS[1])])

    call_count = {"n": 0}

    def fail_on_second_row(row):
        call_count["n"] += 1
        if call_count["n"] == 2:
            raise RedactionError("simulated failure on second row")
        return _real_redact_row(row)

    try:
        with patch("extract.redact_row", side_effect=fail_on_second_row):
            with pytest.raises(RedactionError):
                extract(path, run_id="partial-failure-test")
    finally:
        path.unlink()
