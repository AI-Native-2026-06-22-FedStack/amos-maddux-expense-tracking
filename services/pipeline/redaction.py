"""Redaction for incoming pipeline rows, reusing the existing Module 3
boundary redactor (services/compute/app/log_redaction.py) rather than
creating a second, competing sensitive-field policy.

log_redaction.redact_sensitive_fields is a structlog processor, but its
actual logic (_redact_value: a recursive dict/list/tuple walk censoring
any key in SENSITIVE_LOG_KEYS) is generic -- it takes an arbitrary mapping
and returns a redacted copy, with no dependency on structlog's own log
pipeline beyond the (_logger, _method_name, event_dict) call signature
structlog processors share. redact_row() below calls that exact function
with a plain expense row standing in for event_dict, so this module
depends on the one real implementation and its one real config file
(config/sensitive-log-fields.json) instead of re-declaring
SENSITIVE_LOG_KEYS/SENSITIVE_LOG_CENSOR here.

services/compute is imported by path (sys.path, matching this repo's own
cross-directory import convention already used in
tests/test_equivalence_check.py) because services/pipeline and
services/compute are two separate uv projects with no shared package
boundary (ADR-0006's service-boundary split) -- extending sys.path is the
established way this codebase reaches across that split for shared,
non-domain-owned code such as this redactor.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

_COMPUTE_APP_ROOT = Path(__file__).resolve().parents[1] / "compute"
if str(_COMPUTE_APP_ROOT) not in sys.path:
    sys.path.insert(0, str(_COMPUTE_APP_ROOT))

from app.log_redaction import redact_sensitive_fields  # noqa: E402


class RedactionError(RuntimeError):
    """Raised when redaction itself fails for a row.

    The caller (extract.py) must not let the unredacted row proceed when
    this is raised -- see extract.py's own docstring.
    """


def redact_row(row: dict[str, Any]) -> dict[str, Any]:
    """Redact one row using the shared Module 3 redactor.

    Reuses log_redaction.redact_sensitive_fields exactly as structlog
    itself would call it -- logger and method_name are unused by that
    function's own implementation, so None/"" stand in for them here.
    Raises RedactionError (chained from the original exception) if the
    shared redactor itself errors, so a redaction failure is distinguishable
    from a normal validation failure and the row is never returned
    unredacted.
    """
    try:
        return dict(redact_sensitive_fields(None, "", row))
    except Exception as exc:
        raise RedactionError(f"redaction failed for a row: {exc}") from exc
