"""Reranks every question's baseline top-10 (services/retrieval/eval/rankings.jsonl,
produced by eval/run_baseline.py) using rerank.py's Reranker, and writes
the reranked ordering back into the SAME rankings.jsonl record under a
new "reranked" key -- so rankings.jsonl carries baseline and reranked
results side by side for the same 12 questions, rather than two separate
files that could drift out of sync with each other.

ONE model request per question (12 total for a cold run), each carrying
the question's entire numbered candidate list together -- see rerank.py's
module docstring for why, and for the cache-key/resolved-model-id
handling this script relies on via Reranker.

Usage:
    cd services/retrieval
    DATABASE_URI=... OPENAI_API_KEY=... uv run python3 eval/run_rerank.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

RETRIEVAL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RETRIEVAL_DIR))

from rerank import (  # noqa: E402
    Candidate,
    Reranker,
    RerankStats,
    candidate_content_hash,
    load_rerank_config,
)

EVAL_DIR = Path(__file__).resolve().parent
RANKINGS_PATH = EVAL_DIR / "rankings.jsonl"


def _load_rankings() -> list[dict]:
    with RANKINGS_PATH.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def _candidates_from_baseline_results(results: list[dict]) -> list[Candidate]:
    return [
        Candidate(
            chunk_id=r["chunk_id"],
            section_id=r["section_id"],
            source=r["source"],
            text=r["text"],
            content_hash=candidate_content_hash(r["text"]),
        )
        for r in results
    ]


def main() -> int:
    records = _load_rankings()
    if not records:
        print(
            f"no records found in {RANKINGS_PATH} -- run eval/run_baseline.py first",
            file=sys.stderr,
        )
        return 1

    api_key = os.environ["OPENAI_API_KEY"]
    config = load_rerank_config()
    stats = RerankStats()
    reranker = Reranker(config, api_key, stats=stats)

    for record in records:
        candidates = _candidates_from_baseline_results(record["results"])
        reranked = reranker.rerank(record["question"], candidates)

        candidates_by_id = {c.chunk_id: c for c in candidates}
        baseline_by_id = {r["chunk_id"]: r for r in record["results"]}

        record["reranked"] = [
            {
                "rank": item.rank,
                "chunk_id": item.chunk_id,
                "source": baseline_by_id[item.chunk_id]["source"],
                "section_id": baseline_by_id[item.chunk_id]["section_id"],
                "offset": baseline_by_id[item.chunk_id]["offset"],
                "text": baseline_by_id[item.chunk_id]["text"],
                "baseline_rank": baseline_by_id[item.chunk_id]["rank"],
            }
            for item in reranked
        ]
        record["rerank_config"] = {
            "configured_model_family": config.model,
            "resolved_model_id": reranker.resolved_model_id,
            "prompt_version": config.prompt_version,
            "temperature": config.temperature,
        }
        del candidates_by_id

    with RANKINGS_PATH.open("w", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record))
            f.write("\n")

    print(f"reranked {len(records)} questions, wrote results back to {RANKINGS_PATH}")
    print(f"configured model family: {config.model}")
    print(f"resolved model id: {reranker.resolved_model_id}")
    print(
        f"api_requests={stats.api_requests} cache_hits={stats.cache_hits} "
        f"cache_misses={stats.cache_misses}"
    )

    for record in records:
        reranked_ids = [r["chunk_id"] for r in record["reranked"]]
        hit = record["expected_chunk_id"] in reranked_ids
        rank = reranked_ids.index(record["expected_chunk_id"]) + 1 if hit else None
        print(f"  {record['question_id']}: expected in reranked top-10={hit} (rank={rank})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
