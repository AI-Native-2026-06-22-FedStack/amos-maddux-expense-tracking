from __future__ import annotations

import importlib
import json
from types import ModuleType

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from rag_pipeline import UsageTotals

from app.assist import AssistCitationResponse


def test_v1_assist_returns_valid_structured_cited_response(monkeypatch: pytest.MonkeyPatch):
    main = _load_test_main(monkeypatch)
    service = FakeAssistService(
        main.AssistResponse(
            answer="Receipts are required above the general threshold.",
            citations=[
                    AssistCitationResponse(
                    chunk_id="NWP-POL-006-01",
                    source="data/corpus/006-receipt-and-documentation-policy.md",
                    section_id="NWP-POL-006-01",
                )
            ],
        )
    )
    main.app.dependency_overrides[main.get_current_user] = lambda: main.CurrentUser(
        user_id="user-synthetic-assist",
        tenant_id="tenant-synthetic-northwind-prairie",
        role="Employee",
    )
    main.app.dependency_overrides[main.get_assist_service] = lambda: service
    client = TestClient(main.app)

    response = client.post("/v1/assist", json={"question": "Do I need a receipt?"})

    assert response.status_code == 200
    assert response.json() == {
        "answer": "Receipts are required above the general threshold.",
        "citations": [
            {
                "chunk_id": "NWP-POL-006-01",
                "source": "data/corpus/006-receipt-and-documentation-policy.md",
                "section_id": "NWP-POL-006-01",
                "quote": None,
            }
        ],
    }
    assert service.received_user.tenant_id == "tenant-synthetic-northwind-prairie"


def test_redaction_occurs_before_external_model_boundary(monkeypatch: pytest.MonkeyPatch):
    assist = _load_assist(monkeypatch)
    audit_writer = RecordingAuditWriter()
    pipeline_factory = RecordingPipelineFactory(_valid_policy_answer(assist))
    service = assist.AssistService(
        pipeline_factory=pipeline_factory,
        audit_writer=audit_writer,
        clock=StepClock(10.0, 10.2),
    )

    service.answer(
        assist.AssistRequest(question="Does synthetic.user@example.test need a receipt?"),
        _current_user(assist),
    )

    assert pipeline_factory.last_question == "Does [REDACTED] need a receipt?"
    assert "synthetic.user@example.test" not in pipeline_factory.last_question


def test_redaction_failure_prevents_model_call(monkeypatch: pytest.MonkeyPatch):
    assist = _load_assist(monkeypatch)
    pipeline_factory = RecordingPipelineFactory(_valid_policy_answer(assist))
    service = assist.AssistService(
        pipeline_factory=pipeline_factory,
        redactor=FailingRedactor(),
        audit_writer=RecordingAuditWriter(),
    )

    with pytest.raises(HTTPException) as exc_info:
        service.answer(assist.AssistRequest(question="Can I submit this?"), _current_user(assist))

    assert exc_info.value.status_code == 422
    assert pipeline_factory.calls == 0


def test_validation_failure_prevents_invalid_answer_from_api_response(
    monkeypatch: pytest.MonkeyPatch,
):
    assist = _load_assist(monkeypatch)
    service = assist.AssistService(
        pipeline_factory=RecordingPipelineFactory(
            _policy_answer(assist, raw_answer="not json", citation_chunk_id="NWP-POL-006-01")
        ),
        audit_writer=RecordingAuditWriter(),
    )

    with pytest.raises(HTTPException) as exc_info:
        service.answer(assist.AssistRequest(question="Do I need a receipt?"), _current_user(assist))

    assert exc_info.value.status_code == 502


def test_fabricated_citation_cannot_be_delivered(monkeypatch: pytest.MonkeyPatch):
    assist = _load_assist(monkeypatch)
    raw_answer = json.dumps(
        {
            "answer": "This cites a plausible but unretrieved chunk.",
            "citations": [
                {
                    "chunk_id": "NWP-POL-012-05",
                    "source": "data/corpus/012-expense-report-submission-and-audit-policy.md",
                    "section_id": "NWP-POL-012-05",
                }
            ],
        }
    )
    service = assist.AssistService(
        pipeline_factory=RecordingPipelineFactory(
            _policy_answer(assist, raw_answer=raw_answer, citation_chunk_id="NWP-POL-006-01")
        ),
        audit_writer=RecordingAuditWriter(),
    )

    with pytest.raises(HTTPException) as exc_info:
        service.answer(assist.AssistRequest(question="When is this due?"), _current_user(assist))

    assert exc_info.value.status_code == 502


def test_audit_writer_receives_redacted_prompt_not_original_synthetic_pii(
    monkeypatch: pytest.MonkeyPatch,
):
    assist = _load_assist(monkeypatch)
    audit_writer = RecordingAuditWriter()
    service = assist.AssistService(
        pipeline_factory=RecordingPipelineFactory(_valid_policy_answer(assist)),
        audit_writer=audit_writer,
        clock=StepClock(20.0, 20.125),
    )

    service.answer(
        assist.AssistRequest(question="Can employee 123-45-6789 submit this?"),
        _current_user(assist),
    )

    assert audit_writer.records[0].redacted_prompt == "Can employee [REDACTED] submit this?"
    assert "123-45-6789" not in audit_writer.records[0].redacted_prompt


def test_cost_is_based_on_actual_usage(monkeypatch: pytest.MonkeyPatch):
    assist = _load_assist(monkeypatch)
    audit_writer = RecordingAuditWriter()
    service = assist.AssistService(
        pipeline_factory=RecordingPipelineFactory(
            _valid_policy_answer(assist, input_tokens=1000, output_tokens=250)
        ),
        audit_writer=audit_writer,
        clock=StepClock(1.0, 1.1),
    )

    service.answer(assist.AssistRequest(question="Do I need a receipt?"), _current_user(assist))

    expected = 1000 * assist.GPT_4O_MINI_INPUT_PER_TOKEN_USD
    expected += 250 * assist.GPT_4O_MINI_OUTPUT_PER_TOKEN_USD
    assert audit_writer.records[0].cost_usd == pytest.approx(expected)


def test_latency_uses_elapsed_clock(monkeypatch: pytest.MonkeyPatch):
    assist = _load_assist(monkeypatch)
    audit_writer = RecordingAuditWriter()
    service = assist.AssistService(
        pipeline_factory=RecordingPipelineFactory(_valid_policy_answer(assist)),
        audit_writer=audit_writer,
        clock=StepClock(30.0, 30.333),
    )

    service.answer(assist.AssistRequest(question="Do I need a receipt?"), _current_user(assist))

    assert audit_writer.records[0].latency_ms == pytest.approx(333.0)


def _load_test_main(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    import app.main

    main = importlib.reload(app.main)
    main.app.dependency_overrides.clear()
    return main


def _load_assist(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    import app.assist

    return importlib.reload(app.assist)


def _current_user(assist: ModuleType):
    return assist.CurrentUser(
        user_id="user-synthetic-assist",
        tenant_id="tenant-synthetic-northwind-prairie",
        role="Employee",
    )


def _valid_policy_answer(
    assist: ModuleType, *, input_tokens: int = 123, output_tokens: int = 45
):
    raw_answer = json.dumps(
        {
            "answer": "Receipts are required above the general threshold.",
            "citations": [
                {
                    "chunk_id": "NWP-POL-006-01",
                    "source": "data/corpus/006-receipt-and-documentation-policy.md",
                    "section_id": "NWP-POL-006-01",
                }
            ],
        }
    )
    return _policy_answer(
        assist,
        raw_answer=raw_answer,
        citation_chunk_id="NWP-POL-006-01",
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )


def _policy_answer(
    assist: ModuleType,
    *,
    raw_answer: str,
    citation_chunk_id: str,
    input_tokens: int = 123,
    output_tokens: int = 45,
):
    return assist.PolicyAnswer(
        question="Do I need a receipt?",
        answer=raw_answer,
        contexts=["Synthetic policy context."],
        citation_metadata=[
            {
                "chunk_id": citation_chunk_id,
                "source": "data/corpus/006-receipt-and-documentation-policy.md",
                "section_id": citation_chunk_id,
            }
        ],
        context_chunk_ids=[citation_chunk_id],
        retrieved_chunk_ids=[citation_chunk_id],
        reranked_chunk_ids=[citation_chunk_id],
        generation_model_family="gpt-4o-mini",
        resolved_generation_model_id="gpt-4o-mini-2024-07-18",
        generation_usage=UsageTotals(
            call_count=1,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        ),
        rerank_resolved_model_id="gpt-4o-mini-2024-07-18",
        rerank_api_requests=1,
    )


class FakeAssistService:
    def __init__(self, response):
        self.response = response
        self.received_request = None
        self.received_user = None

    def answer(self, request, current_user):
        self.received_request = request
        self.received_user = current_user
        return self.response


class RecordingPipeline:
    def __init__(self, factory: "RecordingPipelineFactory") -> None:
        self.factory = factory

    def answer_question(self, question: str):
        self.factory.calls += 1
        self.factory.last_question = question
        return self.factory.answer


class RecordingPipelineFactory:
    def __init__(self, answer) -> None:
        self.answer = answer
        self.calls = 0
        self.last_question = None
        self.last_config = None

    def __call__(self, *, config):
        self.last_config = config
        return RecordingPipeline(self)


class RecordingAuditWriter:
    def __init__(self) -> None:
        self.records = []

    def write(self, record) -> None:
        self.records.append(record)


class FailingRedactor:
    def redact(self, text: str) -> str:
        raise ValueError("synthetic redaction failure")


class StepClock:
    def __init__(self, *values: float) -> None:
        self.values = list(values)

    def __call__(self) -> float:
        return self.values.pop(0)
