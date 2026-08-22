"""Tests for redaction.py: the extract-time application of the existing
Module 3 boundary redactor (services/compute/app/log_redaction.py) to
every incoming row, and the requirement that redaction failure prevents
the unredacted row from proceeding.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from redaction import RedactionError, redact_row  # noqa: E402


def test_redact_row_censors_receipt_number():
    row = {"receipt_number": "RCT-000001", "tenant_id": "t1"}

    result = redact_row(row)

    assert result["receipt_number"] == "[REDACTED]"
    assert result["tenant_id"] == "t1"


def test_redact_row_censors_nested_payment_identifiers():
    row = {"tenant_id": "t1", "nested": {"payment_id": "PAY-000001"}}

    result = redact_row(row)

    assert result["nested"]["payment_id"] == "[REDACTED]"


def test_redact_row_reuses_the_shared_module_3_censor_value():
    # Proves this module depends on the real shared redactor's config
    # rather than a second, independently-declared censor string.
    # redaction.py's own sys.path setup makes services/compute/app
    # importable as `app`.
    from app.log_redaction import SENSITIVE_LOG_CENSOR  # noqa: E402

    result = redact_row({"receipt_number": "RCT-anything"})

    assert result["receipt_number"] == SENSITIVE_LOG_CENSOR


def test_redact_row_leaves_non_sensitive_fields_untouched():
    row = {
        "tenant_id": "t1",
        "gl_account_code": "6100",
        "amount_cents": 5000,
        "receipt_date": "2026-01-05",  # not a sensitive key, unlike receipt_number
    }

    result = redact_row(row)

    assert result == row


def test_redact_row_raises_redaction_error_when_the_shared_redactor_fails():
    with patch("redaction.redact_sensitive_fields", side_effect=RuntimeError("boom")):
        with pytest.raises(RedactionError):
            redact_row({"receipt_number": "RCT-000001"})


def test_redaction_error_message_does_not_leak_the_row_contents():
    # A redaction failure's own error message must not become a second
    # leak path for the very data redaction was supposed to protect.
    with patch("redaction.redact_sensitive_fields", side_effect=RuntimeError("boom")):
        try:
            redact_row({"receipt_number": "RCT-SUPER-SECRET"})
        except RedactionError as exc:
            assert "RCT-SUPER-SECRET" not in str(exc)
