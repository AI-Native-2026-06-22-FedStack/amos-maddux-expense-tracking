-- Corpus chunk store owned by services/retrieval, dedicated to retrieval
-- output only. Per ADR-0006 (service boundaries and anti-shared-DB rule)
-- and ADR-0009 (storage per bounded context), retrieval must never read
-- or write apps/api's or services/compute's operational tables -- this
-- schema exists so retrieval output has its own owned home, matching
-- services/pipeline's pipeline_analytics precedent
-- (services/pipeline/db/migrations/0001_pipeline_analytics_schema.sql).
--
-- No second database and no separate vector database are introduced: this
-- table lives in the same PostgreSQL instance every other ExpenseFlow
-- service already uses (docker-compose.yml's postgres service, now
-- pgvector/pgvector:pg17 so the vector extension below is available).
create schema if not exists retrieval;

-- Required for the vector(1536) embedding column below (see
-- services/retrieval/retrieval.toml's [embedding] section --
-- text-embedding-3-small's native output dimension). The HNSW (or any
-- other ANN) index on that column is deliberately NOT created by this
-- migration -- that belongs to Deliverable 4, once real embeddings exist
-- to size and tune an index against.
create extension if not exists vector;

-- One row per chunk produced by services/retrieval/chunker.py. Supports
-- both retrieval legs from this single table rather than a separate
-- keyword-index/vector-index table pair:
--   - keyword (sparse/lexical) leg: search_vector (tsvector) + the GIN
--     index below, tenant-scoped via the composite index's leading
--     tenant_id column.
--   - dense (embedding) leg: embedding (vector(1536)). No ANN index yet
--     (see above) -- Deliverable 4's job once populated.
--
-- Every field the chunker's Chunk dataclass carries
-- (services/retrieval/chunker.py) has a corresponding column here, so a
-- retrieved row is fully self-describing without a second lookup back
-- into data/corpus/ -- provenance (source, section id, offset, content
-- hash) lives directly in the table, not bolted on separately.
create table if not exists retrieval.corpus_chunk (
    id uuid not null default gen_random_uuid(),
    tenant_id text not null,
    chunk_id text not null,
    source text not null,
    section_id text not null,
    section_heading_path text not null,
    doc_title text not null,
    chunk_offset integer not null,
    part_index integer not null default 0,
    part_count integer not null default 1,
    chunk_text text not null,
    content_hash text not null,
    token_estimate integer not null,
    search_vector tsvector generated always as (to_tsvector('english', chunk_text)) stored,
    embedding vector(1536),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint corpus_chunk_pkey primary key (id),

    -- Idempotent-loader uniqueness: chunk_id is stable and deterministic
    -- per document (see chunker.py's Chunk.chunk_id docstring -- it is
    -- derived from section structure, not a random value or a row
    -- counter), but is only guaranteed unique WITHIN one tenant's corpus.
    -- A re-run loader upserts on (tenant_id, chunk_id): unchanged content
    -- produces the same chunk_id and can be safely re-inserted or
    -- updated in place, without relying on content_hash or id (the
    -- surrogate primary key, which is NOT stable across re-runs) to
    -- detect "is this the same chunk".
    constraint corpus_chunk_tenant_chunk_id_unique unique (tenant_id, chunk_id),

    constraint corpus_chunk_offset_check check (chunk_offset >= 0),
    constraint corpus_chunk_part_index_check check (part_index >= 0),
    constraint corpus_chunk_part_count_check check (part_count >= 1),
    constraint corpus_chunk_part_index_lt_count_check check (part_index < part_count),
    constraint corpus_chunk_token_estimate_check check (token_estimate > 0),
    constraint corpus_chunk_source_not_blank_check check (length(trim(source)) > 0),
    constraint corpus_chunk_section_id_not_blank_check check (length(trim(section_id)) > 0),
    constraint corpus_chunk_chunk_text_not_blank_check check (length(trim(chunk_text)) > 0),
    constraint corpus_chunk_content_hash_not_blank_check check (length(trim(content_hash)) > 0)
    -- No separate embedding-dimension CHECK: vector(1536) already enforces
    -- the dimension at the type level (verified: inserting a differently-
    -- sized vector raises "expected 1536 dimensions, not N" on its own),
    -- so a redundant CHECK would duplicate what the column type already
    -- guarantees.
);

-- Tenant-scoped keyword (lexical) leg. GIN only supports tsvector_ops on
-- the generated search_vector column itself -- plain text (tenant_id) has
-- no default GIN operator class, so a single composite GIN index over
-- both columns is not possible without a separate opclass extension
-- (deliberately not introduced here). Instead: a plain GIN index on
-- search_vector for the `search_vector @@ query` match, plus the
-- tenant_id-leading btree indexes below (corpus_chunk_tenant_section_id_idx,
-- corpus_chunk_tenant_source_idx) and the tenant_id-leading unique
-- constraint's own index give the planner tenant-selective access paths
-- to combine with a bitmap AND -- the standard way tsvector search is
-- combined with tenant/row filtering in Postgres.
create index if not exists corpus_chunk_search_vector_idx
    on retrieval.corpus_chunk using gin (search_vector);

-- Tenant-scoped keyword leg, continued: an explicit btree covering
-- (tenant_id, id) so a tenant-scoped keyword query has a direct,
-- tenant-selective row set to intersect with the GIN bitmap above, even
-- on a query shape that does not also filter by section_id or source.
create index if not exists corpus_chunk_tenant_id_idx
    on retrieval.corpus_chunk (tenant_id, id);

-- Tenant-scoped lookup by section id (citation/eval joins back to a
-- specific NWP-POL-* section, and re-chunking-run comparisons).
create index if not exists corpus_chunk_tenant_section_id_idx
    on retrieval.corpus_chunk (tenant_id, section_id);

-- Tenant-scoped lookup by source document (re-chunking a single document,
-- or listing all chunks for one file during eval).
create index if not exists corpus_chunk_tenant_source_idx
    on retrieval.corpus_chunk (tenant_id, source);

-- NOTE: no HNSW (or other ANN) index on embedding is created here by
-- design -- see the extension comment above. Deliverable 4 adds it once
-- real embeddings are loaded and there is actual data to size/tune an
-- index against, rather than guessing index parameters against an empty
-- column now.
