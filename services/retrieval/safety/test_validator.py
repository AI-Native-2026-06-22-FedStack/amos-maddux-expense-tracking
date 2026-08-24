from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

SAFETY_DIR = Path(__file__).resolve().parent
if str(SAFETY_DIR) not in sys.path:
    sys.path.insert(0, str(SAFETY_DIR))

from validator import (  # noqa: E402
    OutputValidationError,
    RetrievedCitationMetadata,
    validate_assist_model_output,
)


def _retrieved_chunks() -> list[RetrievedCitationMetadata]:
    return [
        RetrievedCitationMetadata(
            chunk_id="NWP-POL-006-01",
            source="data/corpus/006-receipt-and-documentation-policy.md",
            section_id="NWP-POL-006-01",
        ),
        RetrievedCitationMetadata(
            chunk_id="NWP-POL-007-01",
            source="data/corpus/007-approval-and-authorization-policy.md",
            section_id="NWP-POL-007-01",
        ),
    ]


def test_valid_structured_answer_with_retrieved_citations_succeeds():
    raw = json.dumps(
        {
            "answer": "A receipt is required above the general threshold.",
            "citations": [
                {
                    "chunk_id": "NWP-POL-006-01",
                    "source": "data/corpus/006-receipt-and-documentation-policy.md",
                    "section_id": "NWP-POL-006-01",
                    "quote": "A receipt is required for any out-of-pocket expense.",
                }
            ],
        }
    )

    result = validate_assist_model_output(raw, retrieved_chunks=_retrieved_chunks())

    assert result.answer == "A receipt is required above the general threshold."
    assert result.citations[0].chunk_id == "NWP-POL-006-01"
    assert result.citations[0].source == "data/corpus/006-receipt-and-documentation-policy.md"


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        json.dumps({"citations": []}),
        json.dumps({"answer": "Missing citations"}),
        json.dumps({"answer": "Wrong citations type", "citations": "NWP-POL-006-01"}),
        json.dumps({"answer": "Wrong citation field", "citations": [{"chunk_id": 7}]}),
    ],
)
def test_malformed_model_output_is_rejected(raw: str):
    with pytest.raises(OutputValidationError):
        validate_assist_model_output(raw, retrieved_chunks=_retrieved_chunks())


def test_plausible_but_unretrieved_chunk_id_is_rejected():
    raw = json.dumps(
        {
            "answer": "This answer cites a plausible but unretrieved policy chunk.",
            "citations": [
                {
                    "chunk_id": "NWP-POL-012-05",
                    "source": "data/corpus/012-expense-report-submission-and-audit-policy.md",
                    "section_id": "NWP-POL-012-05",
                    "quote": "Employees must submit expense reports within 30 calendar days.",
                }
            ],
        }
    )

    with pytest.raises(OutputValidationError, match="not present in retrieved context"):
        validate_assist_model_output(raw, retrieved_chunks=_retrieved_chunks())
