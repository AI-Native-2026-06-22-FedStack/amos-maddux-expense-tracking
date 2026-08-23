# 0015 — Hybrid Retrieval: Keyword + Dense + RRF Fusion

- **_Problem:_** Implement `services/retrieval/retrieve.py`: a keyword
  (tsvector) leg, a dense (vector cosine) leg, and Reciprocal Rank Fusion
  combining them with `1/(60+rank)` -- rank-based only, never
  add/average/normalize/weight raw leg scores. Both legs query
  `retrieval.corpus_chunk` (same table), both independently tenant-scoped.
  Reranking is explicitly out of scope for this deliverable.

- **_Produced:_** `services/retrieval/retrieve.py`
  (`_keyword_leg`/`_dense_leg`/`reciprocal_rank_fusion`/`retrieve`/
  `embed_query_text`, plus a CLI entrypoint), `services/retrieval/tests/test_retrieve.py`
  (22 tests: 8 pure-unit RRF-math tests with no database, 6 pure-function
  literal-id/tsquery tests, 8 live-Postgres tests for tenant isolation,
  cosine ordering, candidate limits, and end-to-end result shape).
  `retrieval.toml` gained `[retrieval].candidates_per_leg = 20` (was
  missing -- `top_k` existed but nothing configured how many candidates
  each leg pulls before fusion).

- **_Real bug found and fixed by actually querying the real corpus, not
  just reading the SQL:_** `to_tsquery('english', 'NWP-POL-006-01')`
  does NOT reliably retrieve only the chunk whose own section_id is that
  string -- it also matches any OTHER chunk that merely cross-references
  that id in prose (this corpus's near-duplicate-pair sections
  deliberately cross-reference each other, e.g. "see NWP-POL-006-01" --
  see `data/corpus/CORPUS-SPEC.md`). Verified directly: querying the
  live table returned 4 chunks, not 1. Asked the user (AskUserQuestion)
  how to guarantee the stated requirement ("exact section identifiers
  must be retrievable literally") given this; chose adding an explicit
  equality-match short-circuit (`_extract_literal_section_id()` +
  `_EXACT_SECTION_ID_SQL`) that always ranks a literally-named section's
  own chunk first in the keyword leg, ahead of ordinary tsvector-ranked
  results.

- **_Second bug found the same way, after the first fix:_** even with
  `keyword_rank=1` guaranteed, a literal-id query's target chunk still
  didn't land at overall rank 1 after RRF fusion with the dense leg --
  verified live: `NWP-POL-012-05` queried literally came back at fused
  rank 4, because the dense leg's unrelated top hits accumulated a
  comparable fused score. Asked the user again whether "retrievable
  literally" means "present with kw_rank=1" (weaker) or "guaranteed
  result #1" (stronger); chose the stronger reading. Fixed by adding a
  post-fusion reordering step in `retrieve()` itself (NOT inside
  `reciprocal_rank_fusion()`, which stays purely rank-based and is tested
  as such in isolation) that places the literal-id chunk first
  unconditionally when one is found. Verified with an adversarial test
  (`test_retrieve_literal_section_id_query_returns_that_chunk_first`)
  using a deliberately unfavorable dense-leg embedding, so the guarantee
  is proven to hold even when the dense leg actively disagrees.

- **_Third bug (test-only, caught before it could mask anything):_**
  `psycopg` returns a stored `vector` column as a plain Python `str`
  already in `[x,y,z]` literal form (no pgvector adapter registered) --
  the FIRST version of the live dense-leg tests fetched a real embedding
  this way and passed the STRING straight into functions expecting
  `list[float]` (which format it themselves via `_vector_literal()`),
  producing `repr()`-mangled garbage and an `InvalidTextRepresentation`
  error from Postgres. Not a `retrieve.py` bug -- `_vector_literal()`'s
  contract (`list[float]` in) matches its one real caller,
  `embed_query_text()`'s OpenAI SDK return value, correctly. Fixed the
  TESTS to parse the fetched string back into a `list[float]` first,
  matching what any real caller actually has in hand.

- **_Verification beyond the test suite:_** ran the module's own CLI
  (`python retrieve.py '<query>'`) against the real 43-chunk corpus for
  three cases: a natural-language query (surfaced the `NWP-POL-006-01`/
  `NWP-POL-006-04` near-duplicate receipt-threshold pair near the top, as
  expected), a literal section-id query (confirmed rank-1 guarantee), and
  a nonexistent-tenant query (confirmed zero results -- tenant isolation
  holds end-to-end, not just in the leg-level unit tests).
