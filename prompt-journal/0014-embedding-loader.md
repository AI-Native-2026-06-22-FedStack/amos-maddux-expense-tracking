# 0014 — Embedding Loader (Deliverable 3, continued)

- **_Problem:_** Implement `services/retrieval/embed.py`: chunk the
  corpus with `chunker.py`, embed each chunk with `text-embedding-3-small`
  at 1536 dimensions, and load into `retrieval.corpus_chunk`
  (`services/retrieval/db/migrations/0001_corpus_chunks.sql`) idempotently
  -- an unchanged second run must not grow the row count or call the API
  again, and a changed chunk must never silently reuse the old text's
  embedding.

- **_Produced:_** `services/retrieval/embed.py` (chunk → cache-or-embed →
  upsert pipeline), `services/retrieval/tests/test_embed.py` (13 tests:
  cache-key derivation/collision rules via a `FakeEmbedder` with no
  network access, plus 3 tests against the real local Postgres proving
  idempotent row count, complete provenance, and exact section-id
  preservation). Added `openai`/`psycopg[binary]` to
  `services/retrieval/pyproject.toml` and ran `uv sync`
  (`services/retrieval/uv.lock` is new, committed per this repo's
  per-service lockfile convention).

- **_Key design choices:_**

  Idempotency check order: content_hash comparison against what's already
  in Postgres happens BEFORE either the on-disk cache or the API is
  touched -- a DB round trip for already-known content is cheaper than
  either. This is why the true no-op second run shows
  `cache_hits=0 cache_misses=0 api_calls=0`, not merely
  `api_calls=0`: unchanged chunks never even reach the cache layer.

  Cache key = `sha256(chunk_text + model + dimensions)`, never chunk_id
  alone (explicit requirement) -- verified two different chunk_ids with
  identical text collide to the same key, and edited text under the SAME
  chunk_id produces a different key. Loader uniqueness for the upsert
  itself is the separate `(tenant_id, chunk_id)` key the migration's
  `corpus_chunk_tenant_chunk_id_unique` constraint already enforces --
  these are deliberately two different keys for two different jobs
  (content identity vs. row identity), matching the chunk_id/content_hash
  split `chunker.py` already established.

  `OPENAI_API_KEY` read via `os.environ.get()` only, never written
  anywhere this module produces -- verified with a real key present
  in-process that no cache file on disk contains it.

- **_Accepted / Rejected:_**

  ACCEPTED: `DEFAULT_CACHE_DIR` reads the cache root from
  `retrieval.toml`'s `[cache].directory` rather than hardcoding
  `.cache/embeddings` a second time, so `retrieval.toml` stays the single
  place that path is configured.

  ACCEPTED (real gap found while running, not asked for): the shell's
  ambient `DATABASE_URI` (`postgresql:///expense_tracking`, left over
  from something outside this task) and `.env`'s own `DATABASE_URI`
  (`postgres://expenseflow@localhost:5433/expenseflow`, missing a
  password) both failed to connect directly. Neither is this module's
  bug -- `config.py`'s existing convention across this repo is a plain
  `os.getenv()` read with no dotenv loader, so env vars are expected to
  already be correct in the process environment (via Docker Compose's
  `env_file`, a Makefile export, or a manually sourced `.env`) -- so
  fixed it locally for this run (`export
  DATABASE_URI=postgres://expenseflow:synthetic-compose-db-password@localhost:5433/expenseflow`)
  rather than adding a dotenv dependency or changing the convention.

- **_Verification beyond the required first/second run:_** additionally
  ran a third scenario -- edited one real corpus file's dollar amount,
  ran the loader (1 API call, 1 cache miss, 42 skipped, row count stayed
  43, the one row's `updated_at` advanced past `created_at`), then
  reverted the edit and ran again (0 API calls, 1 cache HIT -- the
  original text's embedding was still cached from the very first run --
  proving the cache is genuinely content-keyed, not "most recent write
  wins"), then a final true no-op run confirming the system returns to
  the `0/0/0` steady state. All test/scratch edits to `data/corpus/` were
  reverted; the corpus tree is unchanged from before this task.
