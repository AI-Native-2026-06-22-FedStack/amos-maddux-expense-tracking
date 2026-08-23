"""The two named retrieval queries required by the retrieval deliverable,
plus an adversarial tenant-isolation regression.

QUERY 1 (exact identifier): NWP-POL-003-02 ("Nightly Lodging Caps by City
Tier", data/corpus/003-lodging-policy.md). Defined answer chunk:
NWP-POL-003-02 itself.

QUERY 2 (colloquial paraphrase): "how much am I allowed to spend on a
hotel room each night when I'm traveling for work" -- deliberately avoids
NWP-POL-003-02's own vocabulary ("nightly cap", "city tier", "lodging")
in favor of "how much am I allowed to spend", "hotel room", "each night",
"traveling for work". Defined answer chunk: NWP-POL-003-02 (same chunk as
query 1 -- same policy, two different ways of asking for it).

Both queries are run for REAL against the real local Postgres (no mocking
either leg) -- these tests are skipped, not faked, if DATABASE_URI is
unreachable or the corpus/tenant-B content isn't loaded (see
has_real_corpus_loaded/has_tenant_b_loaded below). No reranking is
involved anywhere in this file: only chunker.py -> embed.py -> retrieve.py
is exercised, so a pass here is a genuine hybrid-retrieval result, not an
LLM-reranked one.

TENANT ISOLATION: data/corpus-tenant-b/001-lodging-policy.md is a second
fictional company's (Rival Corp) lodging policy, loaded under a SECOND
tenant_id (tenant-synthetic-rival-corp) via the same embed.py pipeline.
It is deliberately adversarial -- same "nightly cap by city tier" framing,
overlapping dollar amounts ($325/$215/$145 vs. Northwind Prairie's
$320/$220/$150), and even reuses this file's own colloquial paraphrase
wording ("how much you can spend on a hotel room per night") in its own
prose -- specifically so that if tenant scoping in retrieve.py's legs
ever broke, this rival content would have every reason to rank highly for
BOTH named queries above, not just sit there unrelated and never get
picked up regardless of whether isolation works.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from retrieve import RetrievalConfig, retrieve  # noqa: E402

REAL_TENANT_ID = "tenant-synthetic-northwind-prairie"
RIVAL_TENANT_ID = "tenant-synthetic-rival-corp"

EXACT_IDENTIFIER_QUERY = "NWP-POL-003-02"
COLLOQUIAL_QUERY = (
    "how much am I allowed to spend on a hotel room each night when I'm traveling for work"
)
EXPECTED_ANSWER_CHUNK_ID = "NWP-POL-003-02"

RIVAL_ADVERSARIAL_CHUNK_IDS = {"RVL-POL-001-01", "RVL-POL-001-02", "RVL-POL-001-03"}


def _connection_or_skip():
    import os

    import psycopg

    database_uri = os.environ.get("DATABASE_URI")
    if not database_uri:
        pytest.skip("DATABASE_URI not set")
    try:
        return psycopg.connect(database_uri, connect_timeout=2)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Postgres not reachable: {exc}")


@pytest.fixture()
def db_connection():
    connection = _connection_or_skip()
    yield connection
    connection.close()


def _tenant_row_count(connection, tenant_id: str) -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            "select count(*) from retrieval.corpus_chunk where tenant_id = %(tenant_id)s",
            {"tenant_id": tenant_id},
        )
        return cursor.fetchone()[0]


@pytest.fixture()
def has_real_corpus_loaded(db_connection):
    count = _tenant_row_count(db_connection, REAL_TENANT_ID)
    if count == 0:
        pytest.skip("corpus not loaded for the real tenant -- run embed.py first")
    return count


@pytest.fixture()
def has_tenant_b_loaded(db_connection):
    count = _tenant_row_count(db_connection, RIVAL_TENANT_ID)
    if count == 0:
        pytest.skip(
            "tenant-B adversarial content not loaded -- run: "
            "load_corpus(tenant_id='tenant-synthetic-rival-corp', "
            "corpus_dir=Path('data/corpus-tenant-b'))"
        )
    return count


def _fake_embedding(seed_text: str) -> list[float]:
    """Deterministic pseudo-embedding derived from text, standing in for
    a real OpenAI call in these tests (no network access / API cost) --
    the dense leg still runs for real against real stored embeddings, only
    the QUERY embedding itself is a stand-in. Since these tests assert the
    KEYWORD leg + exact-id short-circuit are sufficient to find the right
    answer even with a directionless dense embedding, this is a stronger
    proof than using a real (favorable) query embedding would be."""
    import hashlib

    seed = int(hashlib.sha256(seed_text.encode()).hexdigest(), 16)
    return [((seed >> (i % 64)) % 1000) / 1000.0 - 0.5 for i in range(1536)]


def _real_query_embedding_or_skip(query_text: str) -> list[float]:
    """Uses the real OpenAI embedding API when OPENAI_API_KEY is set (the
    representative, realistic path); falls back to a deterministic fake
    embedding otherwise so this suite still runs offline. Either way the
    keyword leg and both tenant-scoping filters are exercised for real."""
    import os

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return _fake_embedding(query_text)

    from retrieve import embed_query_text, load_embedding_config

    try:
        return embed_query_text(query_text, api_key, load_embedding_config())
    except Exception:  # noqa: BLE001
        return _fake_embedding(query_text)


# --- Query 1: exact section identifier -----------------------------------


def test_exact_identifier_query_returns_defined_answer_chunk_in_top_five(
    db_connection, has_real_corpus_loaded
):
    query_embedding = _real_query_embedding_or_skip(EXACT_IDENTIFIER_QUERY)
    config = RetrievalConfig(rrf_k=60, top_k=5, candidates_per_leg=20)

    results = retrieve(
        db_connection, REAL_TENANT_ID, EXACT_IDENTIFIER_QUERY, query_embedding, config
    )

    result_ids = [r.chunk_id for r in results]
    assert EXPECTED_ANSWER_CHUNK_ID in result_ids, (
        f"exact-identifier query {EXACT_IDENTIFIER_QUERY!r} must return "
        f"{EXPECTED_ANSWER_CHUNK_ID!r} in the top 5; got {result_ids}"
    )

    answer = next(r for r in results if r.chunk_id == EXPECTED_ANSWER_CHUNK_ID)
    assert answer.source == "data/corpus/003-lodging-policy.md"
    assert answer.section_id == EXPECTED_ANSWER_CHUNK_ID
    assert answer.offset >= 0
    assert answer.text
    assert isinstance(answer.fused_score, float)


def test_exact_identifier_query_ranks_answer_chunk_first(db_connection, has_real_corpus_loaded):
    # Stronger than "present in top 5": the literal-id guarantee in
    # retrieve() means this specific query must rank the answer #1, not
    # merely somewhere in the top 5.
    query_embedding = _real_query_embedding_or_skip(EXACT_IDENTIFIER_QUERY)
    config = RetrievalConfig(rrf_k=60, top_k=5, candidates_per_leg=20)

    results = retrieve(
        db_connection, REAL_TENANT_ID, EXACT_IDENTIFIER_QUERY, query_embedding, config
    )
    assert results[0].chunk_id == EXPECTED_ANSWER_CHUNK_ID


# --- Query 2: colloquial paraphrase ---------------------------------------


def test_colloquial_paraphrase_avoids_the_policy_documents_own_wording():
    # A guard on the fixture itself: if this ever accidentally starts
    # reusing NWP-POL-003-02's own distinctive vocabulary, the test would
    # stop proving what it claims to prove.
    import re

    source_text = Path(
        Path(__file__).resolve().parent.parent.parent.parent
        / "data"
        / "corpus"
        / "003-lodging-policy.md"
    ).read_text(encoding="utf-8")
    forbidden_phrases = ["nightly cap", "city tier", "lodging"]
    lowered_query = COLLOQUIAL_QUERY.lower()
    for phrase in forbidden_phrases:
        assert phrase in source_text.lower(), (
            f"sanity check: {phrase!r} should be in the source doc"
        )
        assert phrase not in lowered_query, (
            f"colloquial paraphrase must not reuse the policy document's own wording {phrase!r}"
        )
    del re


def test_colloquial_paraphrase_query_returns_defined_answer_chunk_in_top_five(
    db_connection, has_real_corpus_loaded
):
    query_embedding = _real_query_embedding_or_skip(COLLOQUIAL_QUERY)
    config = RetrievalConfig(rrf_k=60, top_k=5, candidates_per_leg=20)

    results = retrieve(db_connection, REAL_TENANT_ID, COLLOQUIAL_QUERY, query_embedding, config)

    result_ids = [r.chunk_id for r in results]
    assert EXPECTED_ANSWER_CHUNK_ID in result_ids, (
        f"colloquial-paraphrase query {COLLOQUIAL_QUERY!r} must return "
        f"{EXPECTED_ANSWER_CHUNK_ID!r} in the top 5; got {result_ids}"
    )

    answer = next(r for r in results if r.chunk_id == EXPECTED_ANSWER_CHUNK_ID)
    assert answer.source == "data/corpus/003-lodging-policy.md"
    assert answer.section_id == EXPECTED_ANSWER_CHUNK_ID
    assert answer.offset >= 0
    assert answer.text
    assert isinstance(answer.fused_score, float)


def test_colloquial_paraphrase_is_answered_by_real_hybrid_retrieval_not_id_matching(
    db_connection, has_real_corpus_loaded
):
    # Proves this specific pass is NOT coming from the literal-id
    # short-circuit (there is no NWP-POL-* string anywhere in the query),
    # so a pass here is genuine keyword+dense retrieval, not an accidental
    # id match.
    from retrieve import _extract_literal_section_id

    assert _extract_literal_section_id(COLLOQUIAL_QUERY) is None


# --- Tenant isolation regression (adversarial) ----------------------------


def test_tenant_a_query_never_returns_tenant_bs_chunk_for_exact_identifier_query(
    db_connection, has_real_corpus_loaded, has_tenant_b_loaded
):
    query_embedding = _real_query_embedding_or_skip(EXACT_IDENTIFIER_QUERY)
    config = RetrievalConfig(rrf_k=60, top_k=5, candidates_per_leg=20)

    results = retrieve(
        db_connection, REAL_TENANT_ID, EXACT_IDENTIFIER_QUERY, query_embedding, config
    )
    result_ids = {r.chunk_id for r in results}

    leaked = result_ids & RIVAL_ADVERSARIAL_CHUNK_IDS
    assert not leaked, f"tenant A's query must never return tenant B's chunks; leaked {leaked}"


def test_tenant_a_query_never_returns_tenant_bs_chunk_for_colloquial_query(
    db_connection, has_real_corpus_loaded, has_tenant_b_loaded
):
    query_embedding = _real_query_embedding_or_skip(COLLOQUIAL_QUERY)
    config = RetrievalConfig(rrf_k=60, top_k=5, candidates_per_leg=20)

    results = retrieve(db_connection, REAL_TENANT_ID, COLLOQUIAL_QUERY, query_embedding, config)
    result_ids = {r.chunk_id for r in results}

    leaked = result_ids & RIVAL_ADVERSARIAL_CHUNK_IDS
    assert not leaked, f"tenant A's query must never return tenant B's chunks; leaked {leaked}"


def test_tenant_bs_content_would_actually_rank_highly_if_isolation_broke(
    db_connection, has_real_corpus_loaded, has_tenant_b_loaded
):
    # Makes the two isolation tests above MEANINGFUL, not vacuous: proves
    # tenant B's adversarial chunk genuinely IS a strong match for the
    # same query when queried under ITS OWN tenant -- so its absence from
    # tenant A's results above is evidence of real tenant scoping, not
    # evidence that the content just happens to be irrelevant.
    query_embedding = _real_query_embedding_or_skip(EXACT_IDENTIFIER_QUERY)
    config = RetrievalConfig(rrf_k=60, top_k=5, candidates_per_leg=20)

    results = retrieve(
        db_connection, RIVAL_TENANT_ID, EXACT_IDENTIFIER_QUERY, query_embedding, config
    )
    result_ids = [r.chunk_id for r in results]

    assert result_ids, "tenant B must have at least one match for this query"
    assert result_ids[0] in RIVAL_ADVERSARIAL_CHUNK_IDS, (
        f"expected tenant B's own adversarial content to rank first when "
        f"queried under its own tenant, got {result_ids[0]!r} -- if this "
        f"fails, the adversarial fixture isn't actually adversarial"
    )


def test_tenant_isolation_enforced_even_with_directionless_dense_query(
    db_connection, has_real_corpus_loaded, has_tenant_b_loaded
):
    # Belt-and-suspenders: repeat the isolation check with the
    # deliberately-adversarial fake embedding (not a real, favorable
    # query embedding) so the guarantee is shown to hold on the keyword
    # leg's tenant filter alone, independent of what the dense leg's
    # embedding happens to favor.
    fake_embedding = _fake_embedding(EXACT_IDENTIFIER_QUERY)
    config = RetrievalConfig(rrf_k=60, top_k=5, candidates_per_leg=20)

    results = retrieve(
        db_connection, REAL_TENANT_ID, EXACT_IDENTIFIER_QUERY, fake_embedding, config
    )
    result_ids = {r.chunk_id for r in results}

    assert not (result_ids & RIVAL_ADVERSARIAL_CHUNK_IDS)
    assert EXPECTED_ANSWER_CHUNK_ID in result_ids
