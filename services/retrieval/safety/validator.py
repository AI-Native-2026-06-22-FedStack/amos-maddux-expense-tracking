"""Fail-closed structured-output validator for ExpenseFlow AI Assist.

The validator is intended to run after model generation and before API
delivery. It accepts only the structured JSON answer contract below and
verifies that every citation references a chunk from the retrieved result
set supplied for the exact query.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


class OutputValidationError(ValueError):
    """Raised when model output must not be delivered to the caller."""


@dataclass(frozen=True)
class AssistCitation:
    chunk_id: str
    source: str
    section_id: str
    quote: str | None = None


@dataclass(frozen=True)
class AssistAnswer:
    answer: str
    citations: tuple[AssistCitation, ...]


@dataclass(frozen=True)
class RetrievedCitationMetadata:
    chunk_id: str
    source: str
    section_id: str


def validate_assist_model_output(
    raw_model_output: str,
    *,
    retrieved_chunks: list[RetrievedCitationMetadata],
) -> AssistAnswer:
    """Parse and validate one generated AI-Assist answer.

    Expected JSON contract:

    {
      "answer": "Generated ExpenseFlow policy answer.",
      "citations": [
        {
          "chunk_id": "NWP-POL-006-01",
          "source": "data/corpus/006-receipt-and-documentation-policy.md",
          "section_id": "NWP-POL-006-01",
          "quote": "Optional short supporting excerpt."
        }
      ]
    }

    Any validation failure raises OutputValidationError. The caller must
    treat that exception as a controlled failure and must not deliver the
    raw model response.
    """

    try:
        payload = json.loads(raw_model_output)
    except json.JSONDecodeError as exc:
        raise OutputValidationError("model output is not valid JSON") from exc

    if not isinstance(payload, dict):
        raise OutputValidationError("model output must be a JSON object")

    answer = payload.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        raise OutputValidationError("model output must include a non-empty string answer")

    raw_citations = payload.get("citations")
    if not isinstance(raw_citations, list) or not raw_citations:
        raise OutputValidationError("model output must include at least one citation")

    retrieved_by_chunk_id = {chunk.chunk_id: chunk for chunk in retrieved_chunks}
    citations = tuple(
        _validate_citation(raw_citation, retrieved_by_chunk_id)
        for raw_citation in raw_citations
    )
    return AssistAnswer(answer=answer, citations=citations)


def _validate_citation(
    raw_citation: Any,
    retrieved_by_chunk_id: dict[str, RetrievedCitationMetadata],
) -> AssistCitation:
    if not isinstance(raw_citation, dict):
        raise OutputValidationError("each citation must be a JSON object")

    chunk_id = raw_citation.get("chunk_id")
    source = raw_citation.get("source")
    section_id = raw_citation.get("section_id")
    quote = raw_citation.get("quote")

    if not isinstance(chunk_id, str) or not chunk_id.strip():
        raise OutputValidationError("each citation must include a non-empty chunk_id")
    if chunk_id not in retrieved_by_chunk_id:
        raise OutputValidationError(
            f"citation chunk_id {chunk_id!r} was not present in retrieved context"
        )

    retrieved = retrieved_by_chunk_id[chunk_id]
    if source != retrieved.source:
        raise OutputValidationError(f"citation source does not match retrieved chunk {chunk_id!r}")
    if section_id != retrieved.section_id:
        raise OutputValidationError(
            f"citation section_id does not match retrieved chunk {chunk_id!r}"
        )
    if quote is not None and not isinstance(quote, str):
        raise OutputValidationError("citation quote must be a string when present")

    return AssistCitation(
        chunk_id=chunk_id,
        source=source,
        section_id=section_id,
        quote=quote,
    )
