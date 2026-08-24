# ADR-0028: Hierarchical Chunking and Hybrid Retrieval for the Policy Corpus

## Status

Accepted.

## Context

`services/retrieval` needs to answer natural-language policy questions
(the `Finance Admin`/`Department Manager` approver role, per
`AGENTS.md`'s domain vocabulary) against the synthetic expense-policy
corpus in `data/corpus/` (see `data/corpus/CORPUS-SPEC.md`) with an
answer that can be cited back to a specific policy section, not just a
plausible-sounding summary. Three concrete production retrieval problems
motivate the chunking and retrieval design this ADR records, all of them
demonstrated directly against this corpus rather than assumed in the
abstract:

**Dense-only retrieval can miss exact identifiers.** A user or an
internal caller sometimes names a section literally (e.g. a query
containing the string `NWP-POL-006-01`). A pure embedding-similarity
search has no privileged way to treat that string as an identifier
rather than as ordinary text to embed — a dense leg alone has no
guarantee of surfacing the chunk whose own `section_id` equals a literal
string in the query. This was demonstrated concretely while building the
retriever (`prompt-journal/0012-cited-scored-retriever.md`): a naive
`to_tsquery` keyword match on a hyphenated section id like
`NWP-POL-006-01` also matched other chunks that merely cross-reference
that id in prose (this corpus deliberately cross-references its
near-duplicate pairs — see `data/corpus/CORPUS-SPEC.md`), returning 4
chunks instead of 1 for a literal-id query. Neither leg alone reliably
guarantees literal-identifier retrieval.

**Similar chunks can crowd out the materially correct chunk.** The
corpus was deliberately built with three near-duplicate section pairs
(`data/corpus/CORPUS-SPEC.md`'s near-duplicate pairs A/B/C — e.g.
`NWP-POL-006-01` general receipt threshold vs. `NWP-POL-006-04`
corporate-card receipt threshold, identical structure and phrasing,
differing in exactly one number) specifically to prove that a retriever
can distinguish the materially correct chunk from a same-topic
look-alike, not just find "a receipt threshold section." A retriever
that only ranks by topical similarity has no mechanism to prefer the
correct member of a near-duplicate pair.

**Chunks without provenance cannot support citations.** An approver
acting on a retrieved answer needs to know which document and section it
came from, and be able to verify the text actually appears there — not
receive an unattributed span of text. Every field the deliverable's
`Chunk`/`RetrievedChunk` types carry (`chunker.py`, `retrieve.py`) exists
because it is load-bearing for this: `source`, `section_id`, `offset`,
`chunk_id`, `text`. This was verified directly, not just designed for —
`services/retrieval/tests/test_chunker.py`'s
`test_offset_points_at_the_chunks_actual_text_in_the_source_file` proves
a chunk's recorded offset, read back against the real source file on
disk, reproduces the chunk's own stored text exactly.

## Chunking Decision

**Hierarchical chunking**, splitting each Markdown policy document by its
own heading structure (H1 title, then `NWP-POL-<doc>-<section>[.<subsection>]`-identified
`##`/`###` headings — see `data/corpus/CORPUS-SPEC.md`) rather than a
fixed-size character/token window as the primary strategy
(`services/retrieval/chunker.py`). A top-level identified section
(`##`) is one chunk, including any nested subsections and any Markdown
table inside it — this is the mechanism that keeps a threshold table
together with the heading and prose that explain what its numbers mean,
and keeps every heading paired with the body it introduces (both
requirements verified directly by
`services/retrieval/tests/test_chunker.py`'s heading-coherence and
table-coherence assertions, not merely asserted in a docstring).

**Configured maximum chunk size**: `max_tokens = 512`
(`services/retrieval/retrieval.toml`'s `[chunking]` section), using a
deterministic characters/4 token estimate
(`chunker.estimate_tokens`) rather than a live tokenizer call, so sizing
decisions don't depend on a network round trip. This ceiling was set
against measured evidence, not guessed: the largest real section in the
corpus (`NWP-POL-001-02`, including its subsection and table) is 355
tokens by this estimate — the actual measured maximum across all 43
chunks produced from the current corpus is also 355 tokens. 512 sits
comfortably above every real section (headroom for the corpus to grow)
and well below a full document (563–1032 tokens), so a hard split is
never actually triggered by the present corpus; the fallback path
(subsection-then-paragraph splitting for an oversized section,
`chunker._split_oversized_section`/`_split_by_paragraph`) exists and is
tested, but is presently dead code by design — a safety net, not a live
path.

**Overlap: not used.** `retrieval.toml`'s `[chunking]` section still
carries a configured `overlap_tokens = 64` value, but it is read into
`ChunkingConfig` and never applied anywhere in `chunker.py`'s actual
splitting logic — no chunk boundary in the current implementation
duplicates text from a neighboring chunk. This was a deliberate decision,
not an oversight: overlap earns its cost when a fixed-size window
arbitrarily severs continuous prose, so a reader needs the previous
window's tail for context. This corpus's real chunk boundaries are not
arbitrary — each one is a real section boundary that already carries a
stable id and a self-contained topic. Adding overlap here would mean
bleeding one section's text into a neighboring section's chunk, which
would actively work against the near-duplicate-pair discrimination this
corpus exists to test (`NWP-POL-006-01`/`NWP-POL-006-04` need to stay
textually distinguishable, not blended together at their boundary). If
the paragraph-splitting fallback ever activates for a genuinely oversized
section, overlap between adjacent parts of that same section would be
worth reconsidering then — a decision for when it becomes a live path,
not now.

**Why this strategy preserves policy sections and threshold tables**:
the corpus's authors already encoded the real semantic units as headings
with stable ids — splitting along those units directly produces chunks
that are self-describing (the heading names the chunk's topic),
correctly scoped (one section = one retrievable idea), and naturally
sized (measured max 355 tokens, no chunk too small to be meaningful or
too large to embed precisely). A fixed-size splitter has no way to know
a table/heading boundary matters and would, as a matter of course, land
inside a table or between a heading and its first sentence at least as
often as not.

## Retrieval Decision

Hybrid retrieval (`services/retrieval/retrieve.py`): a **tsvector
keyword leg** and a **pgvector dense leg**, both querying the **same
unified chunk table** (`retrieval.corpus_chunk`, one row per chunk,
carrying both a generated `search_vector tsvector` column and a
`vector(1536) embedding` column —
`services/retrieval/db/migrations/0001_corpus_chunks.sql`), fused with
Reciprocal Rank Fusion.

**Keyword leg**: `search_vector @@ to_tsquery(...)` against the GIN
index (`corpus_chunk_search_vector_idx`), ranked by `ts_rank_cd`. A
literal `NWP-POL-<doc>-<section>` string detected in the query text is
additionally resolved by an explicit `section_id` equality lookup and
ranked first in this leg's own ordering (`retrieve._keyword_leg`,
`_extract_literal_section_id`) — the fix for the exact-identifier
problem in Context, verified against the real corpus after the naive
`to_tsquery`-only approach was shown to return 4 chunks for a 1-chunk
answer.

**Dense leg**: cosine distance (`embedding <=> query_embedding`,
ascending) against the `vector(1536)` column populated by
`services/retrieval/embed.py` using `text-embedding-3-small` at 1536
dimensions — the same model and dimensionality the corpus was indexed
with, so a query embedding is always comparable
(`retrieve.embed_query_text`).

**Both legs query the same table.** There is no separate keyword index
table or separate vector store — `retrieval.corpus_chunk` is queried by
both `_keyword_leg` and `_dense_leg` directly, matching
`docs/adr/0006-service-boundaries-and-anti-shared-db.md`'s
anti-shared-DB rule and the migration's own design (no second/separate
vector database was introduced to support this deliverable).

**Mandatory tenant scope.** Both legs filter `tenant_id` inside their
own SQL (`where tenant_id = %(tenant_id)s`, baked into the query text
itself, not a post-fetch filter applied in application code) — verified
with a deliberately adversarial fixture, not merely asserted:
`data/corpus-tenant-b/001-lodging-policy.md` (a second fictional tenant,
`tenant-synthetic-rival-corp`) was constructed with overlapping
vocabulary, structure, and dollar amounts against the real corpus's
lodging policy specifically so it would rank highly for the same queries
if tenant scoping ever broke. `services/retrieval/tests/test_retrieve_named_queries.py`
confirms it never does — tenant A's query results never contain tenant
B's chunk ids, including under a directionless dense-leg embedding that
isolates the guarantee to the keyword leg's own tenant filter alone.

**RRF with k = 60**, per `retrieval.toml`'s `[retrieval]` section:
`fused_score(chunk) = sum over each leg the chunk appears in of
1 / (60 + rank)`, where `rank` is the chunk's 1-based position within
that leg's own ranking (`retrieve.reciprocal_rank_fusion`). `k = 60` is
the standard constant from the original RRF paper (Cormack, Clarke &
Buettcher 2009) and is not tuned per-corpus.

**Why fusion uses ranks rather than raw scores**: the keyword leg's
score (`ts_rank_cd`, term-frequency-weighted, unbounded above,
corpus/query-dependent scale) and the dense leg's score (cosine
similarity in `[0, 1]`) are not commensurable — there is no principled
way to add, average, or weight them together, since a given numeric
value from one leg does not mean "as relevant as" the same value from
the other. RRF sidesteps this by only ever asking which rank position a
chunk held within each leg's own ordering, never how large that leg's
own score was. This is a structural property of the implementation, not
only a design intent:
`services/retrieval/tests/test_retrieve.py::test_rrf_does_not_read_any_score_field_from_leg_rows`
constructs one leg ranking carrying misleading raw scores and another
carrying none at all, and proves the fused output is byte-identical
either way — `reciprocal_rank_fusion` never reads a leg's score field.

## Reranking Decision

`services/retrieval/rerank.py` reranks each evaluation question's
baseline top-10 with **one batched model request per question** — the
entire numbered candidate list sent together in a single chat completion
call, never one request per candidate. This was verified directly, not
only implemented: an independent request counter (wrapping the API call
from outside the module's own bookkeeping) confirmed exactly 12 real API
calls for the 12 evaluation questions on a cold cache, not 120, and a
raw HTTP request body was captured and inspected directly, confirming
one `messages` array entry containing the question text followed
immediately by all 10 numbered candidates
(`prompt-journal/0012-cited-scored-retriever.md`).

**Configured model family**: `gpt-4o-mini` (`retrieval.toml`'s
`[rerank].model`).

**Resolved model ID**: `gpt-4o-mini-2024-07-18` — captured from the real
API response's own `model` field (`rerank._call_rerank_api`), not
assumed from the configured family alias, and recorded per-question in
`services/retrieval/eval/rankings.jsonl`'s `rerank_config.resolved_model_id`.

**Measured mean Precision@5** (`services/retrieval/eval/precision_at_5.py`,
run twice against the frozen `services/retrieval/eval/pool.jsonl` and
manually judged `relevant_chunk_ids` in
`services/retrieval/eval/seed_pairs.jsonl`, both runs byte-identical, no
API calls):

- **Before reranking: 0.2500**
- **After reranking: 0.2500**

**Whether the measured result justifies reranking's additional latency
and cost, on this evidence**: no — not on this deliverable's own
12-question evaluation. Precision@5 did not improve. Tracing every one
of the 15 (question, relevant-chunk) pairs across all 12 questions shows
why: every relevant chunk was already ranked at position ≤5 in the
baseline hybrid retrieval, and stayed at position ≤5 after reranking —
there was no headroom left for a top-5-set-membership metric to show
improvement on this small, already-strong-baseline corpus (43 chunks,
12 questions). Reranking did visibly improve rank *position within* the
top 5 for several questions (e.g. `Q03`'s two relevant chunks moved from
baseline ranks {2, 5} to reranked ranks {1, 2}), which Precision@5
cannot see by construction (it only measures set membership in the top
`k`, not position within it) — so this result should be read as "not
justified on the metric measured here," not as "reranking has no
effect." Reranking adds one real API call per query at query time (not
cached — the cache only removes cost for a previously-seen exact
question/candidate-set/model combination) plus its own latency on top of
the hybrid retrieval call; on this evaluation's evidence, that added
cost bought a same-position-Precision@5 result on this small corpus.
Whether that tradeoff is worth it is genuinely corpus-and-workload
dependent — this ADR records what was measured, not a
verdict that reranking should be removed, since a larger or more
adversarial corpus, or a rank-sensitive metric (MRR, NDCG@5), could show
a different result. This ADR does not decide the
`text-embedding-3-small` vs. a larger embedding model tradeoff — that is
explicitly deferred to ADR-0029.

## Deferred Query Transformation

**Query transformation (query rewriting, multi-query retrieval, HyDE) is
not implemented in this deliverable.** `retrieve.py` sends the caller's
query text to both legs essentially as given (after light,
mechanical normalization — literal-id extraction, tokenization for
`to_tsquery`), with no LLM call that rewrites, expands, or
hypothesizes an answer document before retrieval runs.

- **Query rewriting** (an LLM reformulates the user's query into
  clearer or more retrieval-friendly phrasing before either leg runs)
  could address a recall problem this deliverable's own evaluation
  didn't need to solve: an approver's query phrased ambiguously or with
  domain-mismatched terms that neither the keyword leg's exact terms nor
  the dense leg's embedding neighborhood cover well.
- **Multi-query retrieval** (generate several paraphrased variants of
  the query, retrieve for each, merge the candidate sets) could address
  recall loss from a single phrasing missing a relevant chunk that a
  differently-worded version of the same question would have found —
  most useful when a corpus has many valid ways to ask about the same
  policy and a single query embedding sits in a neighborhood that misses
  one of them.
- **HyDE** (hypothetical document embeddings: have an LLM draft a
  plausible-looking answer to the query, embed that hypothetical answer
  instead of the query, and search with it) could address the
  query-answer lexical/semantic gap — a question phrased very
  differently from how the actual answer is written might match better
  once compared against a hypothetical answer's phrasing than against
  the raw question's.

**Additional latency/cost**: each of these adds at least one more LLM
call per query before retrieval even starts (rewriting: one call;
multi-query: one call producing N variants, or N calls, plus N times the
retrieval work to merge; HyDE: one generation call before embedding),
on top of the embedding call the dense leg already makes and the
reranking call already added in this deliverable. Each is a real,
uncached-by-default cost added to the query path, not a one-time
indexing cost.

**Future evaluation evidence that would trigger adding them**: this
deliverable's own 12-question evaluation showed every relevant chunk
already reachable within the hybrid retriever's top 5 (see the
Reranking Decision section above) — there is no recall failure in this
evaluation's evidence for a query-transformation technique to fix. The
trigger to reconsider is evaluation evidence of the specific failure
mode each technique targets: a documented set of real or representative
approver questions where the correct chunk is absent from the
`candidates_per_leg`-sized candidate pool entirely (not merely
mis-ranked within it — that is what reranking addresses, not query
transformation), traced to query phrasing rather than a chunking or
indexing defect. Adding any of these without that evidence would be
adding latency and cost against a problem not yet shown to exist on this
corpus.

## Consequences

POSITIVE: Hierarchical chunking keeps every retrieved chunk
self-describing and citable — a stable `chunk_id`, `section_id`,
`source`, and byte `offset` that reproduces the chunk's own text when
read back from the source file (verified, not assumed), and a threshold
table is never separated from the heading/prose that explains it.

POSITIVE: The exact-identifier and near-duplicate-pair retrieval
problems this ADR's Context section describes were each demonstrated
against the real corpus and then closed by a verified mechanism (the
literal-section-id short-circuit; RRF fusing two independently-tenant-scoped
legs querying one shared table), not left as known gaps.

POSITIVE: Tenant isolation is enforced inside each leg's own query and
proven against a deliberately adversarial second-tenant fixture, not
merely asserted — the closest thing this deliverable has to a
production security guarantee for multi-tenant retrieval.

NEGATIVE (query cost/latency): every query pays for at least one
embedding API call (dense leg) plus, in this deliverable's evaluation
path, one reranking chat-completion call — two LLM calls per query on
top of two Postgres queries, when reranking is used. Every one of those
calls is a real network round trip with real cost unless served from
cache.

POSITIVE (what caching removes from repeated runs): the embedding cache
(`.cache/embeddings/`, keyed by `chunk_text + model + dimensions`,
`embed.py`) and the rerank cache (`.cache/rerank/`, keyed by question
text + ordered candidate ids + each candidate's content hash + resolved
model id + prompt version + reranking config, `rerank.py`) mean an
unchanged second run of either the loader or the eval reranking pass
makes **zero** API calls — measured directly: a second `embed.py` run
against an unchanged corpus reports `api_calls=0`
(`prompt-journal/0012-cited-scored-retriever.md`), and a
`run_rerank.py` run against unchanged questions/candidates/model reaches
`api_requests=0, cache_hits=12` once the run also reuses a persisted
last-known resolved model id to seed its very first cache lookup
(`prompt-journal/0012-cited-scored-retriever.md` — a real cold-start
caching gap found and fixed during this deliverable, not designed in
from the start). Caching removes repeated-run cost; it does not remove first-run
cost, and a cache miss (changed content, changed model resolution) still
makes a real call.

NEGATIVE (what must be regenerated when corpus content changes): editing
a chunk's text changes its `content_hash` but not its `chunk_id` (a
deliberate split — `chunker.content_hash`/`Chunk.chunk_id`), so
`embed.py`'s idempotent loader correctly detects the change and
re-embeds only that chunk on the next run — but every downstream
artifact keyed off the OLD content (`services/retrieval/eval/rankings.jsonl`'s
recorded baseline/reranked rankings, `eval/pool.jsonl`'s frozen pool, and
any `relevant_chunk_ids` judgments made against that pool) is now stale
and must be regenerated: re-run the baseline retrieval, re-run
reranking, rebuild the pool, and re-judge relevance against the new
pool. Nothing in this deliverable automatically detects and invalidates
those downstream files when the corpus changes.

NEGATIVE (the frozen-pool caveat): relevance judgments
(`seed_pairs.jsonl`'s `relevant_chunk_ids`) are judgments about a
specific, frozen candidate set — the deduplicated union of one baseline
top-10 ranking and one reranked top-10 ranking, captured at a specific
point in time (`eval/build_pool.py`'s module docstring states this
explicitly). If the retriever changes materially — a different
`candidates_per_leg`, a different embedding model, a chunking change
that alters which chunks exist, a different RRF `k` — the rankings that
produced the frozen pool no longer describe what the retriever would
actually return today. The existing judgments are then tied to a pool
the current retriever did not produce, and **the pool must be rebuilt
and relevance re-judged from a fresh baseline/reranked run**, not
patched or reused against a changed retriever's output.
