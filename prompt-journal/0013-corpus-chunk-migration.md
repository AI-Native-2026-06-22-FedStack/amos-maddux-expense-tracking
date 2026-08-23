# 0013 — Corpus Chunk Table Migration (Deliverable 3)

- **_Problem:_** Create the Postgres migration for `services/retrieval`'s
  chunk store: one table supporting both keyword (tsvector) and dense
  (`vector(1536)`) retrieval, with provenance, an idempotent-loader
  uniqueness rule, and tenant-scoped keyword indexes -- but explicitly
  without the HNSW/ANN vector index (Deliverable 4's job). Apply it
  against the real local Postgres and inspect the actual resulting table,
  not just the SQL as written.

- **_Blocking discovery:_** The running `postgres:17-alpine` container
  (this repo's existing image, per `docker-compose.yml`) has no `vector`
  extension available at all (`pg_available_extensions` returned zero
  rows) -- `create extension vector` would fail outright. Flagged this
  rather than writing a migration that could never actually apply.

- **_Asked (via AskUserQuestion):_** How to resolve the missing
  extension. User chose swapping `docker-compose.yml`'s postgres image to
  `pgvector/pgvector:pg17` (official pgvector-maintained build, same
  PostgreSQL 17 major version) over leaving the migration unapplied or
  handing off the image change. Confirmed separately before recreating
  the container: the existing volume held 146 real local-dev relations
  (drizzle-migrated `apps/api` tables, `pipeline_analytics`, etc.); user
  approved wiping to a fresh volume (synthetic/reproducible data) and
  restoring via `./scripts/seed.sh` (`compose-init`) rather than
  attempting an unsupported in-place base-image swap on the old volume.

- **_Produced:_**

  `docker-compose.yml` -- postgres image changed from `postgres:17-alpine`
  to `pgvector/pgvector:pg17`, with a comment explaining why and pointing
  at ADR-0006/ADR-0009 (no second/separate vector database introduced).

  `services/retrieval/db/migrations/0001_corpus_chunks.sql` -- new
  migration (`services/retrieval` had no prior migrations, so this is its
  own `0001`, independent of `apps/api`'s/`services/compute`'s/
  `services/pipeline`'s own `NNNN` sequences, per this repo's existing
  per-service migration numbering convention). Creates the `retrieval`
  schema (mirrors `pipeline_analytics`'s owned-schema precedent),
  `create extension if not exists vector`, and
  `retrieval.corpus_chunk` with every `chunker.Chunk` field represented,
  a generated `tsvector` column, `vector(1536)` embedding column (no ANN
  index), and four supporting indexes.

- **_Accepted / Rejected (bugs found and fixed by actually applying the
  migration, not just reading the SQL):_**

  ACCEPTED (real bug, first apply attempt): `create index ... using gin
  (tenant_id, search_vector)` failed --
  `data type text has no default operator class for access method "gin"`.
  A composite GIN index needs every column to have a GIN opclass;
  `tsvector_ops` covers `search_vector` but plain `text` has none by
  default. Asked the user (AskUserQuestion) how to resolve rather than
  guessing at an opclass extension; chose the recommended fix: a plain
  `GIN(search_vector)` index plus the existing tenant-leading btree
  indexes (`corpus_chunk_tenant_id_idx`, `..._section_id_idx`,
  `..._source_idx`) for the planner to combine via bitmap AND -- the
  standard way tsvector search combines with tenant/row filtering in
  Postgres, without adding `btree_gin` for a marginal selectivity gain.

  ACCEPTED (self-caught while inspecting the applied table, not asked
  for): the explicit `corpus_chunk_embedding_dimensions_check` CHECK
  constraint was redundant -- verified directly by inserting a 10-element
  vector into the `vector(1536)` column, which Postgres itself rejected
  ("expected 1536 dimensions, not 10") before any CHECK constraint would
  even run. Removed the redundant constraint rather than leaving
  duplicated logic in the schema.

  ACCEPTED: after the first (partially-failed) apply left 3 of 4 indexes
  created (`psql -f` continues past a statement error by default), rather
  than patching around a half-applied schema, dropped `schema retrieval
  cascade` and reapplied the corrected migration from a clean state, then
  re-ran it a second time unchanged to verify every `if not exists` guard
  makes the whole migration safely idempotent.

- **_Verification performed beyond `\d+`:_** inserted a real row, then
  ran an `ON CONFLICT (tenant_id, chunk_id) DO UPDATE` with different
  `chunk_text`/`content_hash` to prove the idempotent-loader uniqueness
  rule actually upserts in place (one row, `updated_at > created_at`)
  rather than erroring or duplicating. Verified the generated
  `search_vector` column populates correctly from `chunk_text`
  (`to_tsvector('english', ...)`, spot-checked lexemes). Verified the
  `embedding` column accepts a real 1536-element vector and rejects a
  wrong-sized one. Confirmed via `pg_indexes` that no HNSW/IVFFlat index
  exists on `embedding` (Deliverable 4's scope, not this one's). All test
  rows removed via the same schema drop/reapply used for the index fix,
  so the table is empty and clean at hand-off.
