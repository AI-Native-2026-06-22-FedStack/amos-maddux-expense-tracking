# 0012 — M9D3: Cited, Scored Policy Retriever

- **_Problem:_** Build a hybrid (keyword + dense) retrieval system over a
  synthetic expense-policy corpus: hierarchical chunking with citation
  provenance, a unified Postgres store (`tsvector` + `pgvector`), tenant-scoped
  retrieval fused with rank-based RRF (`k = 60`), an LLM reranker, and a
  12-question evaluation measuring Precision@5 before/after reranking —
  recorded in `docs/adr/0028-chunking-and-retrieval.md`.

- **_Asked:_** Across many turns — scaffold the service and `retrieval.toml`;
  generate and validate the synthetic policy corpus against a written spec;
  implement the hierarchical chunker with full provenance; create the
  Postgres migration and apply it for real; implement the embedding loader
  with idempotent, content-hashed caching; implement hybrid retrieval
  (keyword leg, dense leg, RRF fusion) with mandatory tenant scope; prove two
  named queries (exact-identifier, colloquial paraphrase) return their
  expected chunk in the top five, and prove tenant isolation against a
  deliberately adversarial second-tenant fixture; implement the reranker
  (one batched request per question, validated output, resolved-model-id
  tracking, content-aware caching); build the eval harness (seed questions,
  frozen candidate pool, manual relevance judgments, Precision@5); and write
  ADR-0028 recording every decision with re-measured evidence.

- **_Produced:_** `services/retrieval/chunker.py`, `embed.py`, `retrieve.py`,
  `rerank.py`, `corpus_check.py`; `services/retrieval/db/migrations/0001_corpus_chunks.sql`;
  `services/retrieval/retrieval.toml`; the 12-document synthetic corpus under
  `data/corpus/` plus `CORPUS-SPEC.md`; the adversarial tenant-B fixture
  `data/corpus-tenant-b/001-lodging-policy.md`; the eval harness
  (`eval/run_baseline.py`, `eval/run_rerank.py`, `eval/build_pool.py`,
  `eval/precision_at_5.py`) and its data (`eval/seed_pairs.jsonl`,
  `eval/rankings.jsonl`, `eval/pool.jsonl`); the full `services/retrieval/tests/`
  suite (105 tests); `docs/adr/0028-chunking-and-retrieval.md`.

- **_Accepted / Rejected — key decisions and why:_**

  ACCEPTED: Postgres image swap to `pgvector/pgvector:pg17`. The running
  `postgres:17-alpine` container had no `vector` extension available at all
  (`pg_available_extensions` returned zero rows), so the migration could
  never apply as originally planned. Asked the user rather than guessing;
  they approved swapping images and wiping the (synthetic, reproducible)
  local dev volume rather than attempting an unsupported in-place base-image
  change. No second/separate vector database was introduced — embeddings
  live in the same shared Postgres instance, per ADR-0006/ADR-0009.

  REJECTED then corrected: a composite `GIN(tenant_id, search_vector)` index
  for the tenant-scoped keyword leg. Applying the migration failed outright
  (`data type text has no default operator class for access method "gin"`)
  — Postgres has no default GIN opclass for plain `text`. Replaced with a
  plain `GIN(search_vector)` index alongside the existing tenant-leading
  btree indexes, which the planner combines via bitmap AND — the standard
  way tsvector search combines with tenant/row filtering in Postgres,
  without adding `btree_gin` for a marginal selectivity gain. Also removed
  a redundant `embedding` dimension CHECK constraint after confirming
  directly that `vector(1536)` already enforces it at the type level
  (inserting a 10-element vector raised "expected 1536 dimensions, not 10"
  before any CHECK would even run).

  ACCEPTED: content-hash-based embedding cache, never chunk-ID-only. Cache
  key = `sha256(chunk_text + model + dimensions)`. Verified directly: two
  different chunk_ids with identical text collide to the same cache entry;
  editing text under the same chunk_id produces a different key. Idempotency
  check order matters — content_hash comparison against Postgres happens
  BEFORE either the cache or the API is touched, so a true no-op second run
  shows `cache_hits=0 cache_misses=0 api_calls=0`, not merely
  `api_calls=0`. Verified with a live 3-scenario test: edit a chunk (1 API
  call, row updated), revert it (0 API calls, cache HIT on the
  original text — proving the cache is content-keyed, not "last write
  wins"), then a final no-op run confirming the `0/0/0` steady state.

  ACCEPTED: RRF fusion strictly by rank position, never raw score. The
  keyword leg's `ts_rank_cd` and the dense leg's cosine similarity are not
  commensurable — no principled way to add/average/normalize them together.
  `reciprocal_rank_fusion()` never reads either leg's score field at all,
  proven by a test that swaps in deliberately misleading raw scores and
  shows the fused ranking is unaffected.

  REJECTED then corrected: naive `to_tsquery` matching for exact-identifier
  queries. Querying `NWP-POL-006-01` returned 4 chunks, not 1 — the corpus's
  near-duplicate sections deliberately cross-reference each other in prose
  ("see NWP-POL-006-01"), so plain tsvector matching can't distinguish "the
  chunk this ID names" from "a chunk that merely mentions this ID." Fixed
  with an explicit `section_id` equality short-circuit that always ranks a
  literally-named chunk first in the keyword leg. A second, subtler version
  of the same bug then surfaced: even with keyword-leg rank 1 guaranteed,
  the literal-id chunk still didn't land at overall rank 1 after RRF fusion
  with the dense leg (verified live: fused rank 4). Asked the user whether
  "retrievable literally" meant "present with keyword rank 1" or "guaranteed
  result #1"; they chose the stronger reading, so `retrieve()` now
  post-fusion-reorders the literal-id chunk to rank 1 unconditionally —
  deliberately kept OUT of `reciprocal_rank_fusion()` itself, which stays
  purely rank-based and is tested as such in isolation.

  ACCEPTED: a real, deliberately adversarial second-tenant fixture
  (`data/corpus-tenant-b/`, "Rival Corp Holdings, Inc.") over a fake row
  inserted only inside a test — chosen for a more realistic end-to-end
  proof of tenant isolation. Building it surfaced two real chunker bugs:
  (1) `SECTION_HEADING_PATTERN` was hardcoded to the literal `NWP-POL-`
  prefix, so tenant B's correctly-distinct `RVL-POL-` prefix produced zero
  recognized chunks — generalized to `[A-Z]+-POL-\d{3}-\d{2}(\.\d{2})?`;
  (2) `chunk_document()`'s `source` field was hardcoded to
  `f"data/corpus/{path.name}"` regardless of the file's real location,
  which would have silently mislabeled every tenant-B chunk's provenance —
  fixed by deriving the real repo-relative path. Both fixes verified not to
  change the real corpus's existing chunk_ids or source values (same
  pre/post test-pass count). The fixture then proved itself genuinely
  adversarial: querying it under its own tenant ranks it first (same
  vocabulary/dollar amounts as the real lodging policy), while querying
  tenant A never leaks it, including under a deliberately unfavorable dense
  embedding — isolating the guarantee to the keyword leg's own tenant
  filter.

  ACCEPTED then corrected: reranker cold-start caching. The first cold run
  correctly made 12 API requests (one per question, full candidate list per
  request — never one request per candidate) and cached all 12. A second
  run of the same script should have served everything from cache but still
  made 1 real API call: `Reranker.resolved_model_id` starts `None` for
  every fresh process, and the cache key depends on it, so a brand-new
  instance had no way to attempt a lookup before its own first API call.
  Verified directly (`api_requests=1, cache_hits=11`, not `0`/`12`). Asked
  the user before fixing; chose seeding a fresh run's first lookup from a
  small persisted `last_resolved_model_id.<family>.json` file — a guess,
  never trusted as correctness; a wrong guess just falls through to a real
  API call. After the fix, a third run against unchanged inputs reached the
  true steady state: `api_requests=0, cache_hits=12, cache_misses=0`.

  ACCEPTED: reporting the flat Precision@5 result honestly rather than
  adjusting anything to manufacture an improvement. Measured mean
  Precision@5: **0.2500 before reranking, 0.2500 after** (delta 0.0000).
  Traced every one of 15 (question, relevant-chunk) pairs across all 12
  questions: every relevant chunk was already ranked ≤5 in the baseline and
  stayed ≤5 after reranking — reranking measurably improved rank _position_
  within the top 5 for several questions (e.g. one question's two relevant
  chunks moved from baseline ranks {2, 5} to reranked ranks {1, 2}), which
  Precision@5 cannot detect because it only measures top-5 set membership,
  not position. This is a ceiling effect on a small (43-chunk, 12-question)
  corpus, not evidence that reranking has no effect — recorded as such in
  ADR-0028 rather than either suppressing the flat number or overclaiming
  reranking's value from evidence Precision@5 can't show.

- **_Verification discipline:_** every real bug above was found by actually
  running the code against the live database/API, not by reading the SQL or
  the prompt spec and trusting it — e.g. the migration was applied and
  inspected via `\d+`/`pg_indexes`, the literal-id bug was found by
  querying the real 43-chunk corpus, the tenant-isolation fixture was
  proven adversarial by querying it directly under its own tenant, and
  every value written into ADR-0028 (max chunk size, resolved model ID,
  Precision@5 before/after) was re-measured from the committed files
  immediately before writing, not recalled from an earlier turn's output.
