# M9D3 Retrieval — Corpus Acceptance and Precision@5 Evidence

Date: 2026-08-24

Supports: `docs/adr/0028-chunking-and-retrieval.md`.

## 1. Corpus Acceptance Check

Command:

```bash
python services/retrieval/corpus_check.py
```

Output:

```text
[PASS] spec_exists_and_is_completed
[PASS] corpus_loadable
[PASS] document_count_in_range
[PASS] tenant_metadata_present
[PASS] every_document_labelled_synthetic
[PASS] every_document_identifies_fictional_issuer
[PASS] every_section_has_stable_identifier
[PASS] section_identifiers_unique_corpus_wide
[PASS] threshold_table_sections_exist
[PASS] near_duplicate_pairs_exist
[PASS] near_duplicate_pairs_have_one_material_difference
[PASS] superseded_and_replacement_rules_exist
[PASS] effective_dates_present
[PASS] documents_meaningfully_distinct

14/14 checks passed
```

## 2. Precision@5

Command:

```bash
cd services/retrieval
unset DATABASE_URI OPENAI_API_KEY
python3 eval/precision_at_5.py
```

Output:

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

- **Mean Precision@5 before reranking: 0.2500**
- **Mean Precision@5 after reranking: 0.2500**
- **Delta: 0.0000** — reranking did not improve Precision@5 on this
  evaluation. This is the actual measured result and is reported as such,
  not adjusted.

**Resolved reranker model ID** (recorded per question in
`services/retrieval/eval/rankings.jsonl`'s `rerank_config`, configured
family `gpt-4o-mini`): **`gpt-4o-mini-2024-07-18`**.

**No-API-call evidence:** the command above was run twice in immediate
succession and produced byte-identical output. `precision_at_5.py`
imports only `json`, `sys`, and `pathlib` — it was run with `DATABASE_URI`
and `OPENAI_API_KEY` both unset and completed successfully, reading only
the already-recorded `seed_pairs.jsonl`, `rankings.jsonl`, and
`pool.jsonl`. It also validates, before computing anything, that all 12
questions are represented consistently across those three files and that
every frozen pool equals the deduplicated union of its baseline top-10,
reranked top-10, and expected chunk — both runs passed this validation
silently.

**Why the delta is 0.0000, not a defect:** tracing every relevant chunk
across all 12 questions shows each one was already ranked at position ≤5
in the baseline hybrid retrieval and stayed at position ≤5 after
reranking. Reranking measurably improved rank _position within_ the top
5 for several questions (e.g. one question's two relevant chunks moved
from baseline ranks {2, 5} to reranked ranks {1, 2}), which Precision@5
cannot detect because it only measures top-5 set membership, not
position. This is a ceiling effect on this small (43-chunk,
12-question) corpus, not evidence that reranking has no effect.
