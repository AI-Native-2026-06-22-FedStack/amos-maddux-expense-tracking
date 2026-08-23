"""Runs every question in seed_pairs.jsonl through the fused hybrid
retriever (services/retrieval/retrieve.py) and records each question's
baseline top-10 in rankings.jsonl.

This script deliberately does NOT make relevance judgments, does NOT add
relevant_chunk_ids anywhere, and does NOT score anything -- it captures
what the retriever actually returns today, as raw evidence, before any
human or model judges whether those results are correct. Recording the
baseline first and judging it afterward (in a later, separate step) is
the point: it prevents unconsciously tuning retrieval to match judgments
that were made with the results already in view.

No reranking is involved -- this is chunker.py -> embed.py -> retrieve.py
only, the same three-stage pipeline seed_pairs.jsonl's questions are
designed against, per data/corpus/CORPUS-SPEC.md and
services/retrieval/retrieval.toml's [rerank] section (gpt-4o-mini,
not implemented yet).

Usage:
    cd services/retrieval
    DATABASE_URI=... OPENAI_API_KEY=... uv run python3 eval/run_baseline.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

RETRIEVAL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RETRIEVAL_DIR))

import psycopg  # noqa: E402

from retrieve import (  # noqa: E402
    RetrievalConfig,
    embed_query_text,
    load_embedding_config,
    load_retrieval_config,
    retrieve,
)

EVAL_DIR = Path(__file__).resolve().parent
SEED_PAIRS_PATH = EVAL_DIR / "seed_pairs.jsonl"
RANKINGS_PATH = EVAL_DIR / "rankings.jsonl"

BASELINE_TOP_K = 10
DEFAULT_TENANT_ID = "tenant-synthetic-northwind-prairie"


def _load_seed_pairs() -> list[dict]:
    with SEED_PAIRS_PATH.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def _run_baseline() -> list[dict]:
    seed_pairs = _load_seed_pairs()

    database_uri = os.environ["DATABASE_URI"]
    api_key = os.environ["OPENAI_API_KEY"]
    embedding_config = load_embedding_config()

    base_retrieval_config = load_retrieval_config()
    # Same rrf_k/candidates_per_leg as production retrieval.toml -- only
    # top_k is overridden to capture 10 results per question instead of
    # the live default of 5, since this baseline is meant to give a later
    # reranking/judgment pass a wider candidate pool to work from than
    # the retriever's normal top_k=5 result surface.
    eval_config = RetrievalConfig(
        rrf_k=base_retrieval_config.rrf_k,
        top_k=BASELINE_TOP_K,
        candidates_per_leg=base_retrieval_config.candidates_per_leg,
    )

    records = []
    with psycopg.connect(database_uri) as connection:
        for pair in seed_pairs:
            question_id = pair["question_id"]
            question_text = pair["question"]

            query_embedding = embed_query_text(question_text, api_key, embedding_config)
            results = retrieve(
                connection, DEFAULT_TENANT_ID, question_text, query_embedding, eval_config
            )

            records.append(
                {
                    "question_id": question_id,
                    "question": question_text,
                    "expected_chunk_id": pair["expected_chunk_id"],
                    "top_k": len(results),
                    "results": [
                        {
                            "rank": rank,
                            "chunk_id": r.chunk_id,
                            "fused_score": r.fused_score,
                            "source": r.source,
                            "section_id": r.section_id,
                            "offset": r.offset,
                            "text": r.text,
                            "keyword_rank": r.keyword_rank,
                            "dense_rank": r.dense_rank,
                        }
                        for rank, r in enumerate(results, start=1)
                    ],
                }
            )
    return records


def main() -> int:
    records = _run_baseline()

    with RANKINGS_PATH.open("w", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record))
            f.write("\n")

    print(f"wrote {len(records)} baseline rankings to {RANKINGS_PATH}")
    for record in records:
        top_ids = [r["chunk_id"] for r in record["results"]]
        hit = record["expected_chunk_id"] in top_ids
        rank = top_ids.index(record["expected_chunk_id"]) + 1 if hit else None
        print(f"  {record['question_id']}: expected in top-10={hit} (rank={rank})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
