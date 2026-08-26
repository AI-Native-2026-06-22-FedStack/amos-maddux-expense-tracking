"""Validates the frozen evaluation state and computes Precision@5,
before and after reranking, for the 12 evaluation questions.

This script makes NO API calls and is deterministic from the recorded
JSONL files alone -- it reads eval/seed_pairs.jsonl, eval/rankings.jsonl,
and eval/pool.jsonl exactly as they are on disk and never contacts
OpenAI, Postgres, or any other network service. Running it twice against
unchanged files must produce byte-identical output; if it doesn't, that
is itself a bug in this script or in the recorded files, not an
expected source of variance.

It does not write to seed_pairs.jsonl, rankings.jsonl, or pool.jsonl --
relevance judgments (relevant_chunk_ids) were made by a human in a
separate, earlier step and are read here as fixed ground truth, never
regenerated or adjusted to make a number look better.

Validation performed BEFORE any precision is computed (see validate()):
  - exactly 12 questions are represented, consistently, across all three
    files (seed_pairs.jsonl, rankings.jsonl, pool.jsonl),
  - every question has: question_id, expected_chunk_id,
    relevant_chunk_ids, a baseline ranking, a reranked ranking, and a
    frozen pool,
  - every question's frozen pool is EXACTLY the deduplicated union of its
    baseline top-10, reranked top-10, and expected_chunk_id -- no more,
    no fewer, no substitutions,
  - every relevant_chunk_id is a member of that same question's frozen
    pool (a judgment naming a chunk outside the frozen pool would mean
    the judgment and the pool have drifted apart -- see the module
    docstring in eval/build_pool.py on why that requires rebuilding the
    pool, not patching around it here).

If any validation fails, this script raises and computes nothing -- a
Precision@5 number computed over an inconsistent evaluation state would
be meaningless, so this script refuses to produce one.

Precision@5 for one question = |ranked[:5] intersect relevant_chunk_ids| / 5.
The reported numbers are MEAN Precision@5 across the 12 questions, before
and after reranking -- an averaged measure of top-5 relevance density,
not "percentage of questions that succeeded" (that would be a different,
coarser metric: whether ANY relevant chunk appears in the top 5 at all,
which this script does not report).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
SEED_PAIRS_PATH = EVAL_DIR / "seed_pairs.jsonl"
RANKINGS_PATH = EVAL_DIR / "rankings.jsonl"
POOL_PATH = EVAL_DIR / "pool.jsonl"

EXPECTED_QUESTION_COUNT = 12
K = 5


class EvalStateError(ValueError):
    """Raised when the recorded eval files are inconsistent with each
    other or with this script's required structure. Precision@5 is never
    computed when this is raised."""


def _load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        msg = f"required file does not exist: {path}"
        raise EvalStateError(msg)
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def load_eval_state() -> tuple[dict[str, dict], dict[str, dict], dict[str, list[dict]]]:
    """Returns (seed_pairs_by_id, rankings_by_id, pool_rows_by_id).
    Pure file I/O and JSON parsing -- no network access."""
    seed_pairs = {row["question_id"]: row for row in _load_jsonl(SEED_PAIRS_PATH)}
    rankings = {row["question_id"]: row for row in _load_jsonl(RANKINGS_PATH)}

    pool_rows_by_id: dict[str, list[dict]] = {}
    for row in _load_jsonl(POOL_PATH):
        pool_rows_by_id.setdefault(row["question_id"], []).append(row)

    return seed_pairs, rankings, pool_rows_by_id


def validate(
    seed_pairs: dict[str, dict],
    rankings: dict[str, dict],
    pool_rows_by_id: dict[str, list[dict]],
) -> None:
    """Raises EvalStateError on the first violation found. Every check
    below corresponds directly to one of this script's stated
    requirements -- see the module docstring."""

    # --- exactly 12 questions, consistently across all three files ---
    seed_ids = set(seed_pairs)
    ranking_ids = set(rankings)
    pool_ids = set(pool_rows_by_id)

    if len(seed_ids) != EXPECTED_QUESTION_COUNT:
        msg = (
            f"expected exactly {EXPECTED_QUESTION_COUNT} questions in "
            f"{SEED_PAIRS_PATH.name}, found {len(seed_ids)}: {sorted(seed_ids)}"
        )
        raise EvalStateError(msg)

    if ranking_ids != seed_ids:
        missing = seed_ids - ranking_ids
        extra = ranking_ids - seed_ids
        msg = (
            f"{RANKINGS_PATH.name} question ids do not match "
            f"{SEED_PAIRS_PATH.name}: missing={sorted(missing)} extra={sorted(extra)}"
        )
        raise EvalStateError(msg)

    if pool_ids != seed_ids:
        missing = seed_ids - pool_ids
        extra = pool_ids - seed_ids
        msg = (
            f"{POOL_PATH.name} question ids do not match "
            f"{SEED_PAIRS_PATH.name}: missing={sorted(missing)} extra={sorted(extra)}"
        )
        raise EvalStateError(msg)

    # --- every question has every required field ---
    for question_id in sorted(seed_ids):
        seed = seed_pairs[question_id]
        for field in ("question_id", "expected_chunk_id", "relevant_chunk_ids"):
            if field not in seed or seed[field] in (None, [], ""):
                msg = f"{question_id}: {SEED_PAIRS_PATH.name} is missing required field {field!r}"
                raise EvalStateError(msg)

        record = rankings[question_id]
        for field in ("results", "reranked"):
            if field not in record or not record[field]:
                msg = (
                    f"{question_id}: {RANKINGS_PATH.name} is missing a "
                    f"non-empty {field!r} ranking"
                )
                raise EvalStateError(msg)

        if not pool_rows_by_id[question_id]:
            msg = f"{question_id}: {POOL_PATH.name} has an empty frozen pool"
            raise EvalStateError(msg)

    # --- each pool is exactly the deduplicated union of baseline top-10,
    #     reranked top-10, and expected_chunk_id ---
    for question_id in sorted(seed_ids):
        seed = seed_pairs[question_id]
        record = rankings[question_id]

        baseline_ids = [r["chunk_id"] for r in record["results"][:10]]
        reranked_ids = [r["chunk_id"] for r in record["reranked"][:10]]
        expected_chunk_id = seed["expected_chunk_id"]

        expected_pool_set = set(baseline_ids) | set(reranked_ids) | {expected_chunk_id}
        actual_pool_set = {row["chunk_id"] for row in pool_rows_by_id[question_id]}

        if actual_pool_set != expected_pool_set:
            missing = expected_pool_set - actual_pool_set
            extra = actual_pool_set - expected_pool_set
            msg = (
                f"{question_id}: frozen pool does not equal the deduplicated "
                f"union of baseline top-10 + reranked top-10 + expected_chunk_id "
                f"-- missing={sorted(missing)} extra={sorted(extra)}"
            )
            raise EvalStateError(msg)

    # --- every relevant_chunk_id belongs to its question's frozen pool ---
    for question_id in sorted(seed_ids):
        relevant_ids = set(seed_pairs[question_id]["relevant_chunk_ids"])
        pool_ids_for_question = {row["chunk_id"] for row in pool_rows_by_id[question_id]}
        outside_pool = relevant_ids - pool_ids_for_question
        if outside_pool:
            msg = (
                f"{question_id}: relevant_chunk_ids contains id(s) outside "
                f"the frozen pool: {sorted(outside_pool)} -- pool and "
                f"judgments have drifted apart, rebuild the pool rather "
                f"than patching this check"
            )
            raise EvalStateError(msg)


def precision_at_k(ranked_chunk_ids: list[str], relevant_chunk_ids: set[str], k: int) -> float:
    top_k = ranked_chunk_ids[:k]
    hits = sum(1 for chunk_id in top_k if chunk_id in relevant_chunk_ids)
    return hits / k


def compute_precision_at_5(
    seed_pairs: dict[str, dict], rankings: dict[str, dict]
) -> list[dict]:
    rows = []
    for question_id in sorted(seed_pairs):
        seed = seed_pairs[question_id]
        record = rankings[question_id]
        relevant_ids = set(seed["relevant_chunk_ids"])

        baseline_ids = [r["chunk_id"] for r in record["results"]]
        reranked_ids = [r["chunk_id"] for r in record["reranked"]]

        rows.append(
            {
                "question_id": question_id,
                "category": seed.get("category"),
                "before_precision_at_5": precision_at_k(baseline_ids, relevant_ids, K),
                "after_precision_at_5": precision_at_k(reranked_ids, relevant_ids, K),
            }
        )
    return rows


def main() -> int:
    seed_pairs, rankings, pool_rows_by_id = load_eval_state()

    try:
        validate(seed_pairs, rankings, pool_rows_by_id)
    except EvalStateError as exc:
        print(f"EVAL STATE INVALID -- refusing to compute Precision@5: {exc}", file=sys.stderr)
        return 1

    rows = compute_precision_at_5(seed_pairs, rankings)

    print(f"{'question':8s} {'category':24s} {'before P@5':>11s} {'after P@5':>11s}")
    for row in rows:
        print(
            f"{row['question_id']:8s} {row['category']:24s} "
            f"{row['before_precision_at_5']:11.4f} {row['after_precision_at_5']:11.4f}"
        )

    n = len(rows)
    mean_before = sum(r["before_precision_at_5"] for r in rows) / n
    mean_after = sum(r["after_precision_at_5"] for r in rows) / n

    print()
    print(f"mean Precision@5 before reranking: {mean_before:.4f}")
    print(f"mean Precision@5 after reranking:  {mean_after:.4f}")

    if mean_after > mean_before:
        print("reranking improved mean Precision@5")
    elif mean_after < mean_before:
        print("reranking DECREASED mean Precision@5")
    else:
        print("reranking did not change mean Precision@5")

    return 0


if __name__ == "__main__":
    sys.exit(main())
