-- HNSW index for the retrieval-owned policy corpus dense-search leg.
--
-- The policy corpus table is owned by the retrieval bounded context, but
-- this forward migration lives here because the deliverable asks for the
-- app migration numbering convention. It does not change the retriever or
-- the embedding tier: retrieval.corpus_chunk.embedding remains vector(1536),
-- matching services/retrieval/retrieval.toml's text-embedding-3-small
-- configuration.
--
-- The dense retrieval query orders by embedding <=> query_embedding, so
-- vector_cosine_ops is the matching pgvector operator class. Parameters
-- m=8 and ef_construction=32 keep build cost low for the current small
-- synthetic corpus while still creating the production query shape that
-- can be revisited when corpus size and recall requirements grow.
create index if not exists corpus_chunk_embedding_hnsw_idx
    on retrieval.corpus_chunk
    using hnsw (embedding vector_cosine_ops)
    with (m = 8, ef_construction = 32);
