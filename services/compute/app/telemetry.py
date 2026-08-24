import os

from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.trace import INVALID_TRACE_ID, format_trace_id

TRACE_ID_LOG_FIELD = "traceId"
ZERO_TRACE_ID = "00000000000000000000000000000000"


def configure_tracing() -> None:
    if os.getenv("OTEL_SDK_DISABLED", "false").lower() == "true":
        return

    if getattr(trace, "_expenseflow_configured", False):
        return

    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": os.getenv(
                    "OTEL_SERVICE_NAME",
                    "expenseflow-gl-coding-engine",
                )
            }
        )
    )
    provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(
                endpoint=os.getenv(
                    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                    "http://localhost:4318/v1/traces",
                )
            )
        )
    )
    trace.set_tracer_provider(provider)
    setattr(trace, "_expenseflow_configured", True)


def instrument_fastapi_app(app: FastAPI) -> None:
    if os.getenv("OTEL_SDK_DISABLED", "false").lower() == "true":
        return

    if getattr(app.state, "expenseflow_otel_instrumented", False):
        return

    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    FastAPIInstrumentor.instrument_app(app)
    app.state.expenseflow_otel_instrumented = True


def read_current_trace_id() -> str | None:
    span_context = trace.get_current_span().get_span_context()
    if span_context.trace_id == INVALID_TRACE_ID:
        return None

    trace_id = format_trace_id(span_context.trace_id)

    return trace_id if trace_id != ZERO_TRACE_ID else None


def read_trace_id_from_traceparent(traceparent: str | None) -> str | None:
    if traceparent is None:
        return None

    parts = traceparent.strip().split("-")
    if len(parts) < 4:
        return None

    trace_id = parts[1]

    if len(trace_id) != 32 or trace_id == ZERO_TRACE_ID:
        return None

    try:
        int(trace_id, 16)
    except ValueError:
        return None

    return trace_id
