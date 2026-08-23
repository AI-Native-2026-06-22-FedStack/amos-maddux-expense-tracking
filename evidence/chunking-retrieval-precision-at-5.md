# Chunking/Retrieval Evaluation: Precision@5 Evidence

Date: 2026-08-23

Supports: `docs/adr/0028-chunking-and-retrieval.md`'s Reranking Decision
section.

## Command

```bash
cd services/retrieval
unset DATABASE_URI OPENAI_API_KEY
python3 eval/precision_at_5.py
```

Run with plain `python3` (no `uv`, no virtualenv, no environment
variables set) to demonstrate the measurement itself requires no
database connection and no API key — it is deterministic from the
committed JSONL files alone
(`eval/seed_pairs.jsonl`, `eval/rankings.jsonl`, `eval/pool.jsonl`).

## Output (run twice, byte-identical both times)

```text
question category                  before P@5   after P@5
Q01      exact_identifier              0.2000      0.2000
Q02      colloquial_paraphrase         0.2000      0.2000
Q03      multi_chunk_required          0.4000      0.4000
Q04      near_duplicate_pair_a         0.2000      0.2000
Q05      near_duplicate_pair_b         0.4000      0.4000
Q06      near_duplicate_pair_c         0.2000      0.2000
Q07      general_policy                0.4000      0.4000
Q08      general_policy                0.2000      0.2000
Q09      general_policy                0.2000      0.2000
Q10      general_policy                0.2000      0.2000
Q11      general_policy                0.2000      0.2000
Q12      general_policy                0.2000      0.2000

mean Precision@5 before reranking: 0.2500
mean Precision@5 after reranking:  0.2500
reranking did not change mean Precision@5
```

## Why before == after (root cause, traced per relevant chunk)

Every one of the 15 (question, relevant-chunk) pairs across all 12
questions was already ranked at position ≤5 in the baseline hybrid
retrieval, and stayed at position ≤5 after reranking:

| Question | Relevant chunk | Baseline rank | Reranked rank |
| --- | --- | --- | --- |
| Q01 | NWP-POL-006-04 | 1 | 1 |
| Q02 | NWP-POL-001-02 | 1 | 1 |
| Q03 | NWP-POL-007-03 | 2 | 1 |
| Q03 | NWP-POL-011-04 | 5 | 2 |
| Q04 | NWP-POL-004-03 | 1 | 1 |
| Q05 | NWP-POL-006-01 | 3 | 1 |
| Q05 | NWP-POL-006-02 | 1 | 3 |
| Q06 | NWP-POL-007-01 | 1 | 1 |
| Q07 | NWP-POL-008-02 | 1 | 1 |
| Q07 | NWP-POL-008-04 | 2 | 2 |
| Q08 | NWP-POL-009-02 | 1 | 1 |
| Q09 | NWP-POL-010-02 | 1 | 1 |
| Q10 | NWP-POL-003-02 | 1 | 1 |
| Q11 | NWP-POL-012-05 | 2 | 1 |
| Q12 | NWP-POL-012-03 | 1 | 1 |

Reranking measurably improved rank position for several pairs (e.g. Q03:
{2, 5} -> {1, 2}; Q11: 2 -> 1) but never moved a relevant chunk across
the top-5 boundary in either direction. Precision@5 measures set
membership in the top 5, not position within it, so it cannot detect
this within-top-5 reordering — the flat 0.2500/0.2500 result reflects a
ceiling effect on this small (43-chunk, 12-question) corpus, not an
absence of reranking effect.

## Validation performed by the script before computing anything

`precision_at_5.py` refuses to compute Precision@5 unless all of the
following hold (all passed silently on both runs, no `EVAL STATE
INVALID` error):

- exactly 12 questions represented consistently across
  `seed_pairs.jsonl`, `rankings.jsonl`, and `pool.jsonl`,
- every question has `question_id`, `expected_chunk_id`,
  `relevant_chunk_ids`, a non-empty baseline ranking, a non-empty
  reranked ranking, and a non-empty frozen pool,
- every question's frozen pool is exactly the deduplicated union of its
  baseline top-10, reranked top-10, and `expected_chunk_id` — no more,
  no fewer,
- every `relevant_chunk_id` is a member of that question's frozen pool.

## No-API-call evidence

`precision_at_5.py`'s only imports are `json`, `sys`, and
`pathlib.Path` (grepped and confirmed — no `openai`, `psycopg`,
`httpx`, or `requests` anywhere in the file). Checksummed
`seed_pairs.jsonl`, `rankings.jsonl`, and `pool.jsonl` before and after
both runs: identical MD5s, confirming the script only reads these files
and never writes to them.
