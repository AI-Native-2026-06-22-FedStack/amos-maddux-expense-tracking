"""Computes Precision@5 for both the baseline and reranked rankings in
eval/rankings.jsonl, against the manually judged relevant_chunk_ids in
eval/seed_pairs.jsonl.

This script must run AFTER pool freezing and relevance judgment -- it is
the last step in the pipeline: write questions -> record baseline
rankings -> record reranked rankings -> freeze pool -> judge relevance ->
calculate Precision@5. It reads relevant_chunk_ids as already-written
ground truth; it does not judge anything itself.

Precision@5 for one question = (number of the top-5 ranked chunk_ids
that are in that question's relevant_chunk_ids) / 5. A chunk outside the
frozen pool cannot appear in relevant_chunk_ids by construction (see
eval/build_pool.py and the judging pass), so this is well-defined for
every chunk a ranking could possibly return.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
SEED_PAIRS_PATH = EVAL_DIR / "seed_pairs.jsonl"
RANKINGS_PATH = EVAL_DIR / "rankings.jsonl"

K = 5


def _load_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def precision_at_k(ranked_chunk_ids: list[str], relevant_chunk_ids: set[str], k: int) -> float:
    top_k = ranked_chunk_ids[:k]
    hits = sum(1 for chunk_id in top_k if chunk_id in relevant_chunk_ids)
    return hits / k


def main() -> int:
    seed_pairs = {s["question_id"]: s for s in _load_jsonl(SEED_PAIRS_PATH)}
    rankings = {r["question_id"]: r for r in _load_jsonl(RANKINGS_PATH)}

    missing_judgments = [
        qid for qid, s in seed_pairs.items() if "relevant_chunk_ids" not in s
    ]
    if missing_judgments:
        print(
            f"refusing to compute precision -- {len(missing_judgments)} question(s) "
            f"have no relevant_chunk_ids yet: {missing_judgments}",
            file=sys.stderr,
        )
        return 1

    rows = []
    baseline_total = 0.0
    reranked_total = 0.0

    for question_id, seed in seed_pairs.items():
        record = rankings[question_id]
        relevant = set(seed["relevant_chunk_ids"])

        baseline_ids = [r["chunk_id"] for r in record["results"]]
        reranked_ids = [r["chunk_id"] for r in record["reranked"]]

        baseline_p5 = precision_at_k(baseline_ids, relevant, K)
        reranked_p5 = precision_at_k(reranked_ids, relevant, K)

        baseline_total += baseline_p5
        reranked_total += reranked_p5

        rows.append(
            {
                "question_id": question_id,
                "category": seed.get("category"),
                "relevant_chunk_ids": sorted(relevant),
                "baseline_precision_at_5": baseline_p5,
                "reranked_precision_at_5": reranked_p5,
                "baseline_top_5": baseline_ids[:K],
                "reranked_top_5": reranked_ids[:K],
            }
        )

    print(f"{'question':8s} {'category':24s} {'baseline P@5':>13s} {'reranked P@5':>13s}")
    for row in rows:
        print(
            f"{row['question_id']:8s} {row['category']:24s} "
            f"{row['baseline_precision_at_5']:13.2f} {row['reranked_precision_at_5']:13.2f}"
        )

    n = len(rows)
    print()
    print(f"mean baseline Precision@5:  {baseline_total / n:.4f}")
    print(f"mean reranked Precision@5:  {reranked_total / n:.4f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
