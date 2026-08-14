from app.redaction import redact_tax_identifier_for_log


# ruleid: no-taxpayer-id-in-error-log-py
def log_taxpayer_verification_failure_known_bad(tax_identifier: str, error: Exception) -> None:
    logger.error("Taxpayer verification failed", tax_identifier, error)


# ok: no-taxpayer-id-in-error-log-py
def log_taxpayer_verification_failure_known_good(tax_identifier: str, error: Exception) -> None:
    logger.error(
        "Taxpayer verification failed",
        redact_tax_identifier_for_log(tax_identifier),
        error,
    )
