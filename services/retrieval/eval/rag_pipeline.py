"""Reusable RAG pipeline for ExpenseFlow policy-question answering.

The eval gate and the future FastAPI /assist route should share this
module rather than each building a private retrieval/rerank/generation
path. The pipeline intentionally calls the existing retriever and reranker
instead of reconstructing easier test-only behavior.
"""
# ruff: noqa: E402

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

import psycopg

RETRIEVAL_DIR = Path(__file__).resolve().parent.parent
if str(RETRIEVAL_DIR) not in sys.path:
    sys.path.insert(0, str(RETRIEVAL_DIR))

from rerank import (
    Candidate,
    Reranker,
    RerankStats,
    candidate_content_hash,
    load_rerank_config,
)
from retrieve import (
    RetrievedChunk,
    embed_query_text,
    load_embedding_config,
    load_retrieval_config,
    retrieve,
)

DEFAULT_TENANT_ID = "tenant-synthetic-northwind-prairie"
GENERATION_MODEL = "gpt-4o-mini"
GENERATION_TEMPERATURE = 0.0
ASSIST_RESPONSE_JSON_SCHEMA = {
    "name": "expenseflow_policy_assist_answer",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["answer", "citations"],
        "properties": {
            "answer": {
                "type": "string",
                "description": "Direct answer grounded only in the supplied policy excerpts.",
            },
            "citations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["chunk_id", "source", "section_id", "quote"],
                    "properties": {
                        "chunk_id": {"type": "string"},
                        "source": {"type": "string"},
                        "section_id": {"type": "string"},
                        "quote": {"type": ["string", "null"]},
                    },
                },
            },
        },
    },
}


@dataclass(frozen=True)
class UsageTotals:
    call_count: int | None = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float | None = None
    resolved_model_id: str | None = None


@dataclass(frozen=True)
class PolicyAnswer:
    question: str
    answer: str
    contexts: list[str]
    citation_metadata: list[dict[str, str]]
    context_chunk_ids: list[str]
    retrieved_chunk_ids: list[str]
    reranked_chunk_ids: list[str]
    generation_model_family: str
    resolved_generation_model_id: str | None
    generation_usage: UsageTotals
    rerank_resolved_model_id: str | None
    rerank_api_requests: int


@dataclass(frozen=True)
class SelectedPolicyContexts:
    contexts: list[RetrievedChunk]
    retrieved_chunk_ids: list[str]
    reranked_chunk_ids: list[str]
    rerank_resolved_model_id: str | None
    rerank_api_requests: int


@dataclass(frozen=True)
class PolicyRagConfig:
    tenant_id: str = DEFAULT_TENANT_ID
    generation_model: str = GENERATION_MODEL
    top_contexts: int = 5


class PolicyRagPipeline:
    def __init__(
        self,
        *,
        database_uri: str | None = None,
        api_key: str | None = None,
        config: PolicyRagConfig | None = None,
    ) -> None:
        self.database_uri = database_uri or os.environ["DATABASE_URI"]
        self.api_key = api_key or os.environ["OPENAI_API_KEY"]
        self.config = config or PolicyRagConfig()

    def answer_question(self, question: str) -> PolicyAnswer:
        selected = self.select_contexts(question)
        answer, resolved_model_id, usage = generate_policy_answer(
            question=question,
            contexts=selected.contexts,
            api_key=self.api_key,
            model=self.config.generation_model,
        )

        return PolicyAnswer(
            question=question,
            answer=answer,
            contexts=[chunk.text for chunk in selected.contexts],
            citation_metadata=_citation_metadata(selected.contexts),
            context_chunk_ids=[chunk.chunk_id for chunk in selected.contexts],
            retrieved_chunk_ids=selected.retrieved_chunk_ids,
            reranked_chunk_ids=selected.reranked_chunk_ids,
            generation_model_family=self.config.generation_model,
            resolved_generation_model_id=resolved_model_id,
            generation_usage=usage,
            rerank_resolved_model_id=selected.rerank_resolved_model_id,
            rerank_api_requests=selected.rerank_api_requests,
        )

    def select_contexts(self, question: str) -> SelectedPolicyContexts:
        query_embedding = embed_query_text(question, self.api_key, load_embedding_config())
        retrieval_config = load_retrieval_config()

        with psycopg.connect(self.database_uri) as connection:
            retrieved = retrieve(
                connection,
                self.config.tenant_id,
                question,
                query_embedding,
                retrieval_config,
            )

        candidates = _candidates_from_retrieved(retrieved)
        rerank_stats = RerankStats()
        reranker = Reranker(load_rerank_config(), self.api_key, stats=rerank_stats)
        reranked = reranker.rerank(question, candidates)
        chunks_by_id = {chunk.chunk_id: chunk for chunk in retrieved}
        ordered_chunks = [
            chunks_by_id[item.chunk_id] for item in reranked if item.chunk_id in chunks_by_id
        ]
        if not ordered_chunks:
            ordered_chunks = retrieved
        selected_contexts = ordered_chunks[: self.config.top_contexts]

        return SelectedPolicyContexts(
            contexts=selected_contexts,
            retrieved_chunk_ids=[chunk.chunk_id for chunk in retrieved],
            reranked_chunk_ids=[chunk.chunk_id for chunk in ordered_chunks],
            rerank_resolved_model_id=reranker.resolved_model_id,
            rerank_api_requests=rerank_stats.api_requests,
        )


def generate_policy_answer(
    *,
    question: str,
    contexts: list[RetrievedChunk],
    api_key: str,
    model: str,
) -> tuple[str, str | None, UsageTotals]:
    from openai import OpenAI

    context_block = "\n\n".join(
        f"[{index}] chunk_id={chunk.chunk_id} source={chunk.source} "
        f"section={chunk.section_id}\n{chunk.text}"
        for index, chunk in enumerate(contexts, start=1)
    )
    prompt = (
        "You are ExpenseFlow Policy Assist. Answer the user's exact policy question. "
        "Use only the supplied policy excerpts as evidence. Do not infer rules, limits, "
        "approval powers, dates, exceptions, or consequences that are not stated in the "
        "excerpts. If the excerpts do not support a complete answer, say exactly what is "
        "not provided by the excerpts. Do not approve, reject, submit, edit, pay, or "
        "reconcile an Expense Report; describe applicable policy only. "
        "Return raw JSON that satisfies the response schema. Do not use Markdown fences. "
        "Answer as policy conditions rather than as unsupported claims about the user's "
        "specific scenario. "
        "Start the answer field with a direct policy outcome sentence beginning with "
        "\"Policy allows\", \"Policy requires\", \"Policy prohibits\", or "
        "\"The retrieved excerpts do not state\". "
        "The answer must be concise, but it must include every policy rule, limit, class, "
        "documentation requirement, exception, and escalation condition needed to answer "
        "the question. Do not stop after the first yes/no rule if the same cited section "
        "also states class, receipt, documentation, timing, exception, or escalation limits. "
        "Each citation must copy chunk_id, source, and section_id exactly from "
        "a supplied excerpt header. Use quote for a short supporting excerpt or null. "
        "Do not cite chunk ids that are not present in the supplied excerpts. "
        "When the policy excerpt contains a table, first match every condition in the "
        "question to the correct row and column before answering; do not mix table rows. "
        "For booking tables, phrases such as fewer than 14 days, less than 14 days, "
        "one week before departure, or a week before departure match the Late booking "
        "(< 14 days advance) column, not the Standard booking column. "
        "If the matched policy class is Economy Plus / Premium Economy, treat that as a "
        "seat above basic economy being policy-allowed. "
        "Do not say no additional approval is needed unless a retrieved excerpt explicitly "
        "says no additional approval is needed. "
        "For late air or rail bookings, include any documented business justification "
        "requirement from the retrieved excerpts. For rental vehicle questions, include "
        "the allowed vehicle class restrictions from the retrieved excerpts. "
        "When a user asks whether they can approve something, do not say that the user can "
        "or cannot approve it. Instead say whether the policy allows the expense or requires "
        "additional approval.\n\n"
        f"Question: {question}\n\n"
        f"Policy excerpts:\n{context_block}"
    )

    client = OpenAI(api_key=api_key)
    response = client.chat.completions.create(
        model=model,
        temperature=GENERATION_TEMPERATURE,
        response_format={
            "type": "json_schema",
            "json_schema": ASSIST_RESPONSE_JSON_SCHEMA,
        },
        messages=[{"role": "user", "content": prompt}],
    )
    content = response.choices[0].message.content or ""
    usage = _usage_from_openai_response(response)
    return content, getattr(response, "model", None), usage


def answer_text_for_evaluation(raw_answer: str) -> str:
    try:
        payload = json.loads(raw_answer)
    except json.JSONDecodeError:
        return raw_answer
    answer = payload.get("answer") if isinstance(payload, dict) else None
    return answer if isinstance(answer, str) else raw_answer


def _citation_metadata(contexts: list[RetrievedChunk]) -> list[dict[str, str]]:
    return [
        {
            "chunk_id": chunk.chunk_id,
            "source": chunk.source,
            "section_id": chunk.section_id,
        }
        for chunk in contexts
    ]


def _candidates_from_retrieved(chunks: list[RetrievedChunk]) -> list[Candidate]:
    return [
        Candidate(
            chunk_id=chunk.chunk_id,
            section_id=chunk.section_id,
            source=chunk.source,
            text=chunk.text,
            content_hash=candidate_content_hash(chunk.text),
        )
        for chunk in chunks
    ]


def _usage_from_openai_response(response) -> UsageTotals:
    usage = getattr(response, "usage", None)
    input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
    output_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
    return UsageTotals(call_count=1, input_tokens=input_tokens, output_tokens=output_tokens)


@dataclass
class FakeRetrievedChunkFactory:
    """Tiny helper used by eval tests without importing pytest fixtures."""

    source: str = "data/corpus/fixture.md"
    offset: int = 0
    fused_score: float = 1.0
    keyword_rank: int | None = 1
    dense_rank: int | None = 1
    created: list[RetrievedChunk] = field(default_factory=list)

    def make(self, chunk_id: str, text: str) -> RetrievedChunk:
        chunk = RetrievedChunk(
            chunk_id=chunk_id,
            source=self.source,
            section_id=chunk_id,
            offset=self.offset,
            text=text,
            fused_score=self.fused_score,
            keyword_rank=self.keyword_rank,
            dense_rank=self.dense_rank,
        )
        self.created.append(chunk)
        return chunk
