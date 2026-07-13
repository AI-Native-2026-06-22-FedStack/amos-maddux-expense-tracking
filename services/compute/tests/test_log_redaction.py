import io
import json
import logging

import structlog

from app.log_redaction import SENSITIVE_LOG_CENSOR, SENSITIVE_LOG_KEYS, redact_sensitive_fields

RAW_SENSITIVE_VALUES = [
    "synthetic-authorization-secret",
    "synthetic-token-secret",
    "synthetic-access-token-secret",
    "synthetic-refresh-token-secret",
    "synthetic-token-hash-secret",
    "synthetic-password-secret",
    "synthetic-credentials-secret",
    "synthetic-receipt-secret",
    "synthetic-receipt-data-secret",
    "synthetic-receipt-number-secret",
    "synthetic-receipt-email@example.test",
    "synthetic-receipt-phone-secret",
    "synthetic-receipt-address-secret",
    "synthetic-payment-secret",
    "synthetic-payment-id-secret",
    "synthetic-payment-data-secret",
    "synthetic-account-number-secret",
    "synthetic-bank-account-number-secret",
    "synthetic-card-number-secret",
    "synthetic-routing-number-secret",
]


def test_success_log_redacts_sensitive_fields_before_json_rendering() -> None:
    output = io.StringIO()
    logger = _configure_test_logger(output)

    logger.info("synthetic.success", **_sensitive_payload())

    _assert_sensitive_values_redacted(output.getvalue())


def test_error_log_redacts_sensitive_fields_before_json_rendering() -> None:
    output = io.StringIO()
    logger = _configure_test_logger(output)

    logger.error(
        "synthetic.error",
        error="Synthetic error for redaction coverage.",
        **_sensitive_payload(),
    )

    _assert_sensitive_values_redacted(output.getvalue())


def test_nested_and_array_sensitive_fields_are_redacted_before_json_rendering() -> None:
    output = io.StringIO()
    logger = _configure_test_logger(output)

    logger.info(
        "synthetic.nested",
        nested={
            "payment_id": "synthetic-payment-id-secret",
            "receipt_data": "synthetic-receipt-data-secret",
        },
        items=[
            {
                "access_token": "synthetic-access-token-secret",
                "account_number": "synthetic-account-number-secret",
            }
        ],
    )

    parsed_output = json.loads(output.getvalue())

    assert parsed_output["nested"]["payment_id"] == SENSITIVE_LOG_CENSOR
    assert parsed_output["nested"]["receipt_data"] == SENSITIVE_LOG_CENSOR
    assert parsed_output["items"][0]["access_token"] == SENSITIVE_LOG_CENSOR
    assert parsed_output["items"][0]["account_number"] == SENSITIVE_LOG_CENSOR
    for raw_sensitive_value in [
        "synthetic-payment-id-secret",
        "synthetic-receipt-data-secret",
        "synthetic-access-token-secret",
        "synthetic-account-number-secret",
    ]:
        assert raw_sensitive_value not in output.getvalue()


def test_authorization_headers_are_redacted_case_insensitively() -> None:
    output = io.StringIO()
    logger = _configure_test_logger(output)

    logger.info(
        "synthetic.headers",
        headers={
            "Authorization": "synthetic-authorization-secret",
            "authorization": "synthetic-token-secret",
        },
    )

    parsed_output = json.loads(output.getvalue())

    assert parsed_output["headers"]["Authorization"] == SENSITIVE_LOG_CENSOR
    assert parsed_output["headers"]["authorization"] == SENSITIVE_LOG_CENSOR
    assert "synthetic-authorization-secret" not in output.getvalue()
    assert "synthetic-token-secret" not in output.getvalue()


def test_shared_redaction_keys_cover_payment_identifiers_and_receipt_data() -> None:
    assert {"payment_id", "receipt_data", "account_number"}.issubset(SENSITIVE_LOG_KEYS)


def _configure_test_logger(output: io.StringIO) -> structlog.stdlib.BoundLogger:
    handler = logging.StreamHandler(output)
    root_logger = logging.getLogger("synthetic-redaction-test")
    root_logger.handlers = [handler]
    root_logger.setLevel(logging.INFO)
    root_logger.propagate = False

    structlog.configure(
        processors=[
            redact_sensitive_fields,
            structlog.processors.JSONRenderer(),
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=False,
    )

    return structlog.get_logger("synthetic-redaction-test")


def _sensitive_payload() -> dict[str, object]:
    return {
        "authorization": "synthetic-authorization-secret",
        "token": "synthetic-token-secret",
        "access_token": "synthetic-access-token-secret",
        "refresh_token": "synthetic-refresh-token-secret",
        "token_hash": "synthetic-token-hash-secret",
        "password": "synthetic-password-secret",
        "credentials": "synthetic-credentials-secret",
        "receipt": "synthetic-receipt-secret",
        "receipt_data": "synthetic-receipt-data-secret",
        "receipt_number": "synthetic-receipt-number-secret",
        "receipt_email": "synthetic-receipt-email@example.test",
        "receipt_phone": "synthetic-receipt-phone-secret",
        "receipt_address": "synthetic-receipt-address-secret",
        "payment": "synthetic-payment-secret",
        "payment_id": "synthetic-payment-id-secret",
        "payment_data": "synthetic-payment-data-secret",
        "account_number": "synthetic-account-number-secret",
        "bank_account_number": "synthetic-bank-account-number-secret",
        "card_number": "synthetic-card-number-secret",
        "routing_number": "synthetic-routing-number-secret",
        "nested": {
            "token": "synthetic-token-secret",
            "receipt_data": "synthetic-receipt-data-secret",
            "payment_id": "synthetic-payment-id-secret",
        },
        "items": [
            {
                "access_token": "synthetic-access-token-secret",
                "account_number": "synthetic-account-number-secret",
            }
        ],
    }


def _assert_sensitive_values_redacted(output: str) -> None:
    parsed_output = json.loads(output)

    for raw_sensitive_value in RAW_SENSITIVE_VALUES:
        assert raw_sensitive_value not in output

    assert SENSITIVE_LOG_CENSOR in output
    assert parsed_output["authorization"] == SENSITIVE_LOG_CENSOR
    assert parsed_output["nested"]["payment_id"] == SENSITIVE_LOG_CENSOR
    assert parsed_output["items"][0]["account_number"] == SENSITIVE_LOG_CENSOR
