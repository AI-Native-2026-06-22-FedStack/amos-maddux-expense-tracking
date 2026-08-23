# 0012 — Retrieval Deliverable: Skeleton Prep Only

- **_Problem:_** Before implementing a retrieval deliverable (hierarchical
  chunking, `text-embedding-3-small` embeddings, RRF fusion, `gpt-4o-mini`
  reranking), prepare only the required skeleton: confirm this
  repository's existing conventions (Python/service layout, migration
  numbering, ADR/prompt-journal/evidence formats, per-service Postgres
  ownership), create the missing directories, and complete a
  `retrieval.toml` config skeleton — without implementing the corpus,
  chunker, embedding loader, retriever, or reranker.

- **_Asked:_** Inspect the repo, confirm prior-work areas exist
  (`services/pipeline/`, `apps/api/`, `services/compute/`, `docs/adr/`,
  `prompt-journal/`, `evidence/`), create only the missing new structure
  (`data/corpus/`, `services/retrieval/`, `services/retrieval/eval/`,
  `services/retrieval/tests/`), and complete a supplied `retrieval.toml`
  skeleton preserving fixed assignment parameters (hierarchical chunking,
  `text-embedding-3-small`, 1536 dims, RRF k=60, top_k=5, `gpt-4o-mini`
  reranker family, `.cache/` gitignored). No retriever code, no new
  database.

- **_Produced:_**

  `services/retrieval/retrieval.toml` — config only, modeled directly on
  `services/pipeline/pipeline.toml`'s existing convention (policy/model
  values in TOML loaded via stdlib `tomllib`; connection details stay in
  env vars per `.env.example`). Sections: `[chunking]` (hierarchical
  strategy + token bounds), `[embedding]` (`text-embedding-3-small`,
  1536 dims, dimension truncation explicitly not used), `[retrieval]`
  (`rrf_k = 60`, `top_k = 5`), `[rerank]` (`gpt-4o-mini`), `[cache]`
  (`.cache/` directory).

  Empty directories created: `data/corpus/`, `services/retrieval/`,
  `services/retrieval/eval/`, `services/retrieval/tests/`. No
  placeholder/`.gitkeep` files added — this repository has no existing
  `.gitkeep` convention (checked: none exist outside tool-cache
  directories), and each of these directories will be populated by the
  next implementation phase.

  `.gitignore` — added `.cache/` (repository previously had no `.cache/`
  entry; existing entries cover `.venv/`, `.uv-cache/`, `.mypy_cache/`,
  etc. but not a service-level runtime cache directory).

- **_Repository conventions confirmed present (no gaps found):_**

  `services/pipeline/`, `apps/api/`, `services/compute/`, `docs/adr/`,
  `prompt-journal/`, `evidence/` all exist with established content —
  see the report given to the user in-session for the full inventory.
  Per-service Python layout: own `pyproject.toml` + `uv.lock` + `.venv/`
  + `tests/`, `ruff`/`mypy`/`pytest` via `uv run`, migrations under
  `<service>/db/migrations/NNNN_description.sql` restarting at `0001`
  per service (see `apps/api/db/migrations/`, `services/compute/db/migrations/`,
  `services/pipeline/db/migrations/`). One shared PostgreSQL instance
  (`docker-compose.yml`, `postgres:17-alpine`), each service owning its
  own schema — no cross-service tables, no second database, no separate
  vector database (`docs/adr/0006-service-boundaries-and-anti-shared-db.md`,
  `docs/adr/0009-storage-per-bounded-context.md`). A `retrieval.toml`
  skeleton was described as "supplied" but did not exist anywhere in the
  repository at the start of this task — flagged to the user rather than
  silently fabricated as pre-existing; the file created here is a new
  skeleton built to the assignment's fixed parameters and this repo's
  `pipeline.toml` convention, not a discovered file.

- **_Accepted / Rejected:_**

  ACCEPTED: naming the eventual embedding storage inside the existing
  PostgreSQL instance (e.g. via the `pgvector` extension on
  `postgres:17-alpine`) rather than introducing a second database,
  per the explicit instruction and per ADR-0006/ADR-0009's existing
  anti-shared-DB and storage-per-bounded-context reasoning. Not yet
  implemented or migrated — flagged as an open decision for the next
  phase (extension enablement, schema/table shape, migration number).

  REJECTED: adding `.gitkeep` files to the new empty directories.
  Considered it for parity with typical scaffold conventions, but this
  repository has no existing `.gitkeep` anywhere outside tool caches, so
  adding one here would introduce a new, unprecedented convention rather
  than follow an established one.
