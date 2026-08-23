"""Embedding loader: chunks the synthetic expense-policy corpus with
chunker.py, embeds each chunk with OpenAI text-embedding-3-small at 1536
dimensions, and loads every chunk into the unified retrieval.corpus_chunk
table (services/retrieval/db/migrations/0001_corpus_chunks.sql).

This is the loader half of the retrieval pipeline: chunker.py already
proved it doesn't call any API or touch Postgres (see its own module
docstring and services/retrieval/tests/test_chunker.py); this module is
where those two things finally happen, but only here.

Idempotency is the central design constraint. A chunk's identity for
loading purposes is (tenant_id, chunk_id) -- the same natural key the
migration's corpus_chunk_tenant_chunk_id_unique constraint enforces (see
that migration's own comment on why chunk_id, not id, is the stable key).
Every load is an upsert on that key:

  - Unchanged chunk (same content_hash already stored): the row is left
    as-is and the embedding API is not called at all -- checked by
    comparing content_hash against what's already in Postgres BEFORE
    touching the embedding cache or the API, since a Postgres round trip
    is cheaper than either.
  - Changed chunk (content_hash differs from what's stored, or the row
    doesn't exist yet): the row is upserted with the new text/hash, and
    an embedding is fetched -- from the on-disk cache if a prior run
    already embedded this exact text under this exact model+dimensions,
    otherwise from the OpenAI API.

The on-disk embedding cache (.cache/embeddings/, gitignored) is keyed by
hash(chunk_text, model, dimensions) -- deliberately NOT by chunk_id, so
that (a) two different chunks that happen to have identical text can
share one cache entry, and (b) editing a chunk's text (which does not
change its chunk_id -- see chunker.py's chunk_id/content_hash split)
produces a NEW cache key and can never silently reuse the old text's
embedding. This is the same identity split chunker.py already makes
between chunk_id (location) and content_hash (content); this module reuses
chunker.content_hash() as an input to the cache key.

OPENAI_API_KEY is read from the environment (os.environ) only. It is
never written to any file this module produces: not the cache (only the
resulting embedding vector and non-secret metadata are cached, see
_cache_path()/_load_from_cache()/_save_to_cache()), not the database, not
logs (the OpenAiEmbedder logs batch sizes and cache hit/miss counts, never
key material or request headers), and not any fixture.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from chunker import Chunk, ChunkingConfig, chunk_corpus, content_hash, load_chunking_config

RETRIEVAL_DIR = Path(__file__).resolve().parent
RETRIEVAL_TOML_PATH = RETRIEVAL_DIR / "retrieval.toml"


def _default_cache_dir() -> Path:
    """Embeddings live under <retrieval.toml's [cache].directory>/embeddings
    -- reads the configured cache root rather than hardcoding '.cache/' a
    second time, so retrieval.toml stays the single place that directory
    is named."""
    import tomllib

    with RETRIEVAL_TOML_PATH.open("rb") as f:
        data = tomllib.load(f)
    cache_root = RETRIEVAL_DIR / data["cache"]["directory"]
    return cache_root / "embeddings"


DEFAULT_CACHE_DIR = _default_cache_dir()

DEFAULT_TENANT_ID = "tenant-synthetic-northwind-prairie"
"""The one fixed synthetic tenant this corpus belongs to -- see
data/corpus/CORPUS-SPEC.md's tenant metadata section. Retrieval's own
loader does not invent a second tenant identity; every document's own
front matter already carries this same tenant_id, so this constant is
only a fallback for chunks (Chunk objects carry no tenant_id field of
their own -- tenancy is a corpus-level fact, not a per-chunk one)."""

EMBED_BATCH_SIZE = 16
"""Chunks per OpenAI embeddings API call. Batching only changes how many
HTTP round trips are made -- the returned embedding for each input text is
identical whether requested alone or as part of a batch (OpenAI's
embeddings endpoint does not do cross-input normalization), so this number
is a throughput/latency choice, not a correctness one. 16 keeps a single
batch's total token count comfortably under this corpus's own largest
chunk size (max_tokens=512 per retrieval.toml) times batch size, with
headroom under the API's per-request limits."""

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EmbeddingConfig:
    provider: str
    model: str
    dimensions: int


def load_embedding_config(path: Path = RETRIEVAL_TOML_PATH) -> EmbeddingConfig:
    import tomllib

    with path.open("rb") as f:
        data = tomllib.load(f)
    embedding = data["embedding"]
    return EmbeddingConfig(
        provider=embedding["provider"],
        model=embedding["model"],
        dimensions=embedding["dimensions"],
    )


@dataclass(frozen=True)
class DbConfig:
    database_uri: str


def load_db_config() -> DbConfig:
    database_uri = os.environ.get("DATABASE_URI")
    if not database_uri:
        msg = "DATABASE_URI is not set in the environment"
        raise RuntimeError(msg)
    return DbConfig(database_uri=database_uri)


def _require_openai_api_key() -> str:
    """Reads OPENAI_API_KEY from the environment only -- never from a
    config file, a CLI argument, or a hardcoded default. Raises with a
    message that does not echo any partial key value."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        msg = "OPENAI_API_KEY is not set in the environment"
        raise RuntimeError(msg)
    return api_key


# --- embedding cache -------------------------------------------------


def cache_key(chunk_text: str, model: str, dimensions: int) -> str:
    """Cache key derived from chunk CONTENT + model + dimensions --
    deliberately not chunk_id, so editing a chunk's text always produces a
    fresh cache key (never reuses the old text's embedding) and two
    identical-text chunks can share one cache entry."""
    payload = f"{chunk_text}\x00{model}\x00{dimensions}".encode()
    return hashlib.sha256(payload).hexdigest()


def _cache_path(cache_dir: Path, key: str) -> Path:
    return cache_dir / f"{key}.json"


def _load_from_cache(cache_dir: Path, key: str) -> list[float] | None:
    path = _cache_path(cache_dir, key)
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return data["embedding"]


def _save_to_cache(
    cache_dir: Path, key: str, model: str, dimensions: int, embedding: list[float]
) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = _cache_path(cache_dir, key)
    # Only non-secret metadata and the resulting embedding vector are
    # ever written here -- no API key, no request headers, no raw HTTP
    # response.
    payload = {"model": model, "dimensions": dimensions, "embedding": embedding}
    tmp_path = path.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f)
    tmp_path.replace(path)


# --- embedder ----------------------------------------------------------


@dataclass
class EmbedStats:
    """Instrumentation counters for one load run, used by both the CLI
    summary and the test suite to assert cache/idempotency behavior
    without scraping log output."""

    cache_hits: int = 0
    cache_misses: int = 0
    api_calls: int = 0
    chunks_embedded: int = 0
    chunks_skipped_unchanged: int = 0
    rows_upserted: int = 0


class OpenAiEmbedder:
    """Thin wrapper around the OpenAI embeddings API plus the on-disk
    cache. Batches cache-miss texts into groups of EMBED_BATCH_SIZE before
    calling the API -- batching is purely a throughput choice (see
    EMBED_BATCH_SIZE's docstring), the embedding returned for a given text
    is the same regardless of batch size or position within a batch.
    """

    def __init__(
        self,
        config: EmbeddingConfig,
        api_key: str,
        cache_dir: Path = DEFAULT_CACHE_DIR,
        stats: EmbedStats | None = None,
    ) -> None:
        from openai import OpenAI

        self.config = config
        self.cache_dir = cache_dir
        self.stats = stats if stats is not None else EmbedStats()
        self._client = OpenAI(api_key=api_key)

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Returns one embedding per input text, in the same order,
        serving each from cache when available and calling the API in
        batches only for the texts that miss."""
        keys = [cache_key(t, self.config.model, self.config.dimensions) for t in texts]
        results: list[list[float] | None] = [None] * len(texts)

        miss_indices: list[int] = []
        for i, key in enumerate(keys):
            cached = _load_from_cache(self.cache_dir, key)
            if cached is not None:
                results[i] = cached
                self.stats.cache_hits += 1
            else:
                miss_indices.append(i)
                self.stats.cache_misses += 1

        for batch_start in range(0, len(miss_indices), EMBED_BATCH_SIZE):
            batch_indices = miss_indices[batch_start : batch_start + EMBED_BATCH_SIZE]
            batch_texts = [texts[i] for i in batch_indices]
            embeddings = self._call_api(batch_texts)
            for idx, embedding in zip(batch_indices, embeddings):
                results[idx] = embedding
                _save_to_cache(
                    self.cache_dir, keys[idx], self.config.model, self.config.dimensions, embedding
                )

        assert all(r is not None for r in results)  # noqa: S101 - internal invariant, not user input
        return results  # type: ignore[return-value]

    def _call_api(self, texts: list[str]) -> list[list[float]]:
        self.stats.api_calls += 1
        logger.info("embedding API call: batch_size=%d model=%s", len(texts), self.config.model)
        response = self._client.embeddings.create(
            input=texts,
            model=self.config.model,
            dimensions=self.config.dimensions,
        )
        # OpenAI's API returns embeddings in the same order as the input
        # list (documented behavior), but each item also carries its own
        # `index`, so sort by that rather than trusting response ordering
        # blindly.
        ordered = sorted(response.data, key=lambda item: item.index)
        return [item.embedding for item in ordered]


# --- database loader -----------------------------------------------------

_UPSERT_SQL = """
insert into retrieval.corpus_chunk
    (tenant_id, chunk_id, source, section_id, section_heading_path,
     doc_title, chunk_offset, part_index, part_count, chunk_text,
     content_hash, token_estimate, embedding)
values
    (%(tenant_id)s, %(chunk_id)s, %(source)s, %(section_id)s,
     %(section_heading_path)s, %(doc_title)s, %(chunk_offset)s,
     %(part_index)s, %(part_count)s, %(chunk_text)s, %(content_hash)s,
     %(token_estimate)s, %(embedding)s)
on conflict (tenant_id, chunk_id) do update set
    source = excluded.source,
    section_id = excluded.section_id,
    section_heading_path = excluded.section_heading_path,
    doc_title = excluded.doc_title,
    chunk_offset = excluded.chunk_offset,
    part_index = excluded.part_index,
    part_count = excluded.part_count,
    chunk_text = excluded.chunk_text,
    content_hash = excluded.content_hash,
    token_estimate = excluded.token_estimate,
    embedding = excluded.embedding,
    updated_at = now()
"""

_EXISTING_HASHES_SQL = """
select chunk_id, content_hash
from retrieval.corpus_chunk
where tenant_id = %(tenant_id)s
"""


def _fetch_existing_content_hashes(connection, tenant_id: str) -> dict[str, str]:
    """Reads {chunk_id: content_hash} for every chunk already stored for
    this tenant. This is the check that lets an unchanged second run skip
    both the embedding cache lookup and the API entirely for unchanged
    chunks -- it happens before either, since a Postgres round trip for
    already-known content is cheaper than a cache-file stat, let alone an
    API call."""
    with connection.cursor() as cursor:
        cursor.execute(_EXISTING_HASHES_SQL, {"tenant_id": tenant_id})
        return dict(cursor.fetchall())


def _vector_literal(embedding: list[float]) -> str:
    return "[" + ",".join(repr(x) for x in embedding) + "]"


def load_corpus(
    tenant_id: str = DEFAULT_TENANT_ID,
    corpus_dir: Path | None = None,
    chunking_config: ChunkingConfig | None = None,
    embedding_config: EmbeddingConfig | None = None,
    cache_dir: Path = DEFAULT_CACHE_DIR,
    db_config: DbConfig | None = None,
    embedder: OpenAiEmbedder | None = None,
) -> EmbedStats:
    """Chunk the corpus, embed whatever changed, and upsert every chunk
    into retrieval.corpus_chunk. Returns EmbedStats so callers (the CLI
    entrypoint and the test suite) can inspect exactly what happened --
    cache hits/misses, API calls, rows touched -- without re-deriving it.

    corpus_dir defaults to chunker.CORPUS_DIR (data/corpus/, the
    Deliverable-1/2 single-tenant corpus) when omitted. A caller loading a
    second tenant's content from a different directory (e.g.
    data/corpus-tenant-b/ -- see the tenant-isolation regression test)
    passes both a different tenant_id and a different corpus_dir; the two
    are independent parameters because tenant_id is how a chunk is scoped
    in the DATABASE, while corpus_dir is only where its source Markdown
    lives on disk.
    """
    import psycopg

    if chunking_config is None:
        chunking_config = load_chunking_config()
    if embedding_config is None:
        embedding_config = load_embedding_config()
    if db_config is None:
        db_config = load_db_config()

    stats = EmbedStats()
    if embedder is None:
        api_key = _require_openai_api_key()
        embedder = OpenAiEmbedder(embedding_config, api_key, cache_dir=cache_dir, stats=stats)
    else:
        stats = embedder.stats

    chunk_corpus_kwargs = {"config": chunking_config}
    if corpus_dir is not None:
        chunk_corpus_kwargs["corpus_dir"] = corpus_dir
    chunks = chunk_corpus(**chunk_corpus_kwargs)

    with psycopg.connect(db_config.database_uri) as connection:
        existing_hashes = _fetch_existing_content_hashes(connection, tenant_id)

        chunks_to_embed: list[Chunk] = []
        for chunk in chunks:
            stored_hash = existing_hashes.get(chunk.chunk_id)
            if stored_hash == content_hash(chunk):
                stats.chunks_skipped_unchanged += 1
            else:
                chunks_to_embed.append(chunk)

        embeddings: list[list[float]] = []
        if chunks_to_embed:
            embeddings = embedder.embed_texts([c.text for c in chunks_to_embed])
        stats.chunks_embedded = len(chunks_to_embed)

        with connection.cursor() as cursor:
            for chunk, embedding in zip(chunks_to_embed, embeddings):
                cursor.execute(
                    _UPSERT_SQL,
                    {
                        "tenant_id": tenant_id,
                        "chunk_id": chunk.chunk_id,
                        "source": chunk.source,
                        "section_id": chunk.section_id,
                        "section_heading_path": chunk.section_heading_path,
                        "doc_title": chunk.doc_title,
                        "chunk_offset": chunk.offset,
                        "part_index": chunk.part_index,
                        "part_count": chunk.part_count,
                        "chunk_text": chunk.text,
                        "content_hash": content_hash(chunk),
                        "token_estimate": chunk.token_estimate,
                        "embedding": _vector_literal(embedding),
                    },
                )
                stats.rows_upserted += 1
        connection.commit()

    return stats


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    run_stats = load_corpus()
    print(
        f"chunks_embedded={run_stats.chunks_embedded} "
        f"chunks_skipped_unchanged={run_stats.chunks_skipped_unchanged} "
        f"cache_hits={run_stats.cache_hits} cache_misses={run_stats.cache_misses} "
        f"api_calls={run_stats.api_calls} rows_upserted={run_stats.rows_upserted}"
    )
