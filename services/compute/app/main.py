import logging
import sys
from collections.abc import Awaitable, Callable
from decimal import Decimal
from uuid import UUID

import structlog
from fastapi import Depends, FastAPI, HTTPException, Request, Response

from app.auth import CurrentUser, get_current_user
from app.coding import DbSession, code_expense_report, load_mileage_reimbursement_rate
from app.db import get_db_session
from app.gl_coding_contract import GlCodingRequest, GlCodingResponse
from app.log_redaction import redact_sensitive_fields
from app.shared_schema import (
    validate_gl_coding_request_contract,
    validate_gl_coding_response_contract,
)

CORRELATION_ID_HEADER = "X-Correlation-Id"
REQUEST_ID_HEADER = "X-Request-Id"


def configure_logging() -> None:
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=logging.INFO, force=True)
    logging.getLogger("uvicorn.access").disabled = True
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            redact_sensitive_fields,
            structlog.processors.JSONRenderer(),
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )


configure_logging()
logger = structlog.get_logger(__name__)

app = FastAPI()


@app.middleware("http")
async def bind_correlation_id(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    correlation_id = read_correlation_id(request)

    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(correlationId=correlation_id)

    logger.info("request.started", method=request.method, path=request.url.path)

    try:
        response = await call_next(request)
        logger.info(
            "request.completed",
            method=request.method,
            path=request.url.path,
            status_code=response.status_code,
        )

        if correlation_id is not None:
            response.headers[CORRELATION_ID_HEADER] = correlation_id

        return response
    finally:
        structlog.contextvars.clear_contextvars()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/me", response_model=CurrentUser)
def read_current_user(current_user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    return current_user


@app.post("/v1/coding", response_model=GlCodingResponse)
def code_gl_items(
    request: GlCodingRequest,
    db_session: DbSession = Depends(get_db_session),
    current_user: CurrentUser = Depends(get_current_user),
) -> GlCodingResponse:
    validate_gl_coding_request_contract(request)
    response = code_expense_report(
        request,
        tenant_id=_parse_tenant_id(current_user.tenant_id),
        db_session=db_session,
        mileage_rate=load_mileage_reimbursement_rate(),
    )
    validate_gl_coding_response_contract(response)

    return response


def read_correlation_id(request: Request) -> str | None:
    correlation_id = request.headers.get(CORRELATION_ID_HEADER)
    if correlation_id is not None and correlation_id.strip() != "":
        return correlation_id

    request_id = request.headers.get(REQUEST_ID_HEADER)
    if request_id is not None and request_id.strip() != "":
        return request_id

    return None


def _parse_tenant_id(tenant_id: str) -> UUID:
    try:
        return UUID(tenant_id)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc
