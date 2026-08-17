import logging
import sys
from collections.abc import Mapping
from uuid import UUID

import structlog
from fastapi import Depends, FastAPI, HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.auth import CurrentUser, get_current_user
from app.coding import DbSession, code_expense_report, load_mileage_reimbursement_rate
from app.db import get_db_session
from app.gl_coding_contract import GlCodingRequest, GlCodingResponse
from app.log_redaction import redact_sensitive_fields
from app.shared_schema import (
    validate_gl_coding_request_contract,
    validate_gl_coding_response_contract,
)
from app.telemetry import (
    TRACE_ID_LOG_FIELD,
    configure_tracing,
    instrument_fastapi_app,
    read_current_trace_id,
    read_trace_id_from_traceparent,
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
configure_tracing()
logger = structlog.get_logger(__name__)

app = FastAPI()
instrument_fastapi_app(app)


class CorrelationTraceLogMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = read_headers(scope)
        correlation_id = read_correlation_id(headers)
        trace_id = read_current_trace_id() or read_trace_id_from_traceparent(
            headers.get("traceparent")
        )
        method = str(scope["method"])
        path = str(scope["path"])
        status_code: int | None = None

        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(correlationId=correlation_id)
        if trace_id is not None:
            structlog.contextvars.bind_contextvars(**{TRACE_ID_LOG_FIELD: trace_id})

        logger.info("request.started", method=method, path=path)

        async def send_with_correlation(message: Message) -> None:
            nonlocal status_code

            if message["type"] == "http.response.start":
                status_code = int(message["status"])
                if correlation_id is not None:
                    response_headers = list(message.get("headers", []))
                    response_headers.append(
                        (CORRELATION_ID_HEADER.lower().encode(), correlation_id.encode())
                    )
                    message["headers"] = response_headers

            await send(message)

        try:
            await self.app(scope, receive, send_with_correlation)
            logger.info(
                "request.completed",
                method=method,
                path=path,
                status_code=status_code,
            )
        finally:
            structlog.contextvars.clear_contextvars()


app.add_middleware(CorrelationTraceLogMiddleware)


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


def read_headers(scope: Scope) -> dict[str, str]:
    return {
        key.decode("latin-1").lower(): value.decode("latin-1")
        for key, value in scope.get("headers", [])
    }


def read_correlation_id(headers: Mapping[str, str]) -> str | None:
    correlation_id = headers.get(CORRELATION_ID_HEADER.lower())
    if correlation_id is not None and correlation_id.strip() != "":
        return correlation_id

    request_id = headers.get(REQUEST_ID_HEADER.lower())
    if request_id is not None and request_id.strip() != "":
        return request_id

    return None


def _parse_tenant_id(tenant_id: str) -> UUID:
    try:
        return UUID(tenant_id)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc
