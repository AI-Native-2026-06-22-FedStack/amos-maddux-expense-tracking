import json
from pathlib import Path
from typing import Any

from structlog.typing import EventDict, WrappedLogger

CONFIG_PATH = Path(__file__).resolve().parents[3] / "config" / "sensitive-log-fields.json"


def _load_config() -> dict[str, Any]:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


_CONFIG = _load_config()
SENSITIVE_LOG_CENSOR = _CONFIG["censor"]
SENSITIVE_LOG_KEYS = frozenset(key.lower() for key in _CONFIG["python"]["keys"])


def redact_sensitive_fields(
    _logger: WrappedLogger,
    _method_name: str,
    event_dict: EventDict,
) -> EventDict:
    return _redact_value(event_dict)


def _redact_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: SENSITIVE_LOG_CENSOR
            if str(key).lower() in SENSITIVE_LOG_KEYS
            else _redact_value(child)
            for key, child in value.items()
        }

    if isinstance(value, list):
        return [_redact_value(item) for item in value]

    if isinstance(value, tuple):
        return tuple(_redact_value(item) for item in value)

    return value
