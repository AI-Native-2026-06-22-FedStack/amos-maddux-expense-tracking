"""AI Assist endpoint orchestration for ExpenseFlow policy questions."""

from __future__ import annotations

import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from fastapi import HTTPException
from pydantic import BaseModel, Field

from app.auth import CurrentUser

ROOT_DIR = Path(__file__).resolve().parents[3]
RETRIEVAL_DIR = ROOT_DIR / "services" / "retrieval"
RETRIEVAL_EVAL_DIR = RETRIEVAL_DIR / "eval"
RETRIEVAL_SAFETY_DIR = RETRIEVAL_DIR / "safety"
for path in (RETRIEVAL_DIR, RETRIEVAL_EVAL_DIR, RETRIEVAL_SAFETY_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from rag_pipeline import PolicyAnswer, PolicyRagConfig, PolicyRagPipeline  # noqa: E402
from validator import (  # noqa: E402
    AssistAnswer,
    OutputValidationError,
    RetrievedCitationMetadata,
    validate_assist_model_output,
)

GPT_4O_MINI_INPUT_PER_TOKEN_USD = 0.15 / 1_000_000
GPT_4O_MINI_OUTPUT_PER_TOKEN_USD = 0.60 / 1_000_000
REDACTION_CENSOR = "[REDACTED]"


class AssistRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)


class AssistCitationResponse(BaseModel):
    chunk_id: str
    source: str
    section_id: str
    quote: str | None = None


class AssistResponse(BaseModel):
    answer: str
    citations: list[AssistCitationResponse]


@dataclass(frozen=True)
class AssistAuditRecord:
    redacted_prompt: str
    response: str
    citations: list[dict[str, str | None]]
    timestamp: datetime
    requester: str
    tenant_id: str
    cost_usd: float
    latency_ms: float


class AssistAuditWriter(Protocol):
    def write(self, record: AssistAuditRecord) -> None: ...


class StructlogAssistAuditWriter:
    """Append AI-assist audit facts to structured logs.

    The existing database audit_entry schema is Expense Report scoped and
    requires expense_report_id, so it cannot correctly represent a general
    policy-assistant invocation without inventing a report id.
    """

    def write(self, record: AssistAuditRecord) -> None:
        import structlog

        structlog.get_logger(__name__).info(
            "ai_assist.audit",
            redacted_prompt=record.redacted_prompt,
            response=record.response,
            citations=record.citations,
            timestamp=record.timestamp.isoformat(),
            requester=record.requester,
            tenant_id=record.tenant_id,
            cost_usd=record.cost_usd,
            latency_ms=record.latency_ms,
        )


class Redactor(Protocol):
    def redact(self, text: str) -> str: ...


class PromptRedactor:
    def redact(self, text: str) -> str:
        if text.strip() == "":
            raise ValueError("question is blank")
        redacted = re.sub(r"\b\d{3}-?\d{2}-?\d{4}\b", REDACTION_CENSOR, text)
        redacted = re.sub(
            r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
            REDACTION_CENSOR,
            redacted,
            flags=re.IGNORECASE,
        )
        redacted = re.sub(r"\b(?:\d[ -]?){13,16}\b", REDACTION_CENSOR, redacted)
        return redacted


class AssistPipeline(Protocol):
    def answer_question(self, question: str) -> PolicyAnswer: ...


class AssistService:
    def __init__(
        self,
        *,
        pipeline_factory: type[PolicyRagPipeline] = PolicyRagPipeline,
        redactor: Redactor | None = None,
        audit_writer: AssistAuditWriter | None = None,
        clock=time.perf_counter,
    ) -> None:
        self.pipeline_factory = pipeline_factory
        self.redactor = redactor or PromptRedactor()
        self.audit_writer = audit_writer or StructlogAssistAuditWriter()
        self.clock = clock

    def answer(self, request: AssistRequest, current_user: CurrentUser) -> AssistResponse:
        started = self.clock()
        try:
            redacted_question = self.redactor.redact(request.question)
        except Exception as exc:
            raise HTTPException(
                status_code=422,
                detail="Question could not be safely redacted",
            ) from exc

        pipeline = self.pipeline_factory(
            config=PolicyRagConfig(tenant_id=current_user.tenant_id)
        )
        policy_answer = pipeline.answer_question(redacted_question)

        raw_structured_output = _raw_structured_output_from_policy_answer(policy_answer)
        retrieved_metadata = [
            RetrievedCitationMetadata(
                chunk_id=item["chunk_id"],
                source=item["source"],
                section_id=item["section_id"],
            )
            for item in policy_answer.citation_metadata
        ]
        try:
            validated = validate_assist_model_output(
                raw_structured_output,
                retrieved_chunks=retrieved_metadata,
            )
        except OutputValidationError as exc:
            raise HTTPException(
                status_code=502,
                detail="AI assist output failed validation",
            ) from exc

        cost_usd = _calculate_generation_cost(policy_answer)
        latency_ms = (self.clock() - started) * 1000
        response = _response_from_validated_answer(validated)
        self.audit_writer.write(
            AssistAuditRecord(
                redacted_prompt=redacted_question,
                response=response.answer,
                citations=[citation.model_dump() for citation in response.citations],
                timestamp=datetime.now(timezone.utc),
                requester=current_user.user_id,
                tenant_id=current_user.tenant_id,
                cost_usd=cost_usd,
                latency_ms=latency_ms,
            )
        )
        return response


def _raw_structured_output_from_policy_answer(policy_answer: PolicyAnswer) -> str:
    return policy_answer.answer


def _response_from_validated_answer(answer: AssistAnswer) -> AssistResponse:
    return AssistResponse(
        answer=answer.answer,
        citations=[
            AssistCitationResponse(
                chunk_id=citation.chunk_id,
                source=citation.source,
                section_id=citation.section_id,
                quote=citation.quote,
            )
            for citation in answer.citations
        ],
    )


def _calculate_generation_cost(policy_answer: PolicyAnswer) -> float:
    usage = policy_answer.generation_usage
    return (
        usage.input_tokens * GPT_4O_MINI_INPUT_PER_TOKEN_USD
        + usage.output_tokens * GPT_4O_MINI_OUTPUT_PER_TOKEN_USD
    )


def get_assist_service() -> AssistService:
    return AssistService()
