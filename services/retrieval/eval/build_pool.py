"""Builds the frozen judgment pool: for each question, the union of its
baseline top-10, its reranked top-10, and its known expected_chunk_id
(from seed_pairs.jsonl), deduplicated. Writes one row per (question,
pooled chunk) to eval/pool.jsonl.

This script performs NO relevance judgment -- it only assembles the
candidate SET each question's judgments will be made against. Once
pool.jsonl is written, it is frozen: relevance judgments (written
separately into seed_pairs.jsonl's relevant_chunk_ids) apply only to
chunk ids that appear in this pool. Anything outside the frozen pool
counts as not relevant for this evaluation, by construction -- a chunk
that was never retrieved by either the baseline or the reranked run for
a given question was never judged at all, and precision@5 is computed
only in terms of chunks the retriever/reranker actually surfaced (plus
the pre-declared expected answer, so a genuinely correct answer that
the baseline+reranked pipeline both missed can still be recorded as
relevant, exactly once, without expanding into an unbounded external set
to judge).

Ordering this script depends on and must never violate: seed_pairs.jsonl
and rankings.jsonl (baseline + reranked) must already exist BEFORE this
script runs. If the retriever or reranker changes materially after this
pool is frozen, rankings.jsonl no longer reflects what this pool was
built from, and the pool (and the judgments made against it) must be
rebuilt from a fresh baseline/reranked run -- not patched in place.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
SEED_PAIRS_PATH = EVAL_DIR / "seed_pairs.jsonl"
RANKINGS_PATH = EVAL_DIR / "rankings.jsonl"
POOL_PATH = EVAL_DIR / "pool.jsonl"


def _load_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def _provenance_by_chunk_id(record: dict) -> dict[str, dict]:
    """Every provenance field (source, section_id, offset, text) for
    every chunk that appeared in EITHER this question's baseline or
    reranked results, keyed by chunk_id. Both result lists carry
    identical provenance for a shared chunk_id (same underlying database
    row), so either list can supply it -- baseline is checked first,
    reranked as a fallback for a chunk id that (in principle) exists only
    in one of the two lists."""
    provenance: dict[str, dict] = {}
    for r in record["results"]:
        provenance[r["chunk_id"]] = r
    for r in record["reranked"]:
        provenance.setdefault(r["chunk_id"], r)
    return provenance


def build_pool() -> list[dict]:
    seed_pairs = _load_jsonl(SEED_PAIRS_PATH)
    rankings_by_question = {r["question_id"]: r for r in _load_jsonl(RANKINGS_PATH)}

    pool_rows: list[dict] = []
    for seed in seed_pairs:
        question_id = seed["question_id"]
        expected_chunk_id = seed["expected_chunk_id"]
        record = rankings_by_question[question_id]

        baseline_ids = [r["chunk_id"] for r in record["results"]]
        reranked_ids = [r["chunk_id"] for r in record["reranked"]]

        # dict.fromkeys preserves first-seen order while deduplicating --
        # baseline order first, then any reranked-only additions, then
        # the expected chunk if it wasn't already present in either.
        union_ids = list(dict.fromkeys([*baseline_ids, *reranked_ids, expected_chunk_id]))

        provenance = _provenance_by_chunk_id(record)

        for chunk_id in union_ids:
            row = provenance.get(chunk_id)
            if row is None:
                # expected_chunk_id was in neither ranking -- provenance
                # must come from somewhere else (a live DB lookup) before
                # this pool can be built; see the prompt-journal entry
                # for the Q09/Q10 case this guards against recurring
                # silently.
                msg = (
                    f"{question_id}: expected_chunk_id {chunk_id!r} was not "
                    f"found in either baseline or reranked results, and no "
                    f"other provenance source was supplied -- refusing to "
                    f"write a pool row with missing provenance"
                )
                raise ValueError(msg)

            pool_rows.append(
                {
                    "question_id": question_id,
                    "chunk_id": chunk_id,
                    "source": row["source"],
                    "section_id": row["section_id"],
                    "offset": row["offset"],
                    "text": row["text"],
                    "in_baseline": chunk_id in baseline_ids,
                    "in_reranked": chunk_id in reranked_ids,
                    "is_expected_chunk": chunk_id == expected_chunk_id,
                }
            )

    return pool_rows


def main() -> int:
    pool_rows = build_pool()

    with POOL_PATH.open("w", encoding="utf-8") as f:
        for row in pool_rows:
            f.write(json.dumps(row))
            f.write("\n")

    by_question: dict[str, int] = {}
    for row in pool_rows:
        by_question[row["question_id"]] = by_question.get(row["question_id"], 0) + 1

    print(f"wrote {len(pool_rows)} pool rows across {len(by_question)} questions to {POOL_PATH}")
    for question_id, count in by_question.items():
        print(f"  {question_id}: {count} pooled chunks")

    return 0


if __name__ == "__main__":
    sys.exit(main())
