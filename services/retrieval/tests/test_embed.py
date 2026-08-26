"""Focused tests for services/retrieval/embed.py's cache-key and
idempotency behavior.

These tests never call the real OpenAI API: a FakeEmbedder stands in for
OpenAiEmbedder and records every text it was asked to embed, so tests can
assert exactly how many times "the API" would have been called without
network access, API cost, or nondeterminism. The on-disk cache logic
itself (cache_key, _load_from_cache, _save_to_cache) is exercised for
real, against a temporary cache directory -- only the network call is
faked.

Tests that need a live Postgres connection (the actual idempotent-upsert
behavior against retrieval.corpus_chunk) are marked and skipped if
DATABASE_URI is not reachable, so this suite still runs in an environment
with no database, while proving the real behavior when one is available
(as it is in this repository's local dev setup).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import embed  # noqa: E402
from chunker import Chunk  # noqa: E402
from embed import EmbeddingConfig, EmbedStats, cache_key  # noqa: E402


def _make_chunk(chunk_id: str, text: str, section_id: str | None = None) -> Chunk:
    return Chunk(
        chunk_id=chunk_id,
        source="data/corpus/999-fixture-policy.md",
        section_id=section_id or chunk_id,
        section_heading_path="Fixture Section",
        doc_title="Fixture Policy",
        offset=0,
        part_index=0,
        part_count=1,
        text=text,
        token_estimate=len(text) // 4,
    )


class FakeEmbedder:
    """Records every embed_texts() call and returns a deterministic,
    content-derived fake vector -- no network access. Mirrors
    OpenAiEmbedder's on-disk caching behavior exactly (same cache_key,
    same _load_from_cache/_save_to_cache calls) so cache hit/miss
    counting is tested against the real cache implementation, only the
    API call itself is faked.
    """

    def __init__(self, config: EmbeddingConfig, cache_dir: Path, stats: EmbedStats | None = None):
        self.config = config
        self.cache_dir = cache_dir
        self.stats = stats if stats is not None else EmbedStats()
        self.api_call_texts: list[list[str]] = []

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        keys = [cache_key(t, self.config.model, self.config.dimensions) for t in texts]
        results: list[list[float] | None] = [None] * len(texts)
        miss_indices = []
        for i, key in enumerate(keys):
            cached = embed._load_from_cache(self.cache_dir, key)
            if cached is not None:
                results[i] = cached
                self.stats.cache_hits += 1
            else:
                miss_indices.append(i)
                self.stats.cache_misses += 1

        if miss_indices:
            batch_texts = [texts[i] for i in miss_indices]
            self.api_call_texts.append(batch_texts)
            self.stats.api_calls += 1
            for i in miss_indices:
                fake_vector = _deterministic_fake_vector(texts[i], self.config.dimensions)
                results[i] = fake_vector
                embed._save_to_cache(
                    self.cache_dir, keys[i], self.config.model, self.config.dimensions, fake_vector
                )

        return results  # type: ignore[return-value]


def _deterministic_fake_vector(text: str, dimensions: int) -> list[float]:
    import hashlib

    seed = int(hashlib.sha256(text.encode()).hexdigest(), 16)
    return [((seed >> (i % 64)) % 1000) / 1000.0 for i in range(dimensions)]


@pytest.fixture()
def embedding_config() -> EmbeddingConfig:
    return EmbeddingConfig(provider="openai", model="text-embedding-3-small", dimensions=1536)


@pytest.fixture()
def cache_dir(tmp_path) -> Path:
    return tmp_path / "embeddings-cache"


# --- cache key construction ------------------------------------------


def test_cache_key_derived_from_content_model_and_dimensions(embedding_config):
    key_a = cache_key("some chunk text", embedding_config.model, embedding_config.dimensions)
    key_b = cache_key("some chunk text", embedding_config.model, embedding_config.dimensions)
    assert key_a == key_b, "identical (text, model, dimensions) must produce the same cache key"


def test_cache_key_changes_when_content_changes(embedding_config):
    key_a = cache_key("original text", embedding_config.model, embedding_config.dimensions)
    key_b = cache_key("edited text", embedding_config.model, embedding_config.dimensions)
    assert key_a != key_b


def test_cache_key_changes_when_model_changes(embedding_config):
    key_a = cache_key("same text", "text-embedding-3-small", 1536)
    key_b = cache_key("same text", "text-embedding-3-large", 1536)
    assert key_a != key_b


def test_cache_key_changes_when_dimensions_change(embedding_config):
    key_a = cache_key("same text", "text-embedding-3-small", 1536)
    key_b = cache_key("same text", "text-embedding-3-small", 3072)
    assert key_a != key_b


def test_cache_key_is_not_derived_from_chunk_id(embedding_config):
    # Two different chunk_ids with the SAME text must share a cache key
    # (requirement: never key the cache only by chunk id).
    chunk_a = _make_chunk("NWP-POL-001-01", "identical body text")
    chunk_b = _make_chunk("NWP-POL-002-01", "identical body text")
    key_a = cache_key(chunk_a.text, embedding_config.model, embedding_config.dimensions)
    key_b = cache_key(chunk_b.text, embedding_config.model, embedding_config.dimensions)
    assert key_a == key_b, (
        "cache key must be derived from chunk content, not chunk_id -- "
        "identical text under two different chunk ids must collide"
    )


# --- on-disk cache read/write -------------------------------------------


def test_uncached_text_is_a_cache_miss_then_a_hit_after_saving(embedding_config, cache_dir):
    key = cache_key("some text", embedding_config.model, embedding_config.dimensions)
    assert embed._load_from_cache(cache_dir, key) is None

    embed._save_to_cache(
        cache_dir, key, embedding_config.model, embedding_config.dimensions, [0.1] * 1536
    )
    assert embed._load_from_cache(cache_dir, key) == [0.1] * 1536


def test_cache_never_contains_the_api_key(embedding_config, cache_dir, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-never-appear-in-any-cache-file")
    key = cache_key("some text", embedding_config.model, embedding_config.dimensions)
    embed._save_to_cache(
        cache_dir, key, embedding_config.model, embedding_config.dimensions, [0.2] * 1536
    )

    cache_file = embed._cache_path(cache_dir, key)
    contents = cache_file.read_text(encoding="utf-8")
    assert "sk-should-never-appear-in-any-cache-file" not in contents


# --- FakeEmbedder-driven batching / cache-hit behavior -------------------


def test_repeated_embed_texts_call_reuses_cache_and_does_not_recall_api(
    embedding_config, cache_dir
):
    stats = EmbedStats()
    embedder = FakeEmbedder(embedding_config, cache_dir, stats=stats)

    first = embedder.embed_texts(["alpha text", "beta text"])
    assert stats.api_calls == 1
    assert stats.cache_misses == 2
    assert stats.cache_hits == 0

    second = embedder.embed_texts(["alpha text", "beta text"])
    assert stats.api_calls == 1, "second call with identical texts must not call the API again"
    assert stats.cache_hits == 2
    assert first == second


def test_changed_text_is_a_fresh_cache_miss_not_a_stale_hit(embedding_config, cache_dir):
    stats = EmbedStats()
    embedder = FakeEmbedder(embedding_config, cache_dir, stats=stats)

    original = embedder.embed_texts(["the original wording"])[0]
    edited = embedder.embed_texts(["the edited wording"])[0]

    assert stats.api_calls == 2, "different text must trigger a new API call, not reuse the cache"
    assert original != edited, (
        "changed content must not silently reuse the old text's embedding"
    )


def test_batching_does_not_change_which_texts_get_which_embedding(embedding_config, cache_dir):
    # Embed one at a time vs. all together; each individual text must map
    # to the same embedding regardless of batch grouping (batching is a
    # throughput choice, not a correctness one).
    stats_batched = EmbedStats()
    batched_embedder = FakeEmbedder(embedding_config, cache_dir, stats=stats_batched)
    texts = [f"chunk number {i}" for i in range(5)]
    batched = batched_embedder.embed_texts(texts)

    other_cache_dir = cache_dir.parent / "embeddings-cache-individual"
    stats_individual = EmbedStats()
    individual_embedder = FakeEmbedder(embedding_config, other_cache_dir, stats=stats_individual)
    individual = [individual_embedder.embed_texts([t])[0] for t in texts]

    assert batched == individual


# --- idempotent load against a real Postgres (skipped if unreachable) ---


def _database_uri_or_skip() -> str:
    import os

    database_uri = os.environ.get("DATABASE_URI")
    if not database_uri:
        pytest.skip("DATABASE_URI not set -- skipping live-database idempotency test")
    try:
        import psycopg

        with psycopg.connect(database_uri, connect_timeout=2):
            pass
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Postgres not reachable at DATABASE_URI: {exc}")
    return database_uri


@pytest.fixture()
def live_db_connection():
    import psycopg

    database_uri = _database_uri_or_skip()
    connection = psycopg.connect(database_uri)
    # stash the real DSN -- psycopg's .info.dsn redacts the password
    connection.database_uri = database_uri
    yield connection
    connection.close()


TEST_TENANT_ID = "tenant-synthetic-embed-test-fixture"


@pytest.fixture(autouse=False)
def clean_test_tenant_rows(live_db_connection):
    with live_db_connection.cursor() as cursor:
        cursor.execute(
            "delete from retrieval.corpus_chunk where tenant_id = %(tenant_id)s",
            {"tenant_id": TEST_TENANT_ID},
        )
    live_db_connection.commit()
    yield
    with live_db_connection.cursor() as cursor:
        cursor.execute(
            "delete from retrieval.corpus_chunk where tenant_id = %(tenant_id)s",
            {"tenant_id": TEST_TENANT_ID},
        )
    live_db_connection.commit()


def test_load_corpus_is_idempotent_against_real_postgres(
    embedding_config, cache_dir, live_db_connection, clean_test_tenant_rows
):
    db_config = embed.DbConfig(database_uri=live_db_connection.database_uri)

    from chunker import ChunkingConfig

    chunking_config = ChunkingConfig(max_tokens=512, min_tokens=64, overlap_tokens=0)

    def run_once():
        stats = EmbedStats()
        embedder = FakeEmbedder(embedding_config, cache_dir, stats=stats)
        return embed.load_corpus(
            tenant_id=TEST_TENANT_ID,
            chunking_config=chunking_config,
            embedding_config=embedding_config,
            cache_dir=cache_dir,
            db_config=db_config,
            embedder=embedder,
        )

    first_stats = run_once()
    assert first_stats.rows_upserted > 0
    assert first_stats.chunks_skipped_unchanged == 0

    with live_db_connection.cursor() as cursor:
        cursor.execute(
            "select count(*) from retrieval.corpus_chunk where tenant_id = %(tenant_id)s",
            {"tenant_id": TEST_TENANT_ID},
        )
        count_after_first = cursor.fetchone()[0]

    second_stats = run_once()

    with live_db_connection.cursor() as cursor:
        cursor.execute(
            "select count(*) from retrieval.corpus_chunk where tenant_id = %(tenant_id)s",
            {"tenant_id": TEST_TENANT_ID},
        )
        count_after_second = cursor.fetchone()[0]

    assert count_after_second == count_after_first, (
        "an unchanged second load must not increase the chunk count"
    )
    assert second_stats.rows_upserted == 0, (
        "an unchanged second load must not re-upsert any row"
    )
    assert second_stats.chunks_skipped_unchanged == first_stats.rows_upserted
    assert second_stats.chunks_embedded == 0, (
        "an unchanged second load must not attempt to embed anything"
    )


def test_load_corpus_stores_complete_provenance_in_one_row(
    embedding_config, cache_dir, live_db_connection, clean_test_tenant_rows
):
    db_config = embed.DbConfig(database_uri=live_db_connection.database_uri)
    from chunker import ChunkingConfig

    chunking_config = ChunkingConfig(max_tokens=512, min_tokens=64, overlap_tokens=0)
    stats = EmbedStats()
    embedder = FakeEmbedder(embedding_config, cache_dir, stats=stats)
    embed.load_corpus(
        tenant_id=TEST_TENANT_ID,
        chunking_config=chunking_config,
        embedding_config=embedding_config,
        cache_dir=cache_dir,
        db_config=db_config,
        embedder=embedder,
    )

    with live_db_connection.cursor() as cursor:
        cursor.execute(
            """
            select tenant_id, chunk_id, source, section_id, chunk_offset,
                   chunk_text, content_hash, search_vector is not null,
                   embedding is not null, vector_dims(embedding)
            from retrieval.corpus_chunk
            where tenant_id = %(tenant_id)s
            order by chunk_id
            limit 1
            """,
            {"tenant_id": TEST_TENANT_ID},
        )
        row = cursor.fetchone()

    assert row is not None
    (
        tenant_id,
        chunk_id,
        source,
        section_id,
        chunk_offset,
        chunk_text,
        stored_hash,
        has_search_vector,
        has_embedding,
        embedding_dims,
    ) = row
    assert tenant_id == TEST_TENANT_ID
    assert chunk_id
    assert source.startswith("data/corpus/")
    assert section_id
    assert chunk_offset is not None
    assert chunk_text
    assert stored_hash
    assert has_search_vector
    assert has_embedding
    assert embedding_dims == 1536


def test_section_identifiers_preserved_exactly_end_to_end(
    embedding_config, cache_dir, live_db_connection, clean_test_tenant_rows
):
    db_config = embed.DbConfig(database_uri=live_db_connection.database_uri)
    from chunker import ChunkingConfig, chunk_corpus

    chunking_config = ChunkingConfig(max_tokens=512, min_tokens=64, overlap_tokens=0)
    source_chunks = chunk_corpus(config=chunking_config)
    source_section_ids = {c.section_id for c in source_chunks}

    stats = EmbedStats()
    embedder = FakeEmbedder(embedding_config, cache_dir, stats=stats)
    embed.load_corpus(
        tenant_id=TEST_TENANT_ID,
        chunking_config=chunking_config,
        embedding_config=embedding_config,
        cache_dir=cache_dir,
        db_config=db_config,
        embedder=embedder,
    )

    with live_db_connection.cursor() as cursor:
        cursor.execute(
            "select distinct section_id from retrieval.corpus_chunk "
            "where tenant_id = %(tenant_id)s",
            {"tenant_id": TEST_TENANT_ID},
        )
        stored_section_ids = {row[0] for row in cursor.fetchall()}

    assert stored_section_ids == source_section_ids, (
        "section identifiers must be preserved exactly between chunker "
        "output and the stored rows -- no normalization, truncation, or "
        "reformatting"
    )
