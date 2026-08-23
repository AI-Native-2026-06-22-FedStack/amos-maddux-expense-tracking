# 0018 — ADR-0028: Chunking and Retrieval

- **_Problem:_** Write `docs/adr/0028-chunking-and-retrieval.md` recording
  the actual decisions and measured evidence from the chunking/retrieval
  deliverable (prompt-journal 0012–0017): the three production retrieval
  problems being addressed, the chunking decision (hierarchical, max
  chunk size, overlap), the retrieval decision (tsvector + pgvector legs,
  shared table, mandatory tenant scope, RRF k=60, rank-not-score
  fusion), the reranking decision (batched per-question requests,
  configured/resolved model, measured Precision@5 before/after), and
  deferred query transformation (rewriting/multi-query/HyDE) — without
  duplicating the small-vs-large embedding model decision assigned to
  ADR-0029.

- **_Produced:_** `docs/adr/0028-chunking-and-retrieval.md` (next
  available ADR number; 0028 did not exist, 0029 does not exist yet —
  confirmed both before writing), following this repo's existing MADR
  conventions (Status/Context/Decision/Consequences with
  POSITIVE/NEGATIVE tags, plus extended named sections where the content
  needed them — matching ADR-0027's shape, not the bare template).

- **_Every value recorded in the ADR was re-measured from the actual
  committed files, not recalled from memory:_**

  Re-read `services/retrieval/retrieval.toml` in full for the exact
  current config (`max_tokens=512`, `overlap_tokens=64` present-but-unused,
  `rrf_k=60`, `candidates_per_leg=20`, `[rerank].model="gpt-4o-mini"`).

  Re-ran `chunker.chunk_corpus()` against the live corpus to confirm the
  actual maximum observed chunk size (355 tokens) against the configured
  ceiling (512), rather than trusting the number recorded in an earlier
  prompt-journal entry.

  Grepped `chunker.py` for every `overlap` reference to confirm
  `overlap_tokens` is loaded into `ChunkingConfig` but never read by any
  actual splitting function — the "overlap: not used" claim in the ADR
  is a verified code-level fact, not a design intent restated from
  memory.

  Re-read a real `rerank_config` entry from
  `services/retrieval/eval/rankings.jsonl` to confirm the resolved model
  id string (`gpt-4o-mini-2024-07-18`) exactly, rather than retyping it
  from an earlier turn's chat output.

  Re-ran `services/retrieval/eval/precision_at_5.py` (offline, no
  `DATABASE_URI`/`OPENAI_API_KEY` set, plain `python3`, no `uv`/venv) to
  reconfirm the exact before/after mean Precision@5 values (0.2500 /
  0.2500) immediately before writing them into the ADR — the ADR's
  "measured" values are from this re-run, not copied from the prior
  turn's transcript.

- **_Scope discipline:_** the ADR's Reranking Decision section
  explicitly states it does not decide the `text-embedding-3-small`
  vs. a larger embedding model tradeoff, naming ADR-0029 as where that
  belongs, per the instruction not to duplicate that future decision.
  No embedding-model-size comparison, cost table, or recommendation for
  a different embedding model appears anywhere in ADR-0028.

- **_Accepted / Rejected:_**

  ACCEPTED: reporting the reranking result honestly as "not justified on
  this measured evidence" rather than either suppressing the flat
  Precision@5 result or overstating reranking's value from the rank-position
  improvements Precision@5 can't see. The ADR explicitly distinguishes
  "the metric measured here didn't move" from "reranking has no effect,"
  citing the concrete Q03 rank-position evidence
  (`prompt-journal/0018`'s own re-verification, matching the prior
  `precision_at_5.py` investigation) so the ADR doesn't read as a
  verdict against reranking that the underlying evidence doesn't
  support.

  ACCEPTED: naming the cold-start rerank-caching bug found and fixed in
  `prompt-journal/0017-llm-reranker.md` explicitly in the ADR's
  Consequences section (what caching removes from repeated runs), since
  it's real, verified behavior of the shipped caching mechanism, not
  design intent.
